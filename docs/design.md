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

**Card (board).** `--r-m`, `--surface`, one hairline, padding 12. Title in Strong, at most two lines; id and chips in Caption on one line under it. No card moves on hover; it gets the hairline in `--accent` at 45 %. Only things that need a person (needs-you, blocked) get colour, and only on the left edge or one chip.

**Form.** One column, labels above fields in Caption `--muted`, fields 32 px tall (40 on touch), `--r-s`, `--field-bg`, 8 px between label and field, 16 between fields. Help text under the field in Caption. Errors in `--danger` with an icon and words, never colour alone. Buttons at the bottom right, primary last; the form is as wide as 560 px at most. The rule builder follows the list rules: each condition is a row, the AND / OR joiner is a 24 px column to the left of every row with the same centre line as the row, so the chips line up whatever the row's height.

**Empty state.** Centred in the space, one 32 px line-icon in `--muted`, one Heading line, one Body line, at most one button. Written as "Nothing here yet. [what makes it]." Never an empty table frame.

**Chips and badges.** 20 px tall, Caption, `--r-s`, tint of the meaning colour at 14 % with its text at full. No chip carries both an icon and a colour for the same fact.

**Menus, popovers, toasts, command palette.** `--r-m`, `--panel`, hairline, the only shadow in the app, 8 px padding, items 32 px. Toasts bottom centre, 8 s at most, never over the primary action.

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
