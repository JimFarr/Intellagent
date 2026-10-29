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
  "events": [{ "id": "issue_closed", "label": "An issue is closed", "fields": ["key", "by"] }]
}
```

- **name**: lower-case letters, digits and `-`, starting with a letter, at most 40; it must match the folder's name.
- **entry**: the file to run, inside the folder (default `index.js`).
- **connection**: what the human fills in once. Field types are `text markdown number boolean enum tags date url` (`enum` and `tags` take `options`). Mark passwords and tokens `"secret": true`: the board never shows them again (only their last four characters) and never puts them in a file you can read.
- **actions**: what agents and rules can run. Each `id` becomes a permission, `plugin.<name>.<id>`, that only the human grants, and may narrow (`where` on input values) or make wait for their OK. `inputs` use the same field types. `timeoutSec` is 1 to 300 (default 30).
- **events**: what your plugin can tell the board happened; rules can start from them. Name the `fields` the event's data carries.
- **hosts**: the hosts you call. The human sees the list before enabling the plugin. It is shown, not enforced, so list every one honestly.
- **needs**: only if you must: `{ "childProcess": true }` to start programs, `{ "read": ["C:/abs/folder"] }` to read outside your folder. The human sees these too, and the board's own folders are never allowed.

## The channel

The board starts your entry with node and talks to it over **stdin and stdout, one JSON object per line**. Anything you print that is not one JSON object per line is ignored; use stderr for logs (the board keeps the tail, and `plugin_try` shows it).

The board sends calls:

```
{ "id": "…", "type": "test", "connection": { … } }
{ "id": "…", "type": "run", "action": "comment", "inputs": { "text": "…" }, "ticket": { "id", "title", "fields", "properties" }, "connection": { … } }
```

You answer each call once, with its `id`:

```
{ "id": "…", "ok": true, "result": { … } }
{ "id": "…", "ok": false, "error": "a plain message the human can act on" }
```

- **test** is the human's *Test* button: reach the service with the connection and say who it signed in as (`result: { message }`).
- **run** carries `ticket` when the run is for a ticket: its id, title, fields and properties. It is all you get of the board, so take what you need from it (an issue key in the title, a field).
- The connection comes **with every call**, never through the environment or a file.
- Calls can overlap: answer each by its `id`, in any order. A call not answered within the action's `timeoutSec` fails, and the board restarts your process.
- To raise an event: `{ "type": "event", "event": "issue_closed", "data": { "key": "TR-12", "by": "ann" } }` (an event you declared, data up to 10 KB, at most 60 a minute).

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

It answers `{ ok, result | error, events, stderr, sandboxed }`. `sandboxed` says whether it ran under the permission model: on a node older than 23.5 it runs without it, and the board would refuse to run it at all. Use a test account or a stand-in server for the connection, never a person's own password.

## Handing it over

Give the human the folder (or a .zip of it). On the board: **Integrations › Add plugin** shows what it asks for (secrets, hosts, actions, events, needs) before anything runs; then **Enable**, the **connection** form and **Test**; then each action is granted per agent in **Agents › Assignments**. The `examples/plugins/jira` folder is a complete plugin to copy from.

## The example to copy: Jira

`examples/plugins/jira` is a complete plugin: one `plugin.json`, one `index.js`, no dependencies (node's `fetch` makes the calls). It moves a Jira issue to a status, comments on it, assigns it and creates issues, against Jira Data Center or Server, signed in as one service account. It is not installed on any board until the human adds it. A ticket's issue is its `jira` field, else the first key such as `BET-12` in its title (one with the board's own prefix is skipped).

To try it with no Jira at all, start the stand-in, `node test/fake-jira.js 7599` (service account `svc` / `s3cret`, project `BET`), and point `plugin_try` at the folder with that address in the connection. Its tests are in `test/jira-plugin.test.js`.
