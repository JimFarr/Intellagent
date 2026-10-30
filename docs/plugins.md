# Writing an Intellagent plugin

A plugin connects the board to another service (an issue tracker, a chat, a CI system). It is a folder with a `plugin.json` and its code. The human adds the folder on the board's **Integrations** page, enables it, fills in its connection and grants its actions to agents; from then on agents and rules can run those actions. Nothing in this guide touches a board: you write and try the plugin on its own.

**Tools.** The `intellagent-plugins` MCP server (`intellagent plugin-mcp`, or `node plugin-mcp.js`) does the work below:

| Tool | What it does |
|---|---|
| `plugin_guide` | This page. |
| `plugin_new { dir, name, label?, actions?, connection? }` | A working skeleton in `<dir>/<name>`: `plugin.json`, an `index.js` that already speaks the channel, a `README.md`. |
| `plugin_check { path }` | Checks the folder as the board does when it is added (`plugin.json`, the entry file) and that the entry parses. |
| `plugin_try { path, type, action?, inputs?, connection?, ticket? }` | Runs the plugin as the board does (sandboxed, no environment) and sends it one `test` or `run` call. Returns the reply, the events it raised and what it printed to stderr. |

The loop: `plugin_new` → write the actions in `index.js` → `plugin_check` → `plugin_try` with `type: "test"`, then each action with `type: "run"` → hand the folder to the human.

## plugin.json

```json
{
  "name": "tracker",
  "label": "Tracker",
  "version": "0.1.0",
  "description": "Moves and comments on Tracker issues for the board's tickets.",
  "entry": "index.js",
  "hosts": ["tracker.example.com"],
  "connection": [
    { "key": "url", "label": "Address", "type": "url", "required": true },
    { "key": "token", "label": "API token", "type": "text", "secret": true, "required": true }
  ],
  "actions": [
    { "id": "comment", "label": "Comment on the issue", "help": "Posts the text on the ticket's issue",
      "timeoutSec": 30, "inputs": [{ "key": "text", "label": "Text", "type": "markdown", "required": true }] }
  ],
  "events": [{ "id": "issue_closed", "label": "An issue is closed",
               "fields": [{ "key": "key", "type": "text" }, { "key": "by", "type": "text" }, { "key": "points", "type": "number" }],
               "ticket": { "field": "key", "matches": "fields.tracker" } }]
}
```

- **name**: lower-case letters, digits and `-`, starting with a letter, at most 40; it must match the folder's name.
- **entry**: the file to run, inside the folder (default `index.js`).
- **connection**: what the human fills in once. Field types are `text markdown number boolean enum tags date url` (`enum` and `tags` take `options`). Mark passwords and tokens `"secret": true`: the board never shows them again (only their last four characters) and never puts them in a file you can read.
- **actions**: what agents and rules can run. Each `id` becomes a permission, `plugin.<name>.<id>`, that only the human grants, and may narrow (`where` on input values) or make wait for their OK. `inputs` use the same field types. `timeoutSec` is 1 to 300 (default 30).
- **events**: what your plugin can tell the board happened; rules can start from them. Its `fields` are typed like an action's inputs (a bare name is a text field); the board keeps only the declared fields whose values fit. `ticket` links the event to a board ticket: the one whose `fields.<key>` (or `properties.<name>`) equals the event's `field`.
- **webhook**: `true` if the service should call the board: the board then takes requests at `/hooks/<name>` and hands each one to your plugin (see *Webhooks*).
- **hosts**: the hosts you call. The human sees the list before enabling the plugin. It is shown, not enforced, so list every one honestly.
- **needs**: only if you must: `{ "childProcess": true }` to start programs, `{ "read": ["C:/abs/folder"] }` to read outside your folder. The human sees these too, and the board's own folders are never allowed.

## The channel

The board starts your entry with node and talks to it over **stdin and stdout, one JSON object per line**. Anything you print that is not one JSON object per line is ignored; use stderr for logs (the board keeps the tail, and `plugin_try` shows it).

The board sends calls:

```
{ "id": "…", "type": "test", "connection": { … } }
{ "id": "…", "type": "run", "action": "comment", "inputs": { "text": "…" }, "by": { "kind": "agent", "name": "ann" }, "ticket": { "id", "title", "fields", "properties" }, "connection": { … } }
```

You answer each call once, with its `id`:

```
{ "id": "…", "ok": true, "result": { … } }
{ "id": "…", "ok": false, "error": "a plain message the human can act on" }
```

- **test** is the human's *Test* button: reach the service with the connection and say who it signed in as (`result: { message }`).
- **run** carries `ticket` when the run is for a ticket: its id, title, fields and properties. It is all you get of the board, so take what you need from it (an issue key in the title, a field). `by` says who asked (`kind`: `agent`, `user` or `system`, and a `name`), for a plugin that keeps something per agent.
- The connection comes **with every call**, never through the environment or a file.
- Calls can overlap: answer each by its `id`, in any order. A call not answered within the action's `timeoutSec` fails, and the board restarts your process.
- To raise an event: `{ "type": "event", "event": "issue_closed", "data": { "key": "TR-12", "by": "ann" } }` (an event you declared, data up to 10 KB, at most 60 a minute). When you know the board ticket's id, send it as `"item": "INT-12"` beside `data` (it wins over the event's `ticket` link): a rule then acts on that ticket.

