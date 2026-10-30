// ── Enhanced UI Components with Professional Animations ─────────────
// Modern, animated UI components for Trader Vaults vault cards and trading interfaces

import { ReactNode, useState, useRef, useEffect } from 'react';
import { cn } from '../utils/cn';

// ── Animated Card Container ─────────────────────────────────────────
interface AnimatedCardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  click?: boolean;
  glow?: boolean;
  delay?: number;
}

export function AnimatedCard({
  children,
  className,
  hover = true,
  click = true,
  glow = true,
  delay = 0
}: AnimatedCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  return (
    <div
      className={cn(
        // Base styles - using app theme colors
        'relative overflow-hidden',
        'bg-[var(--panel)] border border-[var(--line-2)]',
        'transition-all duration-300 ease-out',
        'hover:border-[var(--amber)]',
        'animate-in fade-in slide-in-from-bottom-4 duration-500',
        `style-[animation-delay:${delay}ms]`,
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); setIsPressed(false); }}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        transform: isHovered && hover ? 'translateY(-4px)' : isPressed && click ? 'translateY(0)' : 'translateY(0)',
        boxShadow: isHovered && glow ? '0 12px 30px rgba(255, 176, 0, 0.15)' : 'none',
        transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease, border-color 0.2s ease'
      }}
    >
      {/* Content */}
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}

// ── Animated Counter for Numbers ─────────────────────────────────────
interface AnimatedCounterProps {
  value: number;
  duration?: number;
  formatFn?: (n: number) => string;
  className?: string;
}

export function AnimatedCounter({
  value,
  duration = 1000,
  formatFn = (n) => n.toFixed(2),
  className
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const startTimeRef = useRef<number>();
  const startValueRef = useRef(0);
  const requestRef = useRef<number>();

  useEffect(() => {
    startValueRef.current = displayValue;
    startTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTimeRef.current!;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function for smooth animation
      const easedProgress = 1 - Math.pow(1 - progress, 3);

      const currentValue = startValueRef.current + (value - startValueRef.current) * easedProgress;
      setDisplayValue(currentValue);

      if (progress < 1) {
        requestRef.current = requestAnimationFrame(animate);
      }
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [value, duration]);

  return (
    <span className={cn('num', className)}>
      {formatFn(displayValue)}
    </span>
  );
}

// ── Animated Status Indicator ───────────────────────────────────────
interface AnimatedStatusProps {
  status: 'active' | 'inactive' | 'warning' | 'error' | 'loading';
  label?: string;
  className?: string;
}

export function AnimatedStatus({ status, label, className }: AnimatedStatusProps) {
  const statusConfig = {
    active: {
      color: 'bg-[var(--green)]',
      shadow: 'shadow-[var(--green)]',
      animation: 'status-active 2s ease-in-out infinite',
    },
    inactive: {
      color: 'bg-[var(--dim)]',
      shadow: '',
      animation: '',
    },
    warning: {
      color: 'bg-[var(--amber)]',
      shadow: 'shadow-[var(--amber)]',
      animation: 'status-warning 1.5s ease-in-out infinite',
    },
    error: {
      color: 'bg-[var(--red)]',
      shadow: 'shadow-[var(--red)]',
      animation: 'status-active 1s ease-in-out infinite',
    },
    loading: {
      color: 'bg-[var(--blue)]',
      shadow: 'shadow-[var(--blue)]',
      animation: 'spin 1s linear infinite',
    },
  };

  const config = statusConfig[status];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className={cn(
          'w-2 h-2 rounded-full',
          config.color,
          config.shadow && `${config.shadow} shadow-lg`,
        )}
        style={{
          animation: config.animation,
        }}
      />
      {label && (
        <span className="text-sm text-[var(--muted)] capitalize">
          {label}
        </span>
      )}
    </div>
  );
}

// ── Animated Badge ─────────────────────────────────────────────────
interface AnimatedBadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  pulse?: boolean;
  className?: string;
}

export function AnimatedBadge({
  children,
  variant = 'default',
  pulse = false,
  className
}: AnimatedBadgeProps) {
  const variantClasses = {
    default: 'bg-[var(--panel-2)] text-[var(--muted)] border-[var(--line-2)]',
    success: 'bg-[rgba(47, 217, 128, 0.2)] text-[var(--green)] border-[rgba(47, 217, 128, 0.3)]',
    warning: 'bg-[rgba(255, 176, 0, 0.2)] text-[var(--amber)] border-[rgba(255, 176, 0, 0.3)]',
    error: 'bg-[rgba(255, 79, 88, 0.2)] text-[var(--red)] border-[rgba(255, 79, 88, 0.3)]',
    info: 'bg-[rgba(111, 179, 255, 0.2)] text-[var(--blue)] border-[rgba(111, 179, 255, 0.3)]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border',
        'transition-all duration-200',
        'hover:scale-105 active:scale-95 cursor-default',
        variantClasses[variant],
        pulse && 'animate-pulse',
        className
      )}
    >
      {children}
    </span>
  );
}

// ── Skeleton Loading Component ─────────────────────────────────────
interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular';
  width?: string | number;
  height?: string | number;
  animation?: 'pulse' | 'wave' | 'none';
}

export function Skeleton({
  className,
  variant = 'text',
  width,
  height,
  animation = 'wave'
}: SkeletonProps) {
  const variantClasses = {
    text: 'h-4 rounded',
    circular: 'rounded-full',
    rectangular: 'rounded-md',
  };

  const animationClasses = {
    pulse: 'animate-pulse',
    wave: 'animate-shimmer bg-gradient-to-r from-[var(--panel-2)] via-[var(--panel-3)] to-[var(--panel-2)] bg-[length:200%_100%]',
    none: '',
  };

  return (
    <div
      className={cn(
        'bg-[var(--panel-2)]',
        variantClasses[variant],
        animationClasses[animation],
        className
      )}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
      }}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

/**
 * A table row that fades in, staggered by its index.
 *
 * PositionsTable and TradeTape both imported this and it did not exist —
 * the module had no AnimatedRow export at all, so the app was shipping
 * with two broken imports that only a typecheck would catch.
 *
 * Must render a bare <tr>: a wrapper element between <tbody> and <tr>
 * is invalid HTML and browsers hoist it out, which silently destroys
 * the table layout.
 */
export function AnimatedRow({
  children,
  index = 0,
  onClick,
  className,
}: {
  children: React.ReactNode;
  index?: number;
  onClick?: () => void;
  className?: string;
}) {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <tr
      className={className}
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : undefined,
        // cap the stagger: on a long tape the last rows would otherwise
        // wait seconds before appearing
        animation: reduced ? undefined : `rowIn 220ms ease-out ${Math.min(index * 18, 360)}ms both`,
      }}
    >
      {children}
    </tr>
  );
}

export default {
  AnimatedCard,
  AnimatedCounter,
  AnimatedStatus,
  AnimatedBadge,
  AnimatedRow,
  Skeleton,
};
