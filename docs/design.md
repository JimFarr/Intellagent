# Design language

Professional, with a little play. Few things on screen, each one aligned to the same grid, and one surprise per page at most. Studied: GitHub Primer (lists, headers, borders over shadows), Linear (quiet density, one accent), Vercel (hairlines, big calm type), shadcn (small radii, tokens). Designed in **Clear** and **Clear Dark**; imported themes only change the tokens.

This file is the contract for the design pass (INT-471). A page that breaks it needs a reason on its card.

## What the CSS does today (the audit)

The stylesheet (2,900 lines) has tokens for colour and for three radii, and nothing else. Counted in `public/app.css`:

- **Type:** 11 font sizes in use (7.5, 8, 9, 10, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15 px). 12 and 12.5 are the same size to the eye, and 9 px and below is unreadable.
- **Radii:** 50 % (52×), 99 px (48×), `--r-ctl` (37×), then 4, 5, 6, 8, 9, 10, 12 px typed by hand 70 times. Seven near-equal radii read as noise, not as a system.
- **Spacing:** gaps of 2, 3, 4, 5, 6, 7, 8, 10, 12, 14 px. 5 and 7 never line up with anything.
- **Surfaces:** cards, columns and modals each have their own radius, shadow and line recipe.

So the fix is to say fewer things, and say them the same way everywhere.

## Scales

**Space: a 4 px grid, eight steps.** `4 8 12 16 24 32 48 64`. Gaps inside a control: 4 or 8. Between controls: 8 or 12. Padding of a card or row: 12 (compact) or 16. Between sections: 24 or 32. Page gutter: 16 at 375 px, 24 from 768, 32 from 1280. Never 5, 7, 9, 10, 14.

**Type: five sizes.**

| Role | Size / line | Weight | Used for |
|---|---|---|---|
| Caption | 12 / 16 | 500 | meta, chips, timestamps, table headers |
| Body | 13 / 20 | 400 | everything you read and click |
| Strong | 14 / 20 | 600 | card titles, row titles, buttons that matter |
| Heading | 18 / 24 | 600 | page and section titles |
| Title | 24 / 32 | 600 | the page title on section pages (one per page) |

Minimum 12 px, always. Smaller glyphs (the old 7.5–11 px) become icons or go away. Numbers in tables and counts use tabular figures. Mono only for ids, commands and code. Line length of prose caps at 68 ch.

**Radius: three.** `--r-s` 6 px (chips, inputs, buttons, small tiles), `--r-m` 10 px (cards, menus, popovers, rows that lift), `--r-l` 16 px (columns, modals, the settings window). Avatars and status dots are round (50 %). Pills (99 px) are for counts and one-word tags only, never for buttons or inputs. The current `--r-card`, `--r-col`, `--r-modal`, `--r-ctl` become aliases, then disappear.

## Surfaces and lines

Three levels, told apart by a hairline first and a tint second. **Shadows are for things that float** (menus, popovers, modals, a dragged card) and nowhere else.

| Level | Token | Where |
|---|---|---|
| Page | `--bg` | behind everything |
| Panel | `--panel` | side menu, top bar, columns, settings window |
| Raised | `--surface` | cards, rows, inputs, tiles |

