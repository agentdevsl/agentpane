import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
      colors: {
        canvas: 'var(--bg-canvas)',
        surface: {
          DEFAULT: 'var(--bg-default)',
          subtle: 'var(--bg-subtle)',
          muted: 'var(--bg-muted)',
          emphasis: 'var(--bg-emphasis)',
        },
        border: {
          DEFAULT: 'var(--border-default)',
          muted: 'var(--border-muted)',
          subtle: 'var(--border-subtle)',
        },
        fg: {
          DEFAULT: 'var(--fg-default)',
          muted: 'var(--fg-muted)',
          subtle: 'var(--fg-subtle)',
          'on-emphasis': 'var(--fg-on-emphasis)',
        },
        accent: {
          DEFAULT: 'var(--accent-fg)',
          emphasis: 'var(--accent-emphasis)',
          muted: 'var(--accent-muted)',
          hover: 'var(--accent-hover)',
        },
        success: {
          DEFAULT: 'var(--success-fg)',
          emphasis: 'var(--success-emphasis)',
          muted: 'var(--success-muted)',
          hover: 'var(--success-hover)',
        },
        danger: {
          DEFAULT: 'var(--danger-fg)',
          emphasis: 'var(--danger-emphasis)',
          muted: 'var(--danger-muted)',
          hover: 'var(--danger-hover)',
        },
        attention: {
          DEFAULT: 'var(--attention-fg)',
          muted: 'var(--attention-muted)',
        },
        done: {
          DEFAULT: 'var(--done-fg)',
          muted: 'var(--done-muted)',
        },
        claude: {
          DEFAULT: 'var(--claude)',
          muted: 'var(--claude-muted)',
          subtle: 'var(--claude-subtle)',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      letterSpacing: {
        tight: 'var(--tracking-tight)',
        normal: 'var(--tracking-normal)',
        wide: 'var(--tracking-wide)',
      },
      boxShadow: {
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
      },
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        'ease-out': 'var(--ease-out)',
        'ease-in-out': 'var(--ease-in-out)',
      },
    },
  },
  plugins: [],
};

export default config;
