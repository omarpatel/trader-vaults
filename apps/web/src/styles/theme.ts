// ── Enhanced Theme System with Professional Animations ──────────────
// Modern dark theme integrated with animation system for Trader Vaults UI

// Color Palette - Dark Theme
export const colors = {
  // Primary colors
  primary: {
    50: '#f0f9ff',
    100: '#e0f2fe',
    200: '#bae6fd',
    300: '#7dd3fc',
    400: '#38bdf8',
    500: '#0ea5e9',
    600: '#0284c7',
    700: '#0369a1',
    800: '#075985',
    900: '#0c4a6e',
  },
  
  // Accent colors
  accent: {
    purple: '#a855f7',
    pink: '#ec4899',
    emerald: '#10b981',
    amber: '#f59e0b',
    red: '#ef4444',
  },
  
  // Dark theme background
  background: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
  
  // Foreground
  foreground: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
  
  // Status colors
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
};

// Typography
export const typography = {
  fontFamily: {
    sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
    mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
  },
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
};

// Spacing
export const spacing = {
  xs: '0.5rem',
  sm: '0.75rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
  '3xl': '4rem',
};

// Border radius
export const borderRadius = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  full: '9999px',
};

// Shadows with animation support
export const shadows = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  glow: '0 0 20px rgba(14, 165, 233, 0.3)',
  glowSuccess: '0 0 20px rgba(16, 185, 129, 0.3)',
  glowError: '0 0 20px rgba(239, 68, 68, 0.3)',
  glowAmber: '0 0 20px rgba(245, 158, 11, 0.3)',
  glowPurple: '0 0 20px rgba(168, 85, 247, 0.3)',
};

// Animation configurations
export const animations = {
  durations: {
    instant: '100ms',
    fast: '150ms',
    normal: '200ms',
    slow: '300ms',
    slower: '400ms',
    slowerStill: '500ms',
  },
  easings: {
    linear: 'linear',
    ease: 'ease',
    easeIn: 'ease-in',
    easeOut: 'ease-out',
    easeInOut: 'ease-in-out',
    spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    springGentle: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    snap: 'cubic-bezier(0.4, 0, 0.2, 1)',
    smooth: 'cubic-bezier(0.4, 0, 0.6, 1)',
    dramatic: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    professional: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  keyframes: {
    fadeIn: 'fadeIn 0.2s ease-in-out',
    fadeInUp: 'fadeInUp 0.3s ease-out',
    fadeInDown: 'fadeInDown 0.3s ease-out',
    fadeInLeft: 'fadeInLeft 0.3s ease-out',
    fadeInRight: 'fadeInRight 0.3s ease-out',
    slideIn: 'slideIn 0.3s ease-out',
    slideOut: 'slideOut 0.3s ease-in',
    scaleIn: 'scaleIn 0.2s ease-out',
    scaleOut: 'scaleOut 0.2s ease-in',
    pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
    shimmer: 'shimmer 1.5s infinite',
    bounce: 'bounce 1s infinite',
    glowPulse: 'glowPulse 2s ease-in-out infinite',
    statusActive: 'statusActive 2s ease-in-out infinite',
    statusWarning: 'statusWarning 1.5s ease-in-out infinite',
  },
};

// Transitions
export const transitions = {
  fast: '100ms ease-in-out',
  normal: '200ms ease-in-out',
  slow: '300ms ease-in-out',
  bounce: '500ms cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  professional: '300ms cubic-bezier(0.16, 1, 0.3, 1)',
  spring: '400ms cubic-bezier(0.175, 0.885, 0.32, 1.275)',
};

// Z-index scale
export const zIndex = {
  dropdown: 10,
  sticky: 20,
  fixed: 30,
  modalBackdrop: 40,
  modal: 50,
  popover: 60,
  tooltip: 70,
  toast: 80,
  drawer: 90,
  overlay: 100,
};

// Breakpoints
export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
};