- Border: `1px solid var(--border)` between a panel and the page, `--card-line` (8 % text) inside a panel. A thing has a border *or* a fill difference, not a border and a shadow and a glow.
- Dividers inside a list are hairlines, not gaps with boxes. A list of ten things is one panel with nine hairlines, not ten cards (Primer's Issues list).
- Glass, blur, textures and glow belong to imported themes (their `style:` line), never to the base look.

## Components

**Page header.** One row, 64 px tall at most: the Title on the left; actions on the right, the primary one filled, the rest quiet. A one-line caption under the title only when it explains something. Same position, same size on every page; the content starts 24 px under it. Symmetry: the content column is centred and has the same gutter on both sides; wide pages (Flow, Analytics, Assignments) use a 12-column grid, never one long left-hugging column.

**Side menu.** 240 px (icons only at 56 px under 1000 px wide). Item: 32 px tall, 8 px radius `--r-s`, icon 16 px + label in Body; the current one has an accent bar 2 px wide on its left edge and `--hover` fill, no coloured text. Groups are separated by 24 px and a Caption label, no rules. Never scrolls.

**List and table.** Row 40 px (compact 32), hairline between rows, hover `--hover`, no zebra. Columns align on the same left edges as the page header. Header row in Caption, `--muted`. The row's one primary action appears at the right on hover and on focus. A selected row has the accent bar, as the menu.

**Row with a title and a line under it** (agent banner rows, Your rules, Permissions, any list row). James's rule: the subtext sits on the same line as the title when there is room, and wraps to a second line only when there is not. "Green Review · If a ticket fits and every reviewer said ok…" is one line; "Edit files · Read, create and change files in its folder." is one line beside its chips. Build it as one flex row with `flex-wrap: wrap`: the title is `flex: 0 0 auto`, the subtext `flex: 1 1 24ch; min-width: 0` in Caption `--muted`, separated by a `·` that belongs to the subtext (so a wrapped line does not start with a dot), chips and actions on the right with `margin-inline-start: auto`. Subtext that still overflows on its own line truncates to one line with an ellipsis and its full text in the tooltip. One rule for every row; no page invents its own. Checked at 2000, 1280 and a narrow width that shows the wrap.

**Card (board).** `--r-m`, `--surface`, one hairline, padding 12. Title in Strong, at most two lines; id and chips in Caption on one line under it. No card moves on hover; it gets the hairline in `--accent` at 45 %. Only things that need a person (needs-you, blocked) get colour, and only on the left edge or one chip.

**Form.** One column, labels above fields in Caption `--muted`, fields 32 px tall (40 on touch), `--r-s`, `--field-bg`, 8 px between label and field, 16 between fields. Help text under the field in Caption. Errors in `--danger` with an icon and words, never colour alone. Buttons at the bottom right, primary last; the form is as wide as 560 px at most. The rule builder follows the list rules: each condition is a row, the AND / OR joiner is a 24 px column to the left of every row with the same centre line as the row, so the chips line up whatever the row's height.

**Empty state.** Centred in the space, one 32 px line-icon in `--muted`, one Heading line, one Body line, at most one button. Written as "Nothing here yet. [what makes it]." Never an empty table frame.

**Chips and badges.** 20 px tall, Caption, `--r-s`, tint of the meaning colour at 14 % with its text at full. No chip carries both an icon and a colour for the same fact.

**Menus, popovers, toasts, command palette.** `--r-m`, `--panel`, hairline, the only shadow in the app, 8 px padding, items 32 px. Toasts: see Toasts below.

**Settings window.** One size whatever the tab (kept from INT-469): tabs on the left as the side menu, content as a form.

## Colour: sparingly, with meaning

The page is neutral. **Accent is for the one thing to do** (the primary button, the current item, focus) and appears once or twice per screen. Meaning colours are only these, and only in chips, dots and edges: `--ok` done and healthy, `--warn` waiting or stale, `--danger` failed or blocked, `--accent-2` live (an agent working). Ticket types (`--task`, `--issue`, `--spike`) are a 6 px dot, not a tinted card. Text is `--text` or `--muted`; nothing else. Every text colour clears 4.5:1 on its surface in both themes; the focus ring is 2 px `--accent` with a 2 px offset and is never removed.

## Motion

Ease in/out (`--ease-io`) for state change, `--ease` for things that arrive. 120 ms for hover and focus, 200 ms for panels and menus, 280 ms at most for anything else. Fade and 4 px slide only; no spring, bounce or overshoot (`--spring` is removed). Nothing moves on hover. All of it off under `prefers-reduced-motion`, leaving the final state.

## The bit of fun

Professional is the frame; fun is small and earned. Allowed, one per page: a live dot that breathes (2 s, 6 % scale), an agent's own glyph and colour on its card, a short and friendly empty-state line, a confetti-free "done" check that draws itself in 200 ms. Not allowed: decoration that carries no information, animated backgrounds, emoji in headings.

## How we will check

Each page gets its own commit with before/after at 1280, 375 and (section pages) 2000 px, in Clear and Clear Dark; contrast measured; Tab through it once; no new colour, size, radius or gap outside this file. A stylesheet check in the test suite will count distinct font sizes and radii so the language cannot drift back.

## Decisions for James

1. **Five type sizes and 12 px minimum** removes the tiny 7.5–11 px text. Some dense rows (agent logs, badges) will lose a little density. OK?
2. **Shadows only on floating things.** Cards lose their soft shadow in Clear and use a hairline. OK?
3. **Side menu 240 px with an accent bar** instead of a filled current item. OK?

## Form controls: one family

Every control shares one skeleton, so a row of mixed controls lines up. Imported themes recolour them through `--bg`, `--surface`, `--text`, `--border`, `--accent`, `--danger` and change nothing else. The mockup sheet `docs/design/controls.html` shows each control at rest, hover, focus, filled, disabled and in error, in Clear, Clear Dark and one imported palette; it uses only these tokens.

| Part | Rule |
|---|---|
| Height | 32 px (40 on touch, `pointer: coarse`); compact 24 px for table cells. Text areas start at 3 rows. |
| Shape | `--r-s`, `--field-bg`, `1px solid var(--border)`, padding 0 12 (8 compact), Body type. |
| Hover | Border to `color-mix(--text 30%, --border)`. Nothing moves, no shadow. 120 ms `--ease-io`. |
| Focus | Border `--accent` plus the 2 px `--accent` ring with 2 px offset (`:focus-visible`); never removed. |
| Disabled | 50 % opacity, `not-allowed`, no hover. The reason goes in the tooltip or help text. |
| Error | Border `--danger`, a 16 px alert icon and the words under the field in `--danger`, `aria-invalid`. Never colour alone. |
| Placeholder | `--muted`, at least 4.5:1 like any text. |

- **Text, number, date.** One look. Number: no browser spinner; quiet − / + buttons (24 px) at the right edge, shown on hover and focus; tabular figures. Date: the same field with a 16 px calendar icon; the popup is a month grid in a menu.
- **Select and menu.** The field with a 16 px chevron; opens a menu under it (see Menus), 32 px items, the chosen one with a check, keys: arrows, type-ahead, Esc. Never the native popup.
- **Checkbox and radio.** 16 px, `--r-s` (radio round), `--field-bg`, hairline. Checked: `--accent` fill, mark in `--on-accent`; the mark is a 10 px SVG check centred in the box by the grid (a rotated border sits off-centre) and draws in 120 ms. The label is the click target, 32 px tall.
- **Switch.** 32 × 18 track, 14 px knob; off `--border`, on `--accent`; the knob slides 120 ms ease, no bounce. The label stays the same when it flips.
- **Segmented choice.** For 2–4 short exclusive options: one 32 px bar, `--r-s`, hairline separators. Chosen: `--surface` with a 2 px `--accent` underline, bold. No pills.
- **Slider.** 4 px `--border` track, `--accent` fill, 16 px `--surface` knob with a 1 px `--accent` ring, value in Caption at the right. Arrows step 1, PageUp/Down step 10.
- **Colour picker.** A 32 px field: round 20 px swatch, the hex in mono, chevron. Opens a popover with a saturation square, a hue strip, a row of theme swatches (`--accent`, `--ok`, `--warn`, `--danger`, `--accent-2`) and the hex input. The native `<input type=color>` stays underneath as the fallback.
- **Emoji / glyph.** A 32 px square button showing the glyph (empty: dashed outline and a plus). Opens a menu with search and a grid of 32 px cells, recent first, Clear at the bottom. One grapheme only.
- **Buttons.** 32 px, `--r-s`, Body at weight 500, icon 16 px with an 8 px gap. Primary: `--accent` fill (once or twice per screen). Default: `--surface` and hairline. Quiet: no border or fill, `--hover` on hover. Danger: a default button with `--danger` text and ring, filled only on the confirm step. Icon-only: 32 px square with a tooltip. Busy: label stays, a 14 px spinner replaces the icon, clicks ignored. Press deepens `--hover`; nothing scales.

## Toasts

- **Where.** Bottom right, 16 px from the edges (24 from 1280 px), stacked upward with the newest at the bottom, at most three; a fourth pushes the oldest out. Bottom centre sat over the board's own actions and the bulk bar; the right corner is the one place nothing lives. With the ticket drawer or a side panel open the stack moves left of it by its width (`--drawer-w`, 0 when closed); the side menu is on the left and never meets it. Under a modal a toast stays above its backdrop and clear of its buttons. At 375 px the toasts are full width minus 16 px each side, above the bottom edge and above any bottom bar.
- **Look.** The menu family: `--r-m`, `--panel`, hairline, the floating shadow, 40 px tall at least, 12 px left padding, Body type. The meaning is a 6 px dot (`--ok`, `--danger`, `--accent-2`, `--accent`), never a tinted fill or an edge bar. An action is a Quiet button; every toast has a 32 px Dismiss button. Text is `--text`, so it holds in any theme. It fades in with a 4 px rise in 200 ms and out in 120 ms; under reduced motion it only fades.
- **How long.** Information 4 s, with an action 8 s, errors stay until dismissed. All pause while hovered or focused. The progress bar is dropped: the dot is enough. The same message twice shows once with a count.
- **Imported themes.** Their `toast` style option keeps working for the look (glass, texture); the place and the timing are the app's.

## Colour audit

Clear and Clear Dark clear every check. The 40 imported themes (`themes/*.css`, measured by `scripts/audit-theme-contrast.mjs` on each `:root`) do not: 29 miss at least one. Themes that miss: muted text under 4.5:1 on its surface 24, `--warn` as text 20, `--danger` 17, `--ok` 16, `--accent` as text 13, white text on the `--accent` fill 9. Worst: Soft and Cloud (warn 2.0 and 2.1, ok 2.1 and 2.3), then Riso, Tide and Pop.

So the language does not ask a theme to be perfect; it guards the places that matter:
1. **Meaning colours are never body text.** `--ok`, `--warn`, `--danger`, `--accent-2` appear as dots, icons, edges and 14 % chip tints, with the chip's words in `--text`.
2. **Text on an accent fill** uses `--on-accent`: near-white or near-black, whichever has the higher contrast with `--accent`, worked out when the theme is applied. A theme may set its own.
3. **Muted text** gets a floor when applied: if `--muted` is under 4.5:1 on `--surface` or `--bg`, it is mixed toward `--text` until it clears. The theme file is not changed.
4. **Accent as text** (links, the current item's name) is `--text` with the accent in an underline or bar, unless `--accent` clears 4.5:1.
5. **Complementary colour:** one accent and one live colour (`--accent-2`); the type colours are 6 px dots; no other hue on a page.
