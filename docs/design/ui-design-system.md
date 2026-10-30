# Clear Bench — UI design system

The console uses a light "workbench" canvas, a dark navigation rail, and a
single warm accent. The goal is dense engineering information without a
"marketing dashboard" look.

## Type

- IBM Plex Sans for UI, IBM Plex Mono for identifiers, paths, and hashes.
- Minimum UI text size: **11px** (meta 11.5px, body 13.5px).
- Numeric columns use tabular figures.

## Color

- Canvas: warm off-white; panels: paper white; rail: deep green-black.
- Accent: `#e4571e` for primary actions and focus; dark orange `#b23e0f`
  for orange text on light backgrounds (contrast ≥ 4.5:1).
- Status: green/amber/red are paired with text labels, never color alone.

## Interaction

- Decision rows are full-width buttons with a visible focus ring.
- All interactive controls have hover, active, focus-visible, and disabled
  states.
- Tables keep headers visible while scrolling; long paths wrap instead of
  overflowing.
- Loading and empty states use skeletons/empty blocks, not blank screens.
- Respect `prefers-reduced-motion`.

Tokens live in `src/theme.css`; components in `src/components/`.
