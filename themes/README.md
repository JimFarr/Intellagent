# Themes

Clear and Clear Dark are built into the page. Every other look is a `.css` file you import in **Settings › Appearance › Import a theme**. The board keeps imported themes in its data folder (`data/themes/`) and every browser lists them. Only the human imports or removes one.

The files here are the themes that used to be built in. Import any of them, or copy one and change it.

## A theme file

```css
/* intellagent-theme
name: Dracula
mode: dark
style: {"cards":"clean","attn":"glow","bg":"stars"}
*/
:root {
  --bg: #21222c;
  --panel: #282a36;
  /* … the rest of the palette … */
}
.col-name { color: var(--accent); }
```

- **Header** (first comment): `name:` (the name in the list; importing the same name again replaces the theme), `mode:` (`light` or `dark`) and an optional `style:` line of JSON.
- **Palette**: `:root` must set these as `#rgb` or `#rrggbb`: `--bg --panel --surface --text --muted --border --accent --accent-2 --issue --task --spike --ok --warn --danger --blob1 --blob2 --blob3`. Also usable: `--shadow`, `--fx-o`, `--grain`, `--on-accent`, `--accent-fill` (text on, and the fill of, accent buttons; the page deepens the fill until the text reaches 4.5:1 when you leave them out).
- **Rules**: every other rule applies only while the theme is picked. Use the tokens (`var(--accent)`), not fixed colours where you can.
- **`style:`** sets the look options the Appearance pane offers (`cards`, `tape`, `attn`, `enter`, `lanes`, `bg`, `texture`, `md`, `avStyle`, `drop`, `groups`, `toast`, `shadow`, `typeInd`, `chips`, `heads`, `card`/`col`/`modal`/`ctl` radii, `bw`, `font`, `display`…). A choice made in Appearance wins over the theme's.
- **Safe by construction**: on import, `@import`, remote `url()` (only `data:` URLs stay) and backslash escapes are removed, so a theme cannot reach the internet. A file is at most 200 KB.

`node scripts/export-themes.js <themes.js> [folder]` wrote the files here from the old built-in table.
