/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // `rgb(var(--x) / <alpha-value>)` is what makes `bg-accent/25` and
        // friends compile. A bare `var(--x)` silently drops the opacity
        // modifier and emits no rule.
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          strong: 'rgb(var(--c-accent-strong) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          muted: 'rgb(var(--c-surface-muted) / <alpha-value>)',
          elevated: 'rgb(var(--c-surface-elevated) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          muted: 'rgb(var(--c-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--c-ink-faint) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'var(--c-card-bg)',
          border: 'var(--c-card-border)',
        },
        rule: 'var(--c-rule)',
        good: {
          DEFAULT: 'rgb(var(--c-good) / <alpha-value>)',
          strong: 'rgb(var(--c-good-strong) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--c-warn) / <alpha-value>)',
          strong: 'rgb(var(--c-warn-strong) / <alpha-value>)',
        },
        hot: 'rgb(var(--c-hot) / <alpha-value>)',
        bad: {
          DEFAULT: 'rgb(var(--c-bad) / <alpha-value>)',
          strong: 'rgb(var(--c-bad-strong) / <alpha-value>)',
        },
        tag: {
          sky: 'var(--c-tag-sky)', rose: 'var(--c-tag-rose)', cyan: 'var(--c-tag-cyan)',
          violet: 'var(--c-tag-violet)', indigo: 'var(--c-tag-indigo)', amber: 'var(--c-tag-amber)',
          orange: 'var(--c-tag-orange)', emerald: 'var(--c-tag-emerald)', blue: 'var(--c-tag-blue)',
        },
        wash: {
          DEFAULT: 'var(--c-wash)',
          strong: 'var(--c-wash-strong)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
};
