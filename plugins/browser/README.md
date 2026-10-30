# Browser

Gives each agent its own headless Chrome, so it can look at its own build. Off until the human enables it on **Integrations**.

- `start { url, width?, height?, theme? }`: launches the calling agent's browser (a fresh profile, `width`×`height`, default 1280×800, `light` or `dark`) opened at `url`, on a port of its own (9400–9499, the same each time), and answers `{ devtools, port, attach }`. Starting again with the same size and theme opens `url` in a new tab; another size or theme restarts it. Headless Chrome keeps its window at least 500 wide, so `width` starts at 500: for a 375 px look, resize the page with the browser tool (Playwright's `browser_resize` sets the page's size over DevTools, which goes below 500).
- `stop`: closes it. A browser whose pages haven't changed for the idle time (connection, default 15 minutes) closes itself, and disabling the plugin closes them all.

**Grants**, per agent in **Agents › Assignments**: `plugin.browser.start` scoped on `url` to the sandbox ports, e.g. `{ "power": "plugin.browser.start", "where": { "url": ["http://127.0.0.1:743*", "http://127.0.0.1:744*"] } }`, and `plugin.browser.stop`.

**Driving it**: the agent's Playwright MCP attaches to its browser instead of launching one. In the agent's MCP config:

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest",
  "--cdp-endpoint", "http://127.0.0.1:<its port>",
  "--blocked-origins", "http://127.0.0.1:7420;http://127.0.0.1:7421;http://127.0.0.1:7499"] } } }
```

The grant's `url` scope covers only the page the browser opens at (an address with a user name, `http://127.0.0.1:7431@…`, is refused). After that, the blocked origins are what keep the real boards and the lease program out of reach. They live in this config, which the board neither writes nor checks, so check them when you set an agent up.

**Connection**: `chrome`, the program to launch (empty: Chrome's usual place), and `idleMinutes`. *Test* launches a throwaway browser and says which Chrome answered.

It launches Chrome, a program outside the plugin sandbox (`needs.childProcess`). Its tests use `test/fake-chrome.js` in its place.
