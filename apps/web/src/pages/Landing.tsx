import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtPct, fmtSol, type Vault } from "@trader-vaults/shared";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/hooks";
import { CountStat, Sparkline, TypePill } from "../components/bits";
import { AnimatedCard, AnimatedCounter } from "../components/AnimatedComponents";

export function Landing() {
  usePageTitle("");
  const [vaults, setVaults] = useState<Vault[] | null>(null);

  useEffect(() => {
    // the public pitch shows real vaults only — paper stays in its sandbox
    api.vaults({ mode: "real" }).then(setVaults).catch(() => setVaults([]));
  }, []);

  const tvl = vaults?.reduce((s, v) => s + v.tvlSol, 0) ?? 0;
  const depositors = vaults?.reduce((s, v) => s + v.stats.depositorCount, 0) ?? 0;
  const best = vaults ? [...vaults].sort((a, b) => b.stats.pnlPct30d - a.stats.pnlPct30d) : [];
  const tickerItems = best.length > 0 ? [...best, ...best] : [];

  return (
    <div className="landing">
      <div className="landing-inner">
        <nav className="lnav">
          <span className="brand" style={{ padding: 0 }}>
            <span className="mark">V</span>
            <span className="word">trader vaults</span>
          </span>
          <div style={{ display: "flex", gap: 10 }}>
            <Link to="/explore" className="btn ghost sm">Explore vaults</Link>
            <Link to="/explore" className="btn primary sm">Launch app</Link>
          </div>
        </nav>

        <header className="hero">
          <div className="eyebrow">Trader vaults on Solana — est. block 0</div>
          <h1>
            Back the best traders.
            <br />
            <span className="gr">They can never run.</span>
            <span className="cursor">&nbsp;</span>
          </h1>
          <p className="sub">
            Deposit into any vault — the trader trades the pool through a locked program that has
            no withdrawal path for them. Profits split automatically: 70% to depositors, 30% to the
            trader — and a third of the trader's cut is escrowed for 60 days. The platform takes no
            cut. Every record public, recomputed from chain data.
          </p>
          <div className="ctas">
            <Link to="/explore" className="btn primary big">Start investing</Link>
            <Link to="/create" className="btn big">Open a vault — 0 SOL needed</Link>
          </div>
          <div className="lstats">
            <CountStat k="Value locked" value={tvl} fmt={(n) => `${fmtSol(n, 0)} ◎`} />
            <CountStat k="Vaults live" value={vaults?.length ?? 0} fmt={(n) => String(Math.round(n))} />
            <CountStat k="Depositors" value={depositors} fmt={(n) => String(Math.round(n))} />
            <CountStat
              k="Best 30d"
              value={best[0]?.stats.pnlPct30d ?? 0}
              fmt={(n) => fmtPct(n, 0)}
              tone="pos"
            />
          </div>
        </header>

        {tickerItems.length > 0 && (
          <div className="tickerwrap" aria-hidden="true">
            <div className="ticker">
              {tickerItems.map((v, i) => (
                <span key={`${v.id}-${i}`} className="titem">
                  <span style={{ color: "var(--text)" }}>{v.name}</span>
                  <span className={v.stats.pnlPct30d >= 0 ? "pos" : "neg"}>
                    {fmtPct(v.stats.pnlPct30d, 1)}
                  </span>
                  <span>{fmtSol(v.tvlSol, 0)}◎</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <section className="lsect">
          <h2>How it works</h2>
          <p className="lead">Three moves. Custody never leaves the program.</p>
          <div className="steps">
            <div className="step">
              <span className="n">01 · deposit</span>
              <h3>Buy a share of a vault</h3>
              <p>
                Sign up with email — an embedded Solana wallet is created for you, key exportable
                any time. Deposit SOL into any vault and receive shares at the current per-share
                value. Withdraw whenever the buffer covers it, or through a short request window.
              </p>
            </div>
            <div className="step">
              <span className="n">02 · they trade</span>
              <h3>The trader trades. That's all they can do.</h3>
              <p>
                Funds live in a program-owned vault. The trader's only power is a validated swap
                instruction — pinned to Jupiter, vault-owned accounts only, risk caps enforced
                on-chain. There is no code path that lets them withdraw a single lamport.
              </p>
            </div>
            <div className="step">
              <span className="n">03 · split profits</span>
              <h3>70 / 30, automatically</h3>
              <p>
                Profit above your personal high-water mark splits on exit: 70% stays yours, 30%
                pays the trader. Two thirds of the trader's fee lands immediately; the last third
                sits in escrow for 60 days, so a trader who blows up or disappears can't take
                their whole fee and go. Every vault's record is public, recomputed from chain data.
              </p>
            </div>
          </div>
        </section>

        <section className="lsect">
          <h2>Live vaults</h2>
          <p className="lead">Real track records — wins, losses, and drawdowns included.</p>
          {best.length === 0 && (
            <div className="empty">
              Nothing listed yet — every vault here earns its numbers from real activity.
              Be first: open the app and create one.
            </div>
          )}
          <div className="vaultgrid">
            {best.slice(0, 3).map((v, index) => (
              <AnimatedCard key={v.id} hover={true} glow={true} delay={index * 100}>
                <div className="head">
                  <div>
                    <div className="name">{v.name}</div>
                    <div className="trader">
                      <span className="mono">@{v.trader.handle}</span>
                    </div>
                  </div>
                  <TypePill type={v.type} />
                </div>
                <div className="metric-row">
                  <div>
                    <div className={`bignum ${v.stats.pnlPct30d >= 0 ? "pos" : "neg"}`}>
                      <AnimatedCounter
                        value={v.stats.pnlPct30d}
                        formatFn={(n) => fmtPct(n, 1)}
                        duration={1000}
                      />
                    </div>
                    <div className="dimtx mono" style={{ fontSize: 11 }}>30d return</div>
                  </div>
                  <Sparkline points={v.equityCurve.slice(-60)} />
                </div>
                <div className="footrow">
                  <span>{fmtSol(v.tvlSol, 0)} SOL tvl</span>
                  <span>{v.stats.depositorCount} depositors</span>
                  <span>mgr {v.managerStakePct.toFixed(0)}%</span>
                </div>
              </AnimatedCard>
            ))}
          </div>
        </section>

        <footer className="lfoot">
          <span>
            Trader Vaults · trader vaults on Solana
          </span>
          <span>Custody enforced by program. Trading losses are still losses — read every vault's drawdown.</span>
        </footer>
      </div>
    </div>
  );
}
