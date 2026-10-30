// ── Responsive Design Utilities ───────────────────────────────────────
// Modern responsive design helpers for Trader Vaults UI components

import { useState, useEffect } from 'react';

// Breakpoint definitions
export const breakpoints = {
  xs: '0px',
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export type Breakpoint = keyof typeof breakpoints;

/** '640px' -> 640. The values are authored with units for use in CSS. */
const bpPx = (b: Breakpoint): number => parseInt(breakpoints[b], 10);

// Media query generators
export const media = {
  up: (breakpoint: Breakpoint) => `@media (min-width: ${breakpoints[breakpoint]})`,
  down: (breakpoint: Breakpoint) => `@media (max-width: ${bpPx(breakpoint) - 1}px)`,
  between: (min: Breakpoint, max: Breakpoint) => 
    `@media (min-width: ${breakpoints[min]}) and (max-width: ${bpPx(max) - 1}px)`,
  only: (breakpoint: Breakpoint) => {
    const keys = Object.keys(breakpoints) as Breakpoint[];
    const index = keys.indexOf(breakpoint);
    const next = keys[index + 1];
    return next 
      ? `@media (min-width: ${breakpoints[breakpoint]}) and (max-width: ${bpPx(next) - 1}px)`
      : media.up(breakpoint);
  },
};

// Responsive spacing
export const responsiveSpacing = {
  padding: {
    mobile: '1rem',
    tablet: '1.5rem',
    desktop: '2rem',
  },
  margin: {
    mobile: '0.5rem',
    tablet: '1rem',
    desktop: '1.5rem',
  },
  gap: {
    mobile: '0.5rem',
    tablet: '0.75rem',
    desktop: '1rem',
  },
};

// Grid layouts for different screen sizes
export const gridLayouts = {
  // Card grids
  cards: {
    mobile: 'grid-template-columns: 1fr;',
    tablet: 'grid-template-columns: repeat(2, minmax(0, 1fr));',
    desktop: 'grid-template-columns: repeat(3, minmax(0, 1fr));',
    large: 'grid-template-columns: repeat(4, minmax(0, 1fr));',
  },
  
  // Dashboard layouts
  dashboard: {
    mobile: 'grid-template-columns: 1fr;',
    tablet: 'grid-template-columns: repeat(2, minmax(0, 1fr));',
    desktop: 'grid-template-columns: 280px minmax(0, 1fr);',
  },
  
  // Terminal layouts
  terminal: {
    mobile: 'grid-template-columns: 1fr;',
    tablet: 'grid-template-columns: 1fr 320px;',
    desktop: 'grid-template-columns: minmax(0, 1fr) 380px;',
  },
  
  // Stats grids
  stats: {
    mobile: 'grid-template-columns: 1fr;',
    tablet: 'grid-template-columns: repeat(2, minmax(0, 1fr));',
    desktop: 'grid-template-columns: repeat(4, minmax(0, 1fr));',
  },
};

// Typography scales
export const responsiveTypography = {
  fontSize: {
    mobile: {
      xs: '0.7rem',
      sm: '0.8rem',
      base: '0.9rem',
      lg: '1rem',
      xl: '1.1rem',
      '2xl': '1.3rem',
      '3xl': '1.6rem',
    },
    tablet: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '2xl': '1.5rem',
      '3xl': '1.875rem',
    },
    desktop: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '2xl': '1.5rem',
      '3xl': '1.875rem',
    },
  },
};

// Component-specific responsive classes
export const responsiveComponents = {
  // Vault cards
  vaultCard: {
    mobile: 'min-width: 100%;',
    tablet: 'min-width: calc(50% - 7px);',
    desktop: 'min-width: calc(33.333% - 10px);',
  },
  
  // Tables
  table: {
    mobile: 'font-size: 0.75rem;',
    tablet: 'font-size: 0.875rem;',
    desktop: 'font-size: 1rem;',
  },
  
  // Buttons
  button: {
    mobile: 'padding: 0.5rem 0.75rem; font-size: 0.75rem;',
    tablet: 'padding: 0.625rem 1rem; font-size: 0.875rem;',
    desktop: 'padding: 0.75rem 1.25rem; font-size: 1rem;',
  },
  
  // Forms
  input: {
    mobile: 'padding: 0.5rem 0.75rem; font-size: 0.875rem;',
    tablet: 'padding: 0.625rem 0.875rem; font-size: 1rem;',
    desktop: 'padding: 0.75rem 1rem; font-size: 1rem;',
  },
};