// Animation variants for components
export const animationVariants = {
  // Card animations
  card: {
    enter: 'animate-in fade-in slide-in-from-bottom-4 duration-500',
    hover: 'hover:scale-105 hover:-translate-y-1 hover:shadow-xl',
    active: 'active:scale-95 active:translate-y-0',
  },
  
  // List item animations
  listItem: {
    enter: 'animate-in fade-in slide-in-from-left-2 duration-300',
    hover: 'hover:bg-blue-500/5',
  },
  
  // Button animations
  button: {
    enter: 'animate-in fade-in duration-200',
    hover: 'hover:scale-105 hover:-translate-y-0.5',
    active: 'active:scale-95 active:translate-y-0',
    focus: 'focus:ring-2 focus:ring-blue-500/50',
  },
  
  // Modal animations
  modal: {
    backdrop: 'animate-in fade-in duration-200',
    content: 'animate-in zoom-in-95 duration-200',
  },
  
  // Dropdown animations
  dropdown: {
    enter: 'animate-in fade-in slide-in-from-top-2 duration-200',
    exit: 'animate-out fade-out slide-out-to-top-2 duration-150',
  },
  
  // Tooltip animations
  tooltip: {
    enter: 'animate-in fade-in zoom-in-95 duration-150',
    exit: 'animate-out fade-out zoom-out-95 duration-150',
  },
  
  // Status indicator animations
  status: {
    active: 'animate-pulse',
    warning: 'animate-pulse',
    loading: 'animate-spin',
  },
  
  // Table row animations
  tableRow: {
    enter: 'animate-in fade-in slide-in-from-left-2 duration-300',
    hover: 'hover:bg-blue-500/5 hover:scale-[1.01]',
  },
  
  // Badge animations
  badge: {
    enter: 'animate-in fade-in scale-in duration-200',
    hover: 'hover:scale-110',
    pulse: 'animate-pulse',
  },
  
  // Progress bar animations
  progressBar: {
    enter: 'animate-in fade-in slide-in-from-left duration-300',
    pulse: 'animate-pulse',
  },
  
  // Notification animations
  notification: {
    enter: 'animate-in slide-in-from-right duration-300',
    exit: 'animate-out slide-out-to-right duration-200',
  },
  
  // Skeleton loading animations
  skeleton: {
    shimmer: 'animate-shimmer',
    pulse: 'animate-pulse',
  },
};

// Stagger animation delays
export const staggerDelays = {
  fast: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450],
  normal: [0, 75, 150, 225, 300, 375, 450, 525, 600, 675],
  slow: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900],
};

// Responsive animation adjustments
export const responsiveAnimations = {
  mobile: {
    duration: '150ms',
    easing: 'ease-out',
  },
  tablet: {
    duration: '200ms',
    easing: 'ease-out',
  },
  desktop: {
    duration: '300ms',
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
};

// Export theme object
export const theme = {
  colors,
  typography,
  spacing,
  borderRadius,
  shadows,
  animations,
  transitions,
  zIndex,
  breakpoints,
  animationVariants,
  staggerDelays,
  responsiveAnimations,
};

// CSS utility functions
export const css = {
  // Flexbox utilities
  flex: {
    center: 'display: flex; align-items: center; justify-content: center;',
    between: 'display: flex; align-items: center; justify-content: space-between;',
    start: 'display: flex; align-items: center; justify-content: flex-start;',
    end: 'display: flex; align-items: center; justify-content: flex-end;',
    column: 'display: flex; flex-direction: column;',
  },
  
  // Grid utilities
  grid: {
    cols: (cols: number) => `display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr));`,
    gap: (gap: string) => `gap: ${gap};`,
  },
  
  // Text utilities
  text: {
    gradient: 'background: linear-gradient(135deg, #0ea5e9 0%, #a855f7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;',
    glow: 'text-shadow: 0 0 10px rgba(14, 165, 233, 0.5);',
  },
  
  // Background utilities
  bg: {
    gradient: 'background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);',
    glass: 'background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);',
  },
  
  // Border utilities
  border: {
    gradient: 'border-image: linear-gradient(135deg, #0ea5e9 0%, #a855f7 100%) 1;',
    glow: 'box-shadow: 0 0 10px rgba(14, 165, 233, 0.3);',
  },
  
  // Animation utilities
  animate: {
    fadeIn: `animation: fadeIn 0.2s ease-in-out;`,
    slideIn: `animation: slideIn 0.3s ease-out;`,
    pulse: `animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;`,
    spring: `animation: scaleIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);`,
  },
  
  // Responsive utilities
  responsive: {
    mobile: '@media (max-width: 768px)',
    desktop: '@media (min-width: 769px)',
  },
};

// Animation presets for quick use
export const animationPresets = {
  // Quick animations
  fadeIn: 'animate-in fade-in duration-200',
  fadeInUp: 'animate-in fade-in slide-in-from-bottom-4 duration-300',
  fadeInDown: 'animate-in fade-in slide-in-from-top-4 duration-300',
  scaleIn: 'animate-in zoom-in-95 duration-200',
  slideIn: 'animate-in slide-in-from-left-4 duration-300',
  
  // Hover effects
  hoverScale: 'hover:scale-105 transition-transform duration-200',
  hoverLift: 'hover:-translate-y-1 transition-transform duration-200',
  hoverGlow: 'hover:shadow-lg transition-shadow duration-200',
  
  // Status effects
  pulse: 'animate-pulse',
  spin: 'animate-spin',
  bounce: 'animate-bounce',
  
  // Interactive
  click: 'active:scale-95 transition-transform duration-100',
  focus: 'focus:ring-2 focus:ring-blue-500/50 transition-all duration-200',
};

export default theme;
