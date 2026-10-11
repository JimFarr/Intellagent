# {{APP}} — agent guide

A kanban board shared between a human and agents. **The board is the conversation**: the human edits tickets, comments, and answers your questions here instead of re-prompting you. Read it, act on it, write back to it.

Base URL: `{{BASE}}`  ·  index: `GET /api`  ·  schema: `GET /api/schema`

## 0. Rules of the road

1. **Identify yourself** on every request: header `X-Agent: <your-name>` (or `?agent=<name>`). Use one stable name per agent.
2. **Read the standing rules first**: `GET /api/boards/main/directives`. They are the human's instructions; they outrank your defaults.
3. **Lease before you work** on a ticket, renew while working, release when done.
4. **Ask, don't guess**: raise `needsHuman` when blocked on a decision. Then wait for the answer event.
5. **Never write `data/` files directly.** They are read-only on purpose. The API is the only writer.
6. Tickets are never deleted — archive them.

## 1. Orient (cheap)

```
GET /api/boards                          → list boards
GET /api/boards/main/summary             → columns + one-line items (cheapest overview)
GET /api/boards/main/hash                → { hash } — compare to detect any change
GET /api/boards/main/columns/Review/items
GET /api/boards/main/items/INT-12        → everything: description, comments, attachments, lease, properties
```

Column references accept the id (`in-progress`) or the name (`In Progress`). Item ids are case-insensitive.

## 2. Create and change work

```
POST  /api/boards/main/items             { "title": "…", "column": "Backlog", "type": "task|issue|spike",
                                           "priority": "Low|Medium|High|Critical", "parent": "auth",
                                           "description": "markdown", "properties": { "estimate": 3 },
                                           "blockedBy": ["INT-4"] }
PATCH /api/boards/main/items/INT-12      { "priority": "High", "properties": { "risk": "low", "old": null }, "version": 7 }
POST  /api/boards/main/items/INT-12/move { "column": "Review", "beforeId": "INT-9" }   // or "position": 0 | "top" | "bottom"
POST  /api/boards/main/items/INT-12/comments    { "body": "markdown, @mention someone" }
POST  /api/boards/main/items/INT-12/attachments { "path": "C:/abs/path/screenshot.png" }  // or dataBase64 / url
POST  /api/boards/main/items/bulk        { "ids": ["INT-1","INT-2"], "patch": { "column": "Done" } }
POST  /api/boards/main/archive           { "ids": ["INT-1"], "reason": "duplicate" }
POST  /api/boards/main/archive/INT-1/restore
```

- `properties` is your free-form property bag — **merged** on PATCH; set a key to `null` to delete it; `"replaceProperties": true` to replace wholesale.
- Send `"version"` (from your last read) on PATCH to avoid overwriting the human's concurrent edits → `409` means re-read and retry.
- Columns have flags. `allowCreate:false` → `403` on create; `allowMoveIn/Out`, `wipLimit` (hard cap → `409`). Read them via `GET /columns`.
- Unknown PATCH fields are rejected with a hint — custom data goes in `properties`.

## 2b. Ticket schema — design what a ticket holds

Each board has a schema. **Declare typed fields** for the data your task needs; the UI renders proper controls for them and can show them on the card.

```
GET   /api/boards/main/schema
POST  /api/boards/main/schema/fields   { "key": "risk", "label": "Risk", "type": "enum",
                                         "options": [{ "value": "low", "color": "#4cc38a" }, "medium", { "value": "high", "color": "#ff5d73" }],
                                         "stub": "top", "ui": "edit", "icon": "flag", "help": "Blast radius if this goes wrong" }
PATCH /api/boards/main/schema/fields/risk   { "stub": "meta" }
DELETE /api/boards/main/schema/fields/risk  (definition removed; stored values are kept)
PUT   /api/boards/main/schema          { "builtins": { "priority": { "ui": "hidden" }, "blockedBy": { "ui": "read", "label": "Waiting on" } } }
PATCH /api/boards/main/items/INT-12    { "fields": { "risk": "high", "estimate": 3, "reviewed": true } }   // null clears
```

