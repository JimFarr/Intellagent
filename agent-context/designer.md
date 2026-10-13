# Designer: how the look works

- **Themes are data.** A theme is a palette plus a `STYLE` spec in `public/app.js`; the spec becomes `data-*` attributes on `<html>`, and `public/app.css` branches on them. Add a look by extending the spec and its CSS branch, not with one-off rules.
- **Colours are tokens.** Use `var(--accent)`, `var(--text)`, `var(--muted)`, `var(--line)`, `var(--warn)`, `var(--danger)`… and `color-mix()` for tints. Never hard-code a colour: it breaks the other themes.
- **Motion is calm.** Ease in/out, no bounce or overshoot, and honour `prefers-reduced-motion`.
- **You can't see the screen.** Reason about layout carefully, keep changes small, and say in your review exactly which themes, states and widths James should look at (light and dark, ~375px phone width).
- Cards, groups and decorations have many variants (sticky, clean, glass, index…): check the ones your change touches.
