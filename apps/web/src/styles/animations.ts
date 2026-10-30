// ── Professional Animation Library ─────────────────────────────────────
// Modern, performant animations for Trader Vaults UI components

// Animation durations
export const durations = {
  instant: '0.1s',
  fast: '0.15s',
  normal: '0.2s',
  slow: '0.3s',
  slower: '0.4s',
  slowerStill: '0.5s',
} as const;

// Animation easing functions
export const easings = {
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  // Custom professional easings
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  springGentle: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  snap: 'cubic-bezier(0.4, 0, 0.2, 1)',
  smooth: 'cubic-bezier(0.4, 0, 0.6, 1)',
  dramatic: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  professional: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const;

// Animation keyframes
export const keyframes = {
  // Fade animations
  fadeIn: {
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
  fadeInUp: {
    from: { opacity: 0, transform: 'translateY(12px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
  fadeInDown: {
    from: { opacity: 0, transform: 'translateY(-12px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
  fadeInLeft: {
    from: { opacity: 0, transform: 'translateX(-12px)' },
    to: { opacity: 1, transform: 'translateX(0)' },
  },
  fadeInRight: {
    from: { opacity: 0, transform: 'translateX(12px)' },
    to: { opacity: 1, transform: 'translateX(0)' },
  },

  // Slide animations
  slideInUp: {
    from: { transform: 'translateY(100%)', opacity: 0 },
    to: { transform: 'translateY(0)', opacity: 1 },
  },
  slideInDown: {
    from: { transform: 'translateY(-100%)', opacity: 0 },
    to: { transform: 'translateY(0)', opacity: 1 },
  },
  slideInLeft: {
    from: { transform: 'translateX(-100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
  },
  slideInRight: {
    from: { transform: 'translateX(100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
  },

  // Scale animations
  scaleIn: {
    from: { transform: 'scale(0.95)', opacity: 0 },
    to: { transform: 'scale(1)', opacity: 1 },
  },
  scaleOut: {
    from: { transform: 'scale(1)', opacity: 1 },
    to: { transform: 'scale(0.95)', opacity: 0 },
  },
  scaleUp: {
    from: { transform: 'scale(1)' },
    to: { transform: 'scale(1.05)' },
  },

  // Pulse and heartbeat
  pulse: {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.5 },
  },
  heartbeat: {
    '0%, 100%': { transform: 'scale(1)' },
    '25%': { transform: 'scale(1.1)' },
    '50%': { transform: 'scale(1)' },
    '75%': { transform: 'scale(1.1)' },
  },

  // Shimmer and loading
  shimmer: {
    from: { backgroundPosition: '-400px 0' },
    to: { backgroundPosition: '400px 0' },
  },
  spin: {
    from: { transform: 'rotate(0deg)' },
    to: { transform: 'rotate(360deg)' },
  },
  bounce: {
    '0%, 100%': { transform: 'translateY(0)' },
    '50%': { transform: 'translateY(-8px)' },
  },

  // Specialized animations
  glowPulse: {
    '0%, 100%': { boxShadow: '0 0 20px rgba(14, 165, 233, 0.3)' },
    '50%': { boxShadow: '0 0 30px rgba(14, 165, 233, 0.5)' },
  },
  slideFromBottom: {
    from: { transform: 'translateY(20px)', opacity: 0 },
    to: { transform: 'translateY(0)', opacity: 1 },
  },
  numberCount: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(-100%)' },
  },

  // Table row animations
  rowEnter: {
    from: { 
      transform: 'translateX(-10px)', 
      opacity: 0,
      background: 'transparent',
    },
    to: { 
      transform: 'translateX(0)', 
      opacity: 1,
      background: 'transparent',
    },
  },
  rowUpdate: {
    '0%': { background: 'rgba(14, 165, 233, 0.1)' },
    '100%': { background: 'transparent' },
  },

  // Card hover animations
  cardHover: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(-4px)' },
  },
  cardGlow: {
    from: { boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' },
    to: { boxShadow: '0 20px 25px -5px rgba(14, 165, 233, 0.3)' },
  },

  // Status indicator animations
  statusActive: {
    '0%, 100%': { opacity: 1, transform: 'scale(1)' },
    '50%': { opacity: 0.7, transform: 'scale(1.1)' },
  },
  statusWarning: {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.5 },
  },

  // Loading skeleton
  skeletonShimmer: {
    from: {
      backgroundPosition: '-800px 0',
    },
    to: {
      backgroundPosition: '800px 0',
    },
  },

  // Progress indicator
  progressPulse: {
    '0%': { opacity: 0.6 },
    '50%': { opacity: 1 },
    '100%': { opacity: 0.6 },
  },

  // Stagger animations
  staggerIn: {
    from: { opacity: 0, transform: 'translateY(8px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },

  // Notification animations
  notificationIn: {
    from: { transform: 'translateX(100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
  },
  notificationOut: {
    from: { transform: 'translateX(0)', opacity: 1 },
    to: { transform: 'translateX(100%)', opacity: 0 },
  },

  // Tooltip animations
  tooltipIn: {
    from: { opacity: 0, transform: 'translateY(4px) scale(0.95)' },
    to: { opacity: 1, transform: 'translateY(0) scale(1)' },
  },
  tooltipOut: {
    from: { opacity: 1, transform: 'translateY(0) scale(1)' },
    to: { opacity: 0, transform: 'translateY(4px) scale(0.95)' },
  },
};

// Animation utilities
export const createAnimation = (
  name: string,
  duration: string = durations.normal,
  easing: string = easings.easeOut,
  delay: string = '0ms',
  fillMode: string = 'both'
) => ({
  animation: `${name} ${duration} ${easing} ${delay} ${fillMode}`,
});

// Stagger children animations
export const createStagger = (
  baseDelay: number = 50,
  count: number = 10
) => {
  return Array.from({ length: count }, (_, i) => ({
    animationDelay: `${i * baseDelay}ms`,
  }));
};

// Responsive animation durations
export const responsiveDuration = (
  mobile: string,
  tablet: string,
  desktop: string
) => ({
  '@media (max-width: 768px)': {
    animationDuration: mobile,
  },
  '@media (min-width: 769px) and (max-width: 1024px)': {
    animationDuration: tablet,
  },
  '@media (min-width: 1025px)': {
    animationDuration: desktop,
  },
});

// Animation variants for common use cases
export const variants = {
  // Card variants
  card: {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    hover: { y: -4, transition: { duration: 0.2 } },
  },

  // List item variants
  listItem: {
    initial: { opacity: 0, x: -10 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 10 },
  },

  // Modal variants
  modal: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 },
  },

  // Drawer variants
  drawer: {
    initial: { x: '100%' },
    animate: { x: 0 },
    exit: { x: '100%' },
  },

  // Dropdown variants
  dropdown: {
    initial: { opacity: 0, y: -8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
  },

  // Tooltip variants
  tooltip: {
    initial: { opacity: 0, scale: 0.95, y: 4 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.95, y: 4 },
  },

  // Tab variants
  tab: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
  },
};

// Animation presets for quick use
export const presets = {
  // Quick fade in
  fadeIn: createAnimation('fadeIn', durations.fast, easings.easeOut),
  
  // Slide up
  slideUp: createAnimation('slideInUp', durations.normal, easings.spring),
  
  // Scale in
  scaleIn: createAnimation('scaleIn', durations.normal, easings.springGentle),
  
  // Gentle pulse
  pulse: createAnimation('pulse', '2s', easings.easeInOut, '0ms', 'infinite'),
  
  // Shimmer effect
  shimmer: createAnimation('shimmer', '1.5s', easings.linear, '0ms', 'infinite'),
  
  // Heartbeat
  heartbeat: createAnimation('heartbeat', '1.5s', easings.easeInOut, '0ms', 'infinite'),
  
  // Bounce
  bounce: createAnimation('bounce', '1s', easings.spring, '0ms', 'infinite'),
};

// Reduced motion support
export const reducedMotion = {
  '@media (prefers-reduced-motion: reduce)': {
    animation: 'none !important',
    transition: 'none !important',
  },
};

export default {
  durations,
  easings,
  keyframes,
  variants,
  presets,
  createAnimation,
  createStagger,
  responsiveDuration,
  reducedMotion,
};