- Types: `text markdown number boolean enum tags date url user`. `number` accepts `min`/`max`; `enum`/`tags` take `options` (tags without options are free-form). `required` and `default` apply on create.
- `ui`: `edit` (humans can change it), `read` (humans see it but **only agents/API can change it**), `hidden` (API only).
- `stub`: `none` | `top` (badge beside the id) | `meta` (chip in the card footer).
- Built-ins (`type priority parent description blockedBy attachments cover properties`) take `{ ui, stub, label }`. `blockedBy` defaults to `ui: "read"`.
- Wrong types or unknown enum values → `400` listing what's allowed. Undeclared keys → `400`; use `properties` for ad-hoc data.
- Search fields with `fields.<key>` paths or `?f.<key>=value`; subscribe to changes with `fields=fields.risk`.

Card image: `PATCH … { "cover": "auto" | "none" | "<attachment id>" }` (auto = first image).
Comments can carry files: `POST …/comments { "body": "see screenshot", "attachments": [{ "path": "C:/abs/shot.png" }] }`.

## 2c. Your look

Make yourself recognisable on the board (avatars on cards, comments, leases, the agents panel):

```
PATCH /api/profiles/me   { "color": "#2fe0c4", "glyph": "🛠", "label": "Builder (backend)",
                           "description": "I implement backend tickets in /api. I pick up work from **Ready**." }
PATCH /api/profiles/me   { "imagePath": "C:/abs/avatar.png" }    // or "imageBase64", or "image": "https://…"; null clears
GET   /api/profiles
```

## 3. Leases (locks)

```
POST   /api/boards/main/items/INT-12/lease   { "minutes": 30 }   → claim, or renew if you already hold it
DELETE /api/boards/main/items/INT-12/lease                       → release
```

- While you hold a lease, **other agents** get `423 Locked` on writes to that ticket. Humans can always edit (and may revoke your lease).
- Renew before expiry. You receive `lease.warning` ~5 minutes before, then `lease.expired`.
- Moving into a column with `releaseLeaseOnEnter` (e.g. Done) releases automatically.
- **Say what you're doing** while you hold the lease — it shows live on the card (doesn't bump `version`):
  `PUT /api/boards/main/items/INT-12/status { "status": "running tests 4/12" }` (or pass `status` when claiming).

### Request review (preferred way to finish)
`POST /api/boards/main/items/INT-12/review { "summary": "What changed and how to verify" }` — moves it to the review column, comments your summary, releases your lease and raises a **review** request. The human approves (it moves on through the gate) or sends feedback (it comes back one column with their comment). Watch for `attention.resolved` addressed to you.

### Daily digest
At the end of a session: `POST /api/boards/main/digest { "summary": "markdown", "items": ["INT-12"] }`. Read what others wrote with `GET /api/boards/main/digest?days=3` — a cheap way to catch up.

### Approval gates
Columns with `humanOnlyIn` / `humanOnlyOut` can only be entered / left by a human (`403` for agents). By default **Done** is human-only: move finished work to **Review** and let the human accept it.

### Handoffs
`PATCH … { "assignee": "other-agent" }` hands a ticket over; the assignee receives its events (`for=<name>` / `assignee=<name>`).
When a ticket's last open blocker reaches the final column (or is archived), its watchers get `item.unblocked`.

## 4. Talk to the human

```
POST   /api/boards/main/items/INT-12/attention  { "reason": "Rotate refresh tokens on every use, or only on expiry?" }
DELETE /api/boards/main/items/INT-12/attention  { "reply": "…" }   (normally the human does this)
```

The ticket glows on the board. The human's answer arrives as an `attention.resolved` event with `reply`, addressed to you.

## 5. Events — know when things change

Every change emits an event with an increasing `seq`. Each event lists `recipients`: the leaseholder, whoever asked for help, the agent author, and @mentions. **`for=<your-name>` is your inbox.**

```
GET /api/events/wait?since=<seq>&for=my-agent&timeout=25     ← long-poll: returns as soon as something matches
GET /api/events?since=<seq>&board=main&types=item.created     ← immediate, for catching up
GET /api/stream?board=main&agent=my-agent                     ← Server-Sent Events (curl -N)
```

Response: `{ "events": [...], "cursor": 812 }` → pass `cursor` as `since` next time.

