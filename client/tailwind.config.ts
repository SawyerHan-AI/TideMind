import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  content: ['./src/**/*.{tsx,ts,jsx,js}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#141416',
          light: '#1c1c1f',
          dark: '#09090b',
        },
        heat: {
          cold: '#94a3b8',
          warm: '#f97316',
          hot: '#ef4444',
        }
      },
      boxShadow: {
        'glow-blue':    '0 0 12px rgba(129,140,248,0.3)',
        'glow-amber':   '0 0 12px rgba(245,158,11,0.3)',
        'glow-sm-blue':    '0 0 8px rgba(129,140,248,0.2)',
        'glow-sm-amber':   '0 0 8px rgba(245,158,11,0.2)',
        'card': '0 4px 24px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.6)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'shimmer': 'shimmer 1.5s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config
