#!/usr/bin/env bash
# ── Post-reboot: build + deploy the vault program via WSL ───────────
# Run from Git Bash on Windows AFTER the reboot that activates
# virtualization. Installs Ubuntu, the Rust/Solana/Anchor toolchain
# inside it, builds the program and deploys it to devnet.
#
# Everything runs as root inside WSL so no interactive user setup is
# needed. Safe to re-run: each step is idempotent.
set -uo pipefail

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

say "checking virtualization"
if wsl --status 2>&1 | tr -d '\0' | grep -qi "virtualization is not enabled"; then
  die "virtualization still inactive — reboot first, then re-run this script"
fi

say "installing Ubuntu (skipped if present)"
if ! wsl -l -q 2>/dev/null | tr -d '\0' | grep -qi ubuntu; then
  wsl --install -d Ubuntu --no-launch || die "could not install Ubuntu"
fi

W="wsl -d Ubuntu -u root --"

say "installing build dependencies"
$W bash -lc 'apt-get update -qq && apt-get install -y -qq curl build-essential pkg-config libssl-dev libudev-dev >/dev/null' \
  || die "apt install failed"

say "installing Rust"
$W bash -lc 'test -x /root/.cargo/bin/cargo || curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal' \
  || die "rustup failed"

say "installing Solana CLI"
$W bash -lc 'test -x /root/.local/share/solana/install/active_release/bin/solana || sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"' \
  || die "solana install failed"

say "installing Anchor (anchor-cli 0.30.1 — pinned by Anchor.toml)"
$W bash -lc 'export PATH=/root/.cargo/bin:$PATH; command -v anchor || cargo install --git https://github.com/coral-xyz/anchor avm --locked --force' \
  || die "avm install failed"
$W bash -lc 'export PATH=/root/.cargo/bin:$PATH; avm install 0.30.1 && avm use 0.30.1' \
  || die "anchor 0.30.1 install failed"

PROJ="/mnt/c/tech/vault/programs/vault"

say "building the program"
$W bash -lc "export PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:\$PATH; cd $PROJ && cargo-build-sbf" \
  || die "build failed — read the errors above (NOTE(api) items in the source are the likely first hits)"

say "syncing the declared program id"
KEY="$PROJ/target/deploy/vault-keypair.json"
PID=$($W bash -lc "export PATH=/root/.local/share/solana/install/active_release/bin:\$PATH; solana-keygen pubkey $KEY")
echo "    program id: $PID"
$W bash -lc "cd $PROJ && grep -q '$PID' programs/vault/src/lib.rs" || {
  say "updating declare_id! to $PID and rebuilding"
  $W bash -lc "cd $PROJ && sed -i -E 's/declare_id!\(\"[^\"]+\"\)/declare_id!(\"$PID\")/' programs/vault/src/lib.rs"
  $W bash -lc "export PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:\$PATH; cd $PROJ && cargo-build-sbf" \
    || die "rebuild after id sync failed"
}

say "funding the deployer on devnet"
$W bash -lc "export PATH=/root/.local/share/solana/install/active_release/bin:\$PATH; solana config set --url devnet >/dev/null; solana airdrop 5 || true; solana balance"

say "deploying to devnet"
$W bash -lc "export PATH=/root/.local/share/solana/install/active_release/bin:\$PATH; cd $PROJ && solana program deploy --program-id $KEY --url devnet target/deploy/vault.so" \
  || die "deploy failed (usually: deployer needs more SOL — https://faucet.solana.com)"

say "DEPLOYED"
echo "    add to .env:  VAULT_PROGRAM_ID=$PID"
echo "    explorer:     https://explorer.solana.com/address/$PID?cluster=devnet"