Filter keys (all optional, AND-ed): `board`, `types` (comma list, `lease.*` wildcard), `itemId`, `column` (destination column), `claimant`, `for`, `itemType`, `parent`, `fields` (changed fields, e.g. `priority,properties.risk`; `properties` = any property), `actorKind`, `excludeActor` (skip your own echoes).

**Durable subscriptions** keep the cursor for you — the simplest loop:

```
POST /api/subscriptions                 { "label": "my inbox", "filter": { "for": "my-agent" } }  → { "id": "sub_…" }
GET  /api/subscriptions/sub_…/next?timeout=25    → new events since last call (advances the cursor)
```

Typical recipes:

| Want | Filter |
|---|---|
| New tickets landing in Ready | `types=item.created,item.moved&column=Ready` |
| Anything touching my tickets | `for=my-agent` |
| Priority or risk changes | `fields=priority,properties.risk` |
| All spikes | `itemType=spike` |
| My lease warnings | `types=lease.*&claimant=my-agent` |
| Handed to me | `types=item.assigned,item.unblocked&for=my-agent` |
| What another agent did | `actor=other-agent` (add `tail=true` on `/api/events` for the newest) |

### Permissions & tokens
The manifest may restrict agents (`permissions: { "<name>" | "*": { "columns": ["Backlog","Ready"], "readOnly": false } }`) and require tokens (`auth.agentTokens`). Check yours with `GET /api/permissions/me`; send tokens as `Authorization: Bearer <token>`.

### Git
`node intellagent/git-hook.js install` links commits that mention `INT-12` to that ticket. `node intellagent/git-hook.js sync-ci` fills a `ci` field from GitHub checks for tickets with a `pr` URL (needs `gh`).

## 6. Search

```
GET  /api/search?board=main&q=login&type=issue&prop.risk=high&prop.score=gte:3&claimant=exists:true
POST /api/search  { "board": "main", "q": "token", "where": { "properties.risk": "high",
                    "priority": { "in": ["High","Critical"] }, "blockedBy": { "exists": true } },
                    "sort": "priority", "order": "desc", "includeArchived": true, "full": false }
```

Operators: `eq ne in nin contains gt gte lt lte exists regex`. Any dotted path works, including `properties.<key>`. Virtual fields: `column`, `claimant`, `authorName`, `authorKind`, `archived`. Results are compact unless `full: true`.

## 7. Boards, columns, white-label

```
POST  /api/boards                         { "name": "Refactor", "idPrefix": "REF", "template": "default|simple|empty" }
POST  /api/boards/main/columns            { "name": "QA", "color": "#f2a541", "icon": "eye", "position": 3,
                                            "flags": { "allowCreate": false, "wipLimit": 3 } }
PATCH /api/boards/main/columns/QA         { "flags": { "allowCreate": true } }
PUT   /api/boards/main/directives         { "directives": "markdown" }
PATCH /api/app                            { "name": "Acme Ops" }
GET   /api/presence                       → who is connected, their leases and subscriptions
```

Columns can only be created by agents (the UI can't). Custom flags are stored as-is.

## 8. Shell tips

- If `intellagent` is on PATH (it finds this project's board automatically):
  `intellagent api GET /api/boards/main/summary`, `intellagent api POST /api/boards/main/items '{"title":"x"}'`, or pipe JSON with `-`.
  Set `INTELLAGENT_AGENT=<your-name>`. Without the global command: `node <install>/cli.js …`.
- Windows PowerShell: use `curl.exe`, not `curl`; quoting JSON is painful, so prefer the CLI.
- MCP clients: `node intellagent/mcp.js` exposes all of this as tools.

## 9. A good working loop

```
1. GET directives + summary
2. Pick a ticket → POST lease (with a status) → comment "picking this up"
3. Work. Renew the lease every ~20 min. Comment progress; attach screenshots.
4. Unsure? POST attention, then GET /api/events/wait?for=<you>&types=attention.resolved,comment.added
5. Done → `POST …/review` with a summary (Done itself is human-only).
6. End of session → `POST …/digest`.
7. GET /api/subscriptions/<id>/next to see what the human changed meanwhile.
```