## Rules: what the human does with your events and actions

The human writes rules on the board's Rules page; your plugin shows up in them twice.

- **A trigger:** `{ "on": "plugin_event", "plugin": "tracker", "event": "issue_closed" }`. The rule fires on every board for each event you raise, for the event's ticket (its `item`, else its `ticket` link) if it has one, else for no ticket: then ticket actions fail and the rule log says why. Its texts can quote the data: `{event.key}`, `{event.by}`.
- **An action:** `{ "do": "run", "plugin": "tracker", "action": "comment", "inputs": { "text": "{id} is done" } }`. The board runs it under the rule's name, with no agent's grant: board rules are the human's own. The run is in **Integrations › Runs** like any other.
- A rule's own changes never set off other rules, and a rule that fires more than 30 times an hour is held back. Your events are capped at 60 a minute. So an event your action causes can set off a rule again, but it cannot run away.

## Webhooks

With `"webhook": true` the board answers `POST /hooks/<name>` for the service you connect. The route has **no token**: anyone who can reach the board can call it, so your plugin decides what is genuine. You get one call per request:

```
{ "id": "…", "type": "webhook", "webhook": { "headers": { "x-signature": "…", … }, "body": "the raw body, as text" }, "connection": { … } }
```

- Check it: most services sign the body with a secret; keep that secret in a `"secret": true` connection field and compare the signature over `body` exactly as it came (that is why it is text, not parsed).
- Answer `{ "id", "ok": true, "result": { "event": "issue_closed", "data": { … }, "item"?: "INT-12" } }` to raise one of your events, `"result": null` to accept it and do nothing (a ping), or `{ "ok": false, "error": "bad signature" }` to refuse it (the caller gets 401).
- The board acts **only on the event you return**: never on the body. The event goes through the same checks as one on the channel (declared, the pin, 60 a minute); past that limit the caller gets 429 before your plugin is asked.
- Bodies are at most 256 KB. Cookies are never passed on. A plugin that is off, changed or has no webhook answers 404, the same as no plugin at all.
- The board must be reachable from the service: it listens on 127.0.0.1, so the human puts a proxy or tunnel in front of it and adds its name to `allowedHosts`.

## The sandbox

The board runs every plugin with node's permission model (Node 23.5 or later):

- it reads only its own folder and writes only its `data/` folder;
- it starts no programs and no workers, unless `needs` asks and the human allowed it;
- it gets **no environment**: no board address, no token, no `INTELLAGENT_*`. It cannot call the board; everything it needs arrives in the call.
- Network calls are allowed (node's `fetch`). There is no `npm install` step, so bring no dependencies outside your folder: plain node, or code vendored into the folder.

**The folder is pinned.** When the human enables a plugin, the board records a hash of every file in it (but `data/`). If any file changes, the plugin stops until the human enables it again. Keep state in `data/`, never next to your code.

## Trying it

`plugin_try` runs your plugin exactly as above and sends one call:

```
plugin_try { "path": "C:/work/tracker", "type": "test", "connection": { "url": "https://tracker.example.com", "token": "…" } }
plugin_try { "path": "C:/work/tracker", "type": "run", "action": "comment", "inputs": { "text": "Hello" },
             "ticket": { "id": "INT-12", "title": "TR-12 fix the odds feed", "fields": {}, "properties": {} },
             "connection": { … } }
```

A webhook: `plugin_try { "path": "…", "type": "webhook", "webhook": { "headers": { "x-signature": "…" }, "body": "{\"issue\":\"TR-12\"}" }, "connection": { … } }`.

It answers `{ ok, result | error, events, stderr, sandboxed }`. `sandboxed` says whether it ran under the permission model: on a node older than 23.5 it runs without it, and the board would refuse to run it at all. Use a test account or a stand-in server for the connection, never a person's own password.

## Handing it over

Give the human the folder (or a .zip of it). On the board: **Integrations › Add plugin** shows what it asks for (secrets, hosts, actions, events, needs) before anything runs; then **Enable**, the **connection** form and **Test**; then each action is granted per agent in **Agents › Assignments**. The `examples/plugins/jira` folder is a complete plugin to copy from.

## The example to copy: Jira

`examples/plugins/jira` is a complete plugin: one `plugin.json`, one `index.js`, no dependencies (node's `fetch` makes the calls). It moves a Jira issue to a status, comments on it, assigns it and creates issues, against Jira Data Center or Server, signed in as one service account. It is not installed on any board until the human adds it. A ticket's issue is its `jira` field, else the first key such as `BET-12` in its title (one with the board's own prefix is skipped).

To try it with no Jira at all, start the stand-in, `node test/fake-jira.js 7599` (service account `svc` / `s3cret`, project `BET`), and point `plugin_try` at the folder with that address in the connection. Its tests are in `test/jira-plugin.test.js`.

## The second example: Browser

`plugins/browser` gives each agent its own headless Chrome, which the agent's browser tool then attaches to: `start { url, width?, height?, theme? }` and `stop`. It shows three things the Jira plugin doesn't: `needs: { "childProcess": true }` (it launches Chrome), keeping something per agent with the run's `by`, and cleaning up after itself (what it started is recorded in `data/`, so the next process closes a browser the last one left). Its README has the grants and the attach config; its tests (`test/browser-plugin.test.js`) put `test/fake-chrome.js` in Chrome's place.
