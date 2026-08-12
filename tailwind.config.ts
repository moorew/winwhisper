import type { Config } from "tailwindcss";

/**
 * Colours all resolve through the HSL token layer in src/globals.css.
 *
 * Tokens carrying their own alpha (stroke, hairline, pane-edge) are declared
 * without the `<alpha-value>` placeholder — Tailwind would otherwise overwrite
 * the alpha baked into the token.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces
        chrome: {
          from: "hsl(var(--chrome-from))",
          mid: "hsl(var(--chrome-mid))",
          to: "hsl(var(--chrome-to))",
        },
        pane: "hsl(var(--pane))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        input: "hsl(var(--input))",
        "segment-active": "hsl(var(--segment-active))",

        // Lines
        stroke: {
          DEFAULT: "hsl(var(--stroke))",
          strong: "hsl(var(--stroke-strong))",
        },
        hairline: "hsl(var(--hairline))",
        "pane-edge": "hsl(var(--pane-edge))",

        // Text
        text: {
          DEFAULT: "hsl(var(--text))",
          strong: "hsl(var(--text-strong))",
          body: "hsl(var(--text-body))",
          secondary: "hsl(var(--text-secondary))",
          tertiary: "hsl(var(--text-tertiary))",
          muted: "hsl(var(--text-muted))",
          dim: "hsl(var(--text-dim))",
        },
        titlebar: {
          text: "hsl(var(--titlebar-text))",
          glyph: "hsl(var(--titlebar-glyph))",
          subtle: "hsl(var(--titlebar-subtle))",
        },

        // Accent — fill is for filled surfaces only, ink for everything else
        accent: {
          DEFAULT: "hsl(var(--accent-ink) / <alpha-value>)",
          fill: "hsl(var(--accent-fill) / <alpha-value>)",
          ink: "hsl(var(--accent-ink) / <alpha-value>)",
          on: "hsl(var(--accent-on-fill))",
          badge: "hsl(var(--accent-badge))",
          foreground: "hsl(var(--accent-foreground))",
        },

        // Neutral fills — theme-aware so they invert on light
        fill: {
          faint: "hsl(var(--fill-faint))",
          subtle: "hsl(var(--fill-subtle))",
          DEFAULT: "hsl(var(--fill))",
          strong: "hsl(var(--fill-strong))",
        },
        track: "hsl(var(--track))",
        dropline: "hsl(var(--dashed))",
        preview: "hsl(var(--preview-bg))",
        meter: "hsl(var(--meter))",

        // Supporting
        danger: "hsl(var(--danger) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        speaker: {
          1: "hsl(var(--speaker-1))",
          2: "hsl(var(--speaker-2))",
          3: "hsl(var(--speaker-3))",
          4: "hsl(var(--speaker-4))",
          5: "hsl(var(--speaker-5))",
          6: "hsl(var(--speaker-6))",
          7: "hsl(var(--speaker-7))",
          8: "hsl(var(--speaker-8))",
        },

        // shadcn-derived primitives already in the tree
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
      },
      borderRadius: {
        window: "10px",
        modal: "14px",
        pane: "10px",
        card: "10px",
        control: "7px",
        segment: "6px",
        chip: "6px",
        tile: "8px",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        window: "0 50px 90px -30px rgba(0,0,0,0.9)",
        modal: "0 40px 70px -20px rgba(0,0,0,0.85)",
        floating: "0 30px 60px -20px rgba(0,0,0,0.9)",
        segment: "0 1px 2px rgba(0,0,0,0.45)",
      },
      fontSize: {
        // The design works in half-pixels; these are the roles it names.
        meta: ["11.5px", { lineHeight: "1.45" }],
        label: ["12.5px", { lineHeight: "1.45" }],
        body: ["13px", { lineHeight: "1.5" }],
        title: ["13.5px", { lineHeight: "1.4" }],
        model: ["14px", { lineHeight: "1.4" }],
        reader: ["14px", { lineHeight: "1.62" }],
        h2: ["17px", { lineHeight: "1.3", letterSpacing: "-0.012em" }],
        h1: ["19px", { lineHeight: "1.25", letterSpacing: "-0.012em" }],
        modal: ["20px", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
      },
      transitionDuration: {
        rail: "140ms",
      },
    },
  },
  plugins: [],
};

export default config;