// Container max widths
export const containerWidths = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
  full: '100%',
};

// CSS utility functions for responsive design
export const css = {
  // Responsive container
  container: (maxWidth: keyof typeof containerWidths = 'xl') => `
    width: 100%;
    max-width: ${containerWidths[maxWidth]};
    margin: 0 auto;
    padding: 0 1rem;
    ${media.down('sm')} {
      padding: 0 0.75rem;
    }
  `,
  
  // Responsive grid
  grid: (columns: { mobile?: number; tablet?: number; desktop?: number }) => `
    display: grid;
    gap: 1rem;
    ${columns.mobile && `grid-template-columns: repeat(${columns.mobile}, minmax(0, 1fr));`}
    ${media.up('md')} {
      ${columns.tablet && `grid-template-columns: repeat(${columns.tablet}, minmax(0, 1fr));`}
    }
    ${media.up('lg')} {
      ${columns.desktop && `grid-template-columns: repeat(${columns.desktop}, minmax(0, 1fr));`}
    }
  `,
  
  // Responsive flex
  flex: (direction: { mobile?: string; tablet?: string; desktop?: string }) => `
    display: flex;
    flex-direction: ${direction.mobile || 'row'};
    ${media.up('md')} {
      flex-direction: ${direction.tablet || direction.mobile || 'row'};
    }
    ${media.up('lg')} {
      flex-direction: ${direction.desktop || direction.tablet || direction.mobile || 'row'};
    }
  `,
  
  // Responsive spacing
  spacing: (property: 'padding' | 'margin', value: { mobile?: string; tablet?: string; desktop?: string }) => `
    ${property}: ${value.mobile || '1rem'};
    ${media.up('md')} {
      ${property}: ${value.tablet || value.mobile || '1rem'};
    }
    ${media.up('lg')} {
      ${property}: ${value.desktop || value.tablet || value.mobile || '1rem'};
    }
  `,
  
  // Responsive typography
  typography: (property: 'fontSize' | 'lineHeight', value: { mobile?: string; tablet?: string; desktop?: string }) => `
    ${property}: ${value.mobile || '1rem'};
    ${media.up('md')} {
      ${property}: ${value.tablet || value.mobile || '1rem'};
    }
    ${media.up('lg')} {
      ${property}: ${value.desktop || value.tablet || value.mobile || '1rem'};
    }
  `,
  
  // Hide elements on specific breakpoints
  hide: {
    mobile: 'display: none;',
    tablet: `${media.down('md')} { display: none; }`,
    desktop: `${media.down('lg')} { display: none; }`,
    mobileOnly: `${media.up('md')} { display: none; }`,
    tabletOnly: `${media.down('md')} { display: none; } ${media.up('lg')} { display: none; }`,
    desktopOnly: `${media.down('lg')} { display: none; }`,
  },
  
  // Show elements on specific breakpoints
  show: {
    mobile: `${media.up('md')} { display: none; }`,
    tablet: `${media.down('md')} { display: none; } ${media.up('lg')} { display: none; }`,
    desktop: `${media.down('lg')} { display: none; }`,
  },
};

// Hook for responsive design
export function useBreakpoint() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const currentBreakpoint = (Object.entries(breakpoints).find(
    ([, width]) => windowSize.width >= parseInt(width)
  )?.[0] || 'xs') as Breakpoint;

  return {
    windowSize,
    breakpoint: currentBreakpoint,
    isMobile: windowSize.width < parseInt(breakpoints.md),
    isTablet: windowSize.width >= parseInt(breakpoints.md) && windowSize.width < parseInt(breakpoints.lg),
    isDesktop: windowSize.width >= parseInt(breakpoints.lg),
  };
}

// Default export
export default {
  breakpoints,
  media,
  responsiveSpacing,
  gridLayouts,
  responsiveTypography,
  responsiveComponents,
  containerWidths,
  css,
  useBreakpoint,
};
