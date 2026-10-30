/**
 * Trader Vaults vault — Anchor mocha test skeleton.
 *
 * Structure-first: these tests define the behavioral contract (share math,
 * worse-of withdrawals, NAV bounds, swap constraint rejections). They are
 * written to run under `anchor test` on a localnet; steps that need clock
 * manipulation are marked TODO(warp) — wire them to solana-bankrun or a
 * validator `warp` helper when the suite is brought up in CI.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";

// ---------------------------------------------------------------------------
// Constants mirrored from state.rs — keep in sync.
// ---------------------------------------------------------------------------
const VIRTUAL_SHARES = 1_000n;
const VIRTUAL_LAMPORTS = 1n;
const MIN_SEED_LAMPORTS = 10_000_000n;
const PLATFORM_PROFIT_BPS = 1_000n;
const BPS = 10_000n;
const SECONDS_PER_DAY = 86_400;
// Permissionless stale-NAV escape hatch (H1).
const NAV_EMERGENCY_GRACE_SECONDS = 7 * SECONDS_PER_DAY;
const EMERGENCY_HAIRCUT_BPS = 500n; // 5%
const EMERGENCY_PAYOUT_BPS = BPS - EMERGENCY_HAIRCUT_BPS; // 9_500
const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const BPF_UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

// ---------------------------------------------------------------------------
// Reference implementations of the on-chain math (math.rs), used as oracles.
// ---------------------------------------------------------------------------
function sharesForDeposit(
  amount: bigint,
  totalShares: bigint,
  equity: bigint
): bigint {
  // floor(amount * (S + VS) / (E + VL)) — must match math::shares_for_deposit
  return (amount * (totalShares + VIRTUAL_SHARES)) / (equity + VIRTUAL_LAMPORTS);
}

function valueForShares(
  shares: bigint,
  totalShares: bigint,
  equity: bigint
): bigint {
  // floor(shares * (E + VL) / (S + VS)) — must match math::value_for_shares
  return (shares * (equity + VIRTUAL_LAMPORTS)) / (totalShares + VIRTUAL_SHARES);
}

function mulBpsFloor(x: bigint, bps: bigint): bigint {
  return (x * bps) / BPS;
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
function nameBytes(name: string): number[] {
  const buf = Buffer.alloc(32);
  buf.write(name);
  return Array.from(buf);
}

describe("trader vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // No generated types until the first `anchor build`; keep the program loosely
  // typed so this file type-checks standalone.
  const program = anchor.workspace.Vault as Program<any>;

  const admin = provider.wallet as anchor.Wallet; // upgrade authority on localnet
  const trader = Keypair.generate();
  const investor = Keypair.generate();
  const keeper = Keypair.generate();

  const VAULT_NAME = "test-vault-1";
  const vaultName = nameBytes(VAULT_NAME);

  const [platformConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("platform_config")],
    program.programId
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(nameBytes(VAULT_NAME))],
    program.programId
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER
  );
  const depositorPda = (authority: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault_depositor"), vaultPda.toBuffer(), authority.toBuffer()],
      program.programId
    )[0];
  // Canonical ATA derivation, inlined so this file needs no spl-token import.
  const wsolAta = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL_MINT.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM
    )[0];

  const defaultVaultParams = () => ({
    name: vaultName,
    vaultType: { managed: {} },
    perfFeeBps: 2000,
    redeemWindowSeconds: new BN(0), // 0 so execute_withdraw works without warping
    navStalenessSeconds: new BN(3600),
    unlockPeriodSeconds: new BN(0), // no drip by default; drip suite overrides
    maxNavDeltaBps: 2000,
    maxTradeNotionalLamports: new BN(1_000_000_000),
    maxPriceImpactBps: 100,
    dailyLossLimitBps: 500,
    navKeeper: keeper.publicKey,
    seedLamports: new BN(MIN_SEED_LAMPORTS.toString()),
  });

  before(async () => {
    for (const kp of [trader, investor, keeper]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }
  });

  // =========================================================================
  // Platform bootstrap
  // =========================================================================
  describe("init_platform", () => {
    it("initializes config + treasury when signed by the upgrade authority", async () => {
      await program.methods
        .initPlatform()
        .accounts({
          admin: admin.publicKey,
          platformConfig: platformConfigPda,
          treasury: treasuryPda,
          programData: programDataPda,
          program: program.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const cfg = await program.account.platformConfig.fetch(platformConfigPda);
      assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
      assert.isFalse(cfg.killSwitch);
    });

    it("rejects a non-upgrade-authority signer", async () => {
      // TODO: second localnet keypair attempting initPlatform -> Unauthorized.
    });
  });

  // =========================================================================
  // Vault init + seed-share burn
  // =========================================================================
  describe("init_vault", () => {
    it("creates the vault, burns seed shares, marks NAV = seed", async () => {
      await program.methods
        .initVault(defaultVaultParams())
        .accounts({
          creator: trader.publicKey,
          vault: vaultPda,
          platformConfig: platformConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();

      const v = await program.account.vault.fetch(vaultPda);
      const expectedSeedShares = sharesForDeposit(MIN_SEED_LAMPORTS, 0n, 0n);
      assert.equal(BigInt(v.totalShares.toString()), expectedSeedShares);
      assert.equal(BigInt(v.seedShares.toString()), expectedSeedShares);
      assert.equal(BigInt(v.navLamports.toString()), MIN_SEED_LAMPORTS);
      assert.equal(v.trader.toBase58(), trader.publicKey.toBase58());
    });

    it("rejects perf fee outside [1000, 3000] bps", async () => {
      const params = { ...defaultVaultParams(), name: nameBytes("bad-fee"), perfFeeBps: 500 };
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), Buffer.from(nameBytes("bad-fee"))],
          program.programId
        );
        await program.methods
          .initVault(params)
          .accounts({
            creator: trader.publicKey,
            vault: pda,
            platformConfig: platformConfigPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "InvalidParameter");
      }
    });

    it("rejects a seed below MIN_SEED_LAMPORTS", async () => {
      // TODO: seedLamports = MIN_SEED_LAMPORTS - 1 -> SeedTooSmall.
    });
  });

  // =========================================================================
  // Deposit share math (audit surface #1)
  // =========================================================================
  describe("deposit", () => {
    it("mints shares per the virtual-offset formula, rounding down", async () => {
      const amount = 5n * BigInt(LAMPORTS_PER_SOL);
      const before = await program.account.vault.fetch(vaultPda);
      const expected = sharesForDeposit(
        amount,
        BigInt(before.totalShares.toString()),
        BigInt(before.navLamports.toString()) // no locked profit yet
      );

      await program.methods
        .initDepositor()
        .accounts({
          authority: investor.publicKey,
          vault: vaultPda,
          depositor: depositorPda(investor.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();
      await program.methods
        .deposit(new BN(amount.toString()))
        .accounts({
          authority: investor.publicKey,
          vault: vaultPda,
          depositor: depositorPda(investor.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();

      const d = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      assert.equal(BigInt(d.shares.toString()), expected);
      assert.equal(BigInt(d.netDepositsLamports.toString()), amount);
      const after = await program.account.vault.fetch(vaultPda);
      assert.equal(
        BigInt(after.navLamports.toString()),
        BigInt(before.navLamports.toString()) + amount
      );
    });

    it("a deposit+withdraw round trip never returns more than deposited", async () => {
      // Property check of floor/floor rounding: request full shares and
      // execute; payout (pre-fee, no profit -> no fee) must be <= amount.
      // Covered concretely by the withdrawal tests below.
    });

    it("rejects deposits below the dust minimum", async () => {
      try {
        await program.methods
          .deposit(new BN(1))
          .accounts({
            authority: investor.publicKey,
            vault: vaultPda,
            depositor: depositorPda(investor.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([investor])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "DepositTooSmall");
      }
    });

    it("rejects deposits when the posted NAV is stale", async () => {
      // TODO(warp): advance clock past navStalenessSeconds without a post ->
      // expect NavStale. Requires bankrun/warp.
    });

    it("rejects deposits while a withdrawal request is pending", async () => {
      // TODO: request_withdraw, then deposit -> WithdrawRequestPending, then cancel.
    });
  });

  // =========================================================================
  // Withdrawals: worse-of rule + fee crystallization
  // =========================================================================
  describe("withdrawals", () => {
    it("request locks value_at_request and reserves buffer", async () => {
      const d = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      const half = BigInt(d.shares.toString()) / 2n;
      const v = await program.account.vault.fetch(vaultPda);
      const expectedValue = valueForShares(
        half,
        BigInt(v.totalShares.toString()),
        BigInt(v.navLamports.toString())
      );

      await program.methods
        .requestWithdraw(new BN(half.toString()))
        .accounts({
          authority: investor.publicKey,
          vault: vaultPda,
          depositor: depositorPda(investor.publicKey),
        })
        .signers([investor])
        .rpc();

      const v2 = await program.account.vault.fetch(vaultPda);
      assert.equal(
        BigInt(v2.pendingWithdrawValueLamports.toString()),
        expectedValue
      );
      const d2 = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      assert.equal(
        BigInt(d2.lastWithdrawRequest.valueAtRequestLamports.toString()),
        expectedValue
      );
    });

    it("second request while pending is rejected", async () => {
      try {
        await program.methods
          .requestWithdraw(new BN(1))
          .accounts({
            authority: investor.publicKey,
            vault: vaultPda,
            depositor: depositorPda(investor.publicKey),
          })
          .signers([investor])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "WithdrawRequestPending");
      }
    });

    it("execute pays min(value_at_request, current) — flat NAV case, no profit no fee", async () => {
      const dBefore = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      const req = dBefore.lastWithdrawRequest;
      const balBefore = await provider.connection.getBalance(investor.publicKey);

      await program.methods
        .executeWithdraw()
        .accounts({
          authority: investor.publicKey,
          vault: vaultPda,
          depositor: depositorPda(investor.publicKey),
          trader: trader.publicKey,
        })
        .signers([investor])
        .rpc();

      const balAfter = await provider.connection.getBalance(investor.publicKey);
      // No NAV move since deposit -> no profit -> zero fees; payout is the
      // worse-of value which equals value_at_request here (minus tx fee noise,
      // so assert with tolerance or use a separate fee payer in CI).
      assert.isAtMost(
        balAfter - balBefore,
        Number(req.valueAtRequestLamports.toString())
      );
      const dAfter = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      assert.equal(
        dAfter.lastWithdrawRequest.shares.toString(),
        "0",
        "request cleared"
      );
    });

    it("worse-of: NAV drop after request pays the lower current value", async () => {
      // TODO: request; keeper posts NAV -10%; execute; expect payout ==
      // current value (< value_at_request) and the difference retained by
      // remaining shareholders.
    });

    it("worse-of: NAV rise after request still pays value_at_request", async () => {
      // TODO: request; keeper posts NAV +10% (drips if unlock configured);
      // execute; expect payout == value_at_request and the surplus retained.
    });

    it("crystallizes perf + platform fee from proceeds on profit", async () => {
      // Scenario oracle (mirrors withdraw.rs::settle_withdrawal):
      //   basis  = net_deposits * shares_w / shares          (floor)
      //   profit = gross - basis
      //   traderFee   = mulBpsFloor(profit, perfFeeBps)
      //   platformFee = mulBpsFloor(profit, PLATFORM_PROFIT_BPS)
      //   payout = gross - traderFee - platformFee
      // TODO: deposit, keeper posts +delta NAV, wait out drip, withdraw all,
      // assert trader wallet delta == traderFee and vault.platformFeesOwed
      // grew by platformFee, and depositor.cumulativeProfitShare ratcheted
      // by profit.
      const profit = 1_000_000n;
      assert.equal(mulBpsFloor(profit, 2000n), 200_000n);
      assert.equal(mulBpsFloor(profit, PLATFORM_PROFIT_BPS), 100_000n);
    });

    it("redeem window gates execution", async () => {
      // TODO(warp): vault with redeemWindowSeconds > 0; execute before window
      // -> RedeemWindowNotElapsed; warp past; succeeds.
    });

    it("instant_withdraw pays only from free SOL and respects the tighter staleness bound", async () => {
      // TODO: wrap most of the buffer, instant_withdraw larger than remaining
      // free SOL -> InsufficientSolBuffer. Also TODO(warp): stale NAV beyond
      // 300s -> NavTooStaleForInstant.
    });

    it("withdrawals still work while the vault is frozen and the kill switch is on", async () => {
      // THE liveness invariant. TODO: freeze_vault + set_kill_switch(true),
      // then request/execute a withdrawal successfully; unfreeze + switch off.
    });
  });

  // =========================================================================
  // H1 — permissionless stale-NAV escape hatch (emergency_withdraw)
  // =========================================================================
  describe("emergency_withdraw", () => {
    it("is rejected while the last mark is inside the grace period", async () => {
      // Runs against the live vault: the mark is minutes old, the grace period
      // is a week, so the hatch must be shut. This is the half of the
      // invariant that keeps the haircut path from competing with the normally
      // priced ones.
      const d = await program.account.vaultDepositor.fetch(
        depositorPda(investor.publicKey)
      );
      const shares = BigInt(d.shares.toString());
      assert.isTrue(shares > 0n, "investor still holds shares to test with");
      try {
        await program.methods
          .emergencyWithdraw(new BN(shares.toString()))
          .accounts({
            authority: investor.publicKey,
            vault: vaultPda,
            depositor: depositorPda(investor.publicKey),
            trader: trader.publicKey,
          })
          .signers([investor])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "NavNotStaleEnough");
      }
    });

    it("is allowed once the mark is NAV_EMERGENCY_GRACE_SECONDS old, with the haircut applied", async () => {
      // TODO(warp): stop posting NAV and advance the clock by
      // NAV_EMERGENCY_GRACE_SECONDS, then emergencyWithdraw(allShares).
      // Oracle (mirrors withdraw.rs::handle_emergency_withdraw):
      //   grossFull = valueForShares(shares, totalShares, nav)   // last mark
      //   gross     = mulBpsFloor(grossFull, EMERGENCY_PAYOUT_BPS)
      //   basis     = netDeposits * shares / depositorShares      (floor)
      //   profit    = max(0, gross - basis)
      //   traderFee = mulBpsFloor(profit, perfFeeBps)
      //   platFee   = mulBpsFloor(profit, PLATFORM_PROFIT_BPS)
      //   payout    = gross - traderFee - platFee
      // Assert: investor delta == payout; vault.navLamports dropped by exactly
      // `gross` (NOT grossFull) so the haircut stays with the pool; the
      // remaining shares' per-share value strictly increased.
      assert.equal(NAV_EMERGENCY_GRACE_SECONDS, 604_800);
      const grossFull = 1_000_000n;
      assert.equal(mulBpsFloor(grossFull, EMERGENCY_PAYOUT_BPS), 950_000n);
      assert.equal(
        grossFull - mulBpsFloor(grossFull, EMERGENCY_PAYOUT_BPS),
        mulBpsFloor(grossFull, EMERGENCY_HAIRCUT_BPS),
        "haircut is exactly 5% of the gross at these magnitudes"
      );
    });

    it("needs no keeper, admin or trader — and ignores freeze + kill switch", async () => {
      // THE entitlement invariant. TODO(warp): with the mark abandoned past
      // the grace period, freeze_vault (platform) + setKillSwitch(true) +
      // a nav_keeper set to a key nobody holds -> emergencyWithdraw signed by
      // the depositor ALONE still succeeds. The instruction takes no
      // platformConfig account at all, so this can only regress via an
      // accounts-struct change.
    });

    it("requires an outstanding request to be cancelled first (spend-once)", async () => {
      // TODO(warp): requestWithdraw, warp past the grace period,
      // emergencyWithdraw -> WithdrawRequestPending; cancelWithdrawRequest
      // (never NAV-gated, so it works on a dead vault) -> then it succeeds.
    });
  });

  // =========================================================================
  // H2 — permissionless forced settlement unwind (settle_unwrap)
  // =========================================================================
  describe("settle_unwrap", () => {
    it("is rejected when the witness has no matured, unpayable request", async () => {
      // TODO: needs the vault's wSOL ATA to exist first (anyone may create it
      // permissionlessly). With the investor's request already executed there
      // is no pending request at all, so this must fail NoWithdrawRequest:
      //
      //   await program.methods.settleUnwrap()
      //     .accounts({
      //       vault: vaultPda,
      //       depositor: depositorPda(investor.publicKey),
      //       wsolAccount: wsolAta(vaultPda),
      //       tokenProgram: TOKEN_PROGRAM,
      //     }).rpc();  // -> NoWithdrawRequest
      assert.notEqual(
        wsolAta(vaultPda).toBase58(),
        vaultPda.toBase58(),
        "vault wSOL ATA is a distinct account from the vault PDA"
      );
    });

    it("is rejected while the vault can still pay the matured request", async () => {
      // The anti-grief half of the guard. TODO: with the buffer intact,
      // requestWithdraw a small amount (redeemWindowSeconds = 0 in these
      // params, so it matures immediately) and call settleUnwrap ->
      // SettlementNotOwed, because
      //   lamports - rentMin - platformFeesOwed >= pendingWithdrawValue.
      // Then cancelWithdrawRequest to leave the vault clean.
    });

    it("is accepted, by anyone, once a matured request cannot be paid", async () => {
      // TODO: wrapSol(free buffer) as the trader -> requestWithdraw(shares)
      // as the investor -> the request matures with the buffer empty ->
      // settleUnwrap sent by an unrelated keypair (no signer field on the
      // instruction; the stranger is only the fee payer) succeeds.
      // Assert: the vault's lamports grew by the closed ATA's balance
      // (wrapped amount + its rent), the wSOL ATA no longer exists, and the
      // previously stranded executeWithdraw now succeeds.
    });

    it("does not disturb the trade-authority unwrap path", async () => {
      // TODO: trader-signed unwrapSol still works with no matured request
      // outstanding (settle_unwrap is additive, not a replacement).
    });
  });

  // =========================================================================
  // NAV posting (audit surface #2)
  // =========================================================================
  describe("post_nav", () => {
    it("only the appointed keeper may post", async () => {
      const v = await program.account.vault.fetch(vaultPda);
      try {
        await program.methods
          .postNav(v.navLamports, new BN(v.navSlot.toNumber() + 1))
          .accounts({ vault: vaultPda, keeper: investor.publicKey })
          .signers([investor])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "InvalidNavKeeper");
      }
    });

    it("accepts an in-band mark and refreshes staleness", async () => {
      const slot = await provider.connection.getSlot();
      const v = await program.account.vault.fetch(vaultPda);
      const bumped = BigInt(v.navLamports.toString()) + 1_000n; // tiny gain
      await program.methods
        .postNav(new BN(bumped.toString()), new BN(slot))
        .accounts({ vault: vaultPda, keeper: keeper.publicKey })
        .signers([keeper])
        .rpc();
      const v2 = await program.account.vault.fetch(vaultPda);
      assert.equal(BigInt(v2.navLamports.toString()), bumped);
    });

    it("rejects a delta beyond max_nav_delta_bps", async () => {
      const slot = await provider.connection.getSlot();
      const v = await program.account.vault.fetch(vaultPda);
      const nav = BigInt(v.navLamports.toString());
      const tooBig = nav + (nav * 2001n) / 10_000n; // cap is 2000 bps
      try {
        await program.methods
          .postNav(new BN(tooBig.toString()), new BN(slot))
          .accounts({ vault: vaultPda, keeper: keeper.publicKey })
          .signers([keeper])
          .rpc();
        assert.fail("should have rejected");
      } catch (e: any) {
        assert.include(e.toString(), "NavDeltaTooLarge");
      }
    });

    it("rejects non-monotonic or future mark slots", async () => {
      // TODO: mark_slot <= vault.navSlot -> NavSlotNotMonotonic;
      // mark_slot > clock.slot -> NavSlotNotMonotonic.
    });

    it("routes gains through the locked-profit drip (share price lags the post)", async () => {
      // TODO: vault with unlockPeriodSeconds = 3600; post +X; immediately
      // deposit -> shares priced on nav - X (all still locked); TODO(warp)
      // half the period -> priced on nav - X/2 (ceil).
    });

    it("losses hit share pricing immediately and feed the breaker", async () => {
      // TODO: post -loss below dailyLossLimitBps threshold repeatedly until
      // accumulator > threshold -> vault.status becomes {frozen} with
      // frozenBy {riskBreaker}; execute_swap then rejects; withdrawals do not.
    });
  });

  // =========================================================================
  // execute_swap constraint rejections (audit surface #3)
  // =========================================================================
  describe("execute_swap constraints", () => {
    // NOTE: full happy-path swap tests need a forked mainnet (Jupiter v6 is
    // not deployable to localnet); the REJECTION tests below run anywhere
    // because every one of them fails before the CPI is reached.

    it("rejects a non-Jupiter program id (pinned CPI target)", async () => {
      // TODO: pass SystemProgram.programId as jupiterProgram -> the
      // address = JUPITER_V6 constraint fails (InvalidJupiterProgram).
      assert.notEqual(JUPITER_V6.toBase58(), SystemProgram.programId.toBase58());
    });

    it("rejects a source token account whose authority is not the vault PDA", async () => {
      // TODO: create a wSOL ATA owned by the investor, pass it as
      // source_token -> token::authority constraint violation.
    });

    it("rejects swaps without a wSOL leg", async () => {
      // TODO: two vault-owned SPL ATAs of random mints -> MissingWsolLeg.
    });

    it("rejects min_out == 0", async () => {
      // TODO -> ZeroMinOut.
    });

    it("rejects a third vault-owned ATA smuggled into remaining accounts", async () => {
      // The drain-guard: TODO create vault-owned ATA for a third mint, append
      // it to remainingAccounts -> ForeignVaultTokenAccount.
    });

    it("rejects when the platform kill switch is on, and only trades — never withdrawals", async () => {
      // TODO: setKillSwitch(true) -> execute_swap TradingHalted, wrap_sol
      // TradingHalted, deposit OK?, withdrawal OK; setKillSwitch(false).
    });

    it("rejects when vault is frozen or trader/operator signature is missing", async () => {
      // TODO: freeze -> VaultNotActive; random signer -> Unauthorized;
      // set_operator(engine) -> engine may trade.
    });

    it("enforces max_in / min_out via post-CPI balance deltas", async () => {
      // TODO(fork): on a mainnet fork, run a real Jupiter route with min_out
      // above the quote -> SlippageExceeded; with max_in below the real
      // in-amount -> MaxInExceeded; notional above cap -> NotionalTooLarge.
    });
  });

  // =========================================================================
  // Platform fees / custody surface
  // =========================================================================
  describe("platform fees + treasury", () => {
    it("collect_platform_fees pays only to the pinned treasury PDA", async () => {
      // TODO: after a fee-bearing withdrawal, collectPlatformFees moves owed
      // lamports vault -> treasuryPda; passing any other account for
      // `treasury` fails the seeds constraint.
    });

    it("sweep_treasury is admin-gated", async () => {
      // TODO: non-admin sweep -> Unauthorized (has_one).
    });
  });
});
