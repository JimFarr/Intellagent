# Mid: the API, CLI and MCP surface

- Every route lives in `server.js` as `route(method, path, description, handler)`; the description is the API docs (`GET /api`), so keep it accurate.
- Errors go through `fail(status, message, { code, hint })`. Agents branch on `code` and follow `hint`: give both whenever a caller can do something about it.
- The CLI (`bin/intellagent.js`, `cli.js`) and the MCP tools (`mcp.js`) mirror the API. When you add or change a route, check whether either needs it too, and update AGENTS.md.
- Writes happen inside `tx(ctx, (events) => …)`: change state, push events, return. Never write `data/` files directly.
- Every new route or behaviour gets a test in `test/flows.test.js` (helpers in `test/helpers.js`).
