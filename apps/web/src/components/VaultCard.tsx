// ── Professional Animated Vault Card Component ─────────────────────────
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Vault, fmtSol, fmtPct, type TraderProfile } from '@trader-vaults/shared';
import { Delta, Sparkline, TypePill } from './bits';
import { AnimatedCard, AnimatedCounter, AnimatedStatus } from './AnimatedComponents';
import { cn } from '../utils/cn';

interface VaultCardProps {
  vault: Vault & { trader: TraderProfile };
  className?: string;
  index?: number;
}

export function VaultCard({ vault, className, index = 0 }: VaultCardProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Link
      to={`/vault/${vault.id}`}
      className="block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <AnimatedCard
        className={className}
        hover={true}
        glow={true}
        delay={index * 50}
      >
        <div className="space-y-4">
          {/* Header with animated elements */}
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-[15px] font-semibold text-[var(--text)] truncate transition-colors duration-300 font-display uppercase tracking-wide">
                  {vault.name}
                </h3>
                <TypePill type={vault.type} />
              </div>
              <p className="text-sm text-[var(--muted)] truncate mono">
                by @{vault.trader.handle}
              </p>
            </div>

            {/* TVL with animated counter */}
            <div className="text-right ml-4">
              <div className="text-2xl font-bold text-[var(--text)] tabular-nums">
                <AnimatedCounter
                  value={vault.tvlSol}
                  formatFn={(n) => fmtSol(n)}
                  duration={800}
                />
              </div>
              <div className="text-xs text-[var(--dim)]">TVL</div>
            </div>
          </div>

          {/* Performance metrics grid */}
          <div className="grid grid-cols-3 gap-3">
            <MetricCard
              label="30d Return"
              value={fmtPct(vault.stats?.pnlPct30d || 0)}
              isPositive={(vault.stats?.pnlPct30d || 0) >= 0}
              delay={index * 50 + 100}
            />
            <MetricCard
              label="Depositors"
              value={String(vault.stats?.depositorCount || 0)}
              isPositive={true}
              delay={index * 50 + 150}
            />
            <MetricCard
              label="Win Rate"
              value={`${(vault.stats?.winRatePct || 0).toFixed(0)}%`}
              isPositive={(vault.stats?.winRatePct || 0) >= 50}
              delay={index * 50 + 200}
            />
          </div>

          {/* Animated sparkline */}
          <div className="h-16 relative">
            <div className={cn(
              'transition-all duration-300',
              isHovered ? 'opacity-100' : 'opacity-70'
            )}>
              <Sparkline points={vault.equityCurve?.slice(-60) || []} />
            </div>
          </div>

          {/* Footer with status and action */}
          <div className="flex items-center justify-between pt-2 border-t border-[var(--line)]">
            <AnimatedStatus
              status={vault.status === 'active' ? 'active' : 'inactive'}
              label={vault.status}
            />

            <button className={cn(
              "px-4 py-2 rounded text-xs font-medium transition-all duration-300 mono uppercase tracking-wider",
              "bg-[var(--amber)] text-[var(--ink)] border border-[var(--amber)]",
              "hover:bg-[var(--text)] hover:border-[var(--text)] hover:text-[var(--ink)]",
              "hover:shadow-lg hover:shadow-[rgba(255,176,0,0.2)]",
              "hover:translate-y-[-2px] hover:scale-105",
              "active:translate-y-0 active:scale-95"
            )}>
              View Vault
            </button>
          </div>
        </div>
      </AnimatedCard>
    </Link>
  );
}

// ── Animated Metric Card ─────────────────────────────────────────────
interface MetricCardProps {
  label: string;
  value: string;
  isPositive: boolean;
  delay?: number;
}

function MetricCard({ label, value, isPositive, delay = 0 }: MetricCardProps) {
  return (
    <div className={cn(
      "text-center p-3 rounded bg-[var(--panel-2)] border border-[var(--line-2)]",
      "transition-all duration-300",
      "hover:bg-[var(--panel-3)] hover:scale-105 hover:border-[var(--line-bright)]",
      "animate-in fade-in zoom-in-95 duration-300",
      `style-[animation-delay:${delay}ms]`
    )}>
      <div className={cn(
        "text-lg font-semibold tabular-nums mono",
        isPositive ? "text-[var(--green)]" : "text-[var(--red)]"
      )}>
        {value}
      </div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wide">{label}</div>
    </div>
  );
}
