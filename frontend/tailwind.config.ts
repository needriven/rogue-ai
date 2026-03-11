import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        t: {
          bg:           '#080808',
          panel:        '#0d0d0d',
          surface:      '#111111',
          border:       '#1c1c1c',
          'border-dim': '#141414',

          green:        '#22c55e',
          'green-hi':   '#4ade80',
          'green-lo':   '#15803d',
          'green-glow': 'rgba(34,197,94,0.12)',

          amber:        '#f59e0b',
          'amber-lo':   'rgba(245,158,11,0.15)',

          red:          '#ef4444',
          blue:         '#3b82f6',

          text:         '#d4d4d4',
          dim:          '#525252',
          muted:        '#2a2a2a',
        },
      },
      fontFamily: {
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          '"Cascadia Code"',
          'Menlo',
          'monospace',
        ],
      },
      animation: {
        blink:       'blink 1s step-end infinite',
        'fade-in':   'fadeIn 0.4s ease forwards',
        'slide-in':  'slideIn 0.3s ease forwards',
        'glow-pulse':'glowPulse 3s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%,100%': { opacity: '1' },
          '50%':     { opacity: '0' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        glowPulse: {
          '0%,100%': { boxShadow: '0 0 6px rgba(34,197,94,0.2)' },
          '50%':     { boxShadow: '0 0 18px rgba(34,197,94,0.5)' },
        },
      },
      boxShadow: {
        'glow-green': '0 0 12px rgba(34,197,94,0.3), 0 0 30px rgba(34,197,94,0.1)',
        'glow-amber': '0 0 12px rgba(245,158,11,0.3)',
        'inner-green':'inset 0 0 20px rgba(34,197,94,0.05)',
      },
      backgroundImage: {
        'scanlines': "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)",
      },
    },
  },
  plugins: [],
} satisfies Config
