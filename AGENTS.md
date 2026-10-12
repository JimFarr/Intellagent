# {{APP}} — agent guide

A kanban board shared between a human and agents. **The board is the conversation**: the human edits tickets, comments, and answers your questions here instead of re-prompting you. Read it, act on it, write back to it.

Base URL: `{{BASE}}`  ·  index: `GET /api`  ·  schema: `GET /api/schema`

## Start here

```
GET /api/boards/main/brief        (CLI: intellagent brief · MCP: get_briefing)
```
One page: who you are, **what to do next**, the columns, templates, fields, rules and the exact calls for this board. Read it at the start of every session or run — it is generated from the live board, so it is never stale. The rest of this guide is reference.

The whole loop for one ticket:

| Step | Call | What it does |
|---|---|---|
| What needs me? | `GET …/work` | Next actions, your leases, answered questions, review feedback, assigned and ready tickets |
| Start / resume | `POST …/items/<ID>/start { status }` | Claims it, moves it to the working column, assigns you — all or nothing |
| Say what you're doing | `PUT …/items/<ID>/status { status }` | Live line on the card |
| Ask | `POST …/items/<ID>/attention { reason }` | Card glows; the answer comes back in `…/work` (`answered`) and as an event |
| Done | `POST …/items/<ID>/review { changed, why, verify, risks }` | Moves to review, releases your lease, asks the human — explain in four parts |
| Asked to explain | a comment with `intent: "explain"` (also first in `…/work`) | Answer in a comment; change nothing else |
| Verdict | (human) `review.approved` / `review.changes_requested` | Feedback shows in `…/work`; `start` again to address it |
| End of session | `POST …/finish { summary }` | Releases everything you hold, posts the digest |

Errors are `{ "error": "…", "code": "LEASED", "hint": "…" }`. Codes: `LEASED` `BOARD_HELD` `BLOCKED` `WIP_LIMIT` `HUMAN_ONLY` `VERSION_CONFLICT` `LEASES_ACTIVE` `UNKNOWN_FIELD` `NOT_FOUND` `UNAUTHORIZED` `FORBIDDEN` `BAD_REQUEST`. Branch on `code`, follow `hint`.

## 0. Rules of the road

1. **Identify yourself** on every request: header `X-Agent: <your-name>` (or `?agent=<name>`). Use one stable name per agent.
2. **Read the standing rules first**: `GET /api/boards/main/directives` returns the board's workflow rules **and** the project's own convention files (e.g. CLAUDE.md, under `projectRules`). Conventions live in the repo; the board only adds how to use the board. Never copy one into the other.
3. **Start before you work** (`POST …/start` leases the ticket for you), renew while working, request review when done — or, if you are the only agent, **hold the whole board** once (master lease, below).
4. **Ask, don't guess**: `POST …/attention` when blocked on a decision — allowed even on tickets others hold. The answer shows up in `GET …/work`.
5. **Never write `data/` files directly.** They are read-only on purpose. The API is the only writer.
6. Tickets are never deleted — archive them. The one exception is **test tickets**: created with `"test": true` (fixed at creation), they may be removed for good by anyone with `DELETE …/items/<ID>` (leases still apply; the human can clear them all with `DELETE …/test-items`). Use them for anything throwaway; they stay out of metrics, the digest and the receptionist's sweep.

## 1. Orient (cheap)

```
GET /api/boards/main/brief               → start here (markdown; ?format=json adds the work object)
GET /api/boards/main/work                → what needs you now, with "next" actions (?agent=<name> for another agent)
GET /api/boards/main/items/INT-12/transitions → where you may move it, and why not elsewhere
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

### Ticket templates
Presets for new tickets on this board ("Bug", "Feature"…). The human picks them in the UI; you pass `template`:

```
GET    /api/boards/main/ticket-templates
POST   /api/boards/main/items              { "template": "bug", "title": "Crash on save" }   // your values override the template's
POST   /api/boards/main/ticket-templates   { "label": "Bug", "type": "issue", "priority": "High", "column": "Triage",
                                             "description": "**Steps**\n1. ", "fields": { "risk": "medium" }, "help": "Something is broken" }
PATCH  /api/boards/main/ticket-templates/bug   { "priority": "Critical" }
DELETE /api/boards/main/ticket-templates/bug
```
Prefer a template when one fits — tickets then look the same whoever files them. Fields and properties merge key by key; everything else you pass wins.

### Tickets an agent writes up
The human can file rough notes with **Let the agent write it** (`POST …/items { "title": "…", "agentWrite": true, "explicit": ["priority"] }`). The ticket gets an `agentDraft` marker `{ writer, explicit, original }` and wakes the writer (the board's coordinator), whose `…/work` shows a `write` action. Rewrite the title, description (with an acceptance checklist), type, priority, fields, parent and blockers — but not the keys in `agentDraft.explicit`: the human set those on purpose, and the board answers `409 EXPLICIT` if you touch them. A human edit while the draft is pending adds its keys to `explicit`. Quote the original title and description in a comment, then send `"agentDraft": null` with your rewrite to clear the marker.

Card image: `PATCH … { "cover": "auto" | "none" | "<attachment id>" }` (auto = first image).
Comments can carry files: `POST …/comments { "body": "see screenshot", "attachments": [{ "path": "C:/abs/shot.png" }] }`.

## 2c. Who you are

New agents introduce themselves before working: ask the human (in one message) for your **name** (blank = pick a friendly one from `GET /api/names/suggest`), **role** (coordinator, builder, reviewer, researcher, writer…), **alignment** (how to behave) and anything to avoid. Save it with `PATCH /api/profiles/me { "role": "…", "alignment": "…", "description": "…" }` (MCP: `introduce_yourself`, which also switches the session to the new name). Until you have a role, `…/brief` starts with these questions.

## 2d. Your look

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

### Start work in one step
`POST /api/boards/main/items/INT-12/start { "status": "reading the code", "minutes": 30 }` checks the ticket isn't held or blocked, leases it to you (not needed while you hold the master lease), moves it to the working column (flag `working`; e.g. In Progress) unless it is already there or further, and assigns it to you. If any check fails nothing changes and you get a `code` (`LEASED`, `BLOCKED`, `WIP_LIMIT`, `BOARD_HELD`). Pass `"force": true` to start a blocked ticket, `"column"` to pick the target. The reply includes `feedback` (if the review sent it back) and `lastAnswer` (your last question's answer).

### Explaining your work
Reviews explain themselves in four parts: `changed` (what changed), `why` (the reasoning, and alternatives you rejected), `verify` (how the human can check it) and `risks` (risks and open questions). The review card shows each part in full. A single `summary` still works.
When the human wants more, they **Ask why** — a comment with `intent: "explain"`, addressed to you if it @mentions you or, if not, to whoever requested the review or last worked the ticket. It arrives as an `[EXPLAIN ONLY]` event and tops your `…/work`. Answer in a comment and change nothing else: not the code, the ticket, its column or the review — the review stays open while they read your answer.

### Request review (preferred way to finish)
`POST /api/boards/main/items/INT-12/review { "summary": "What changed and how to verify" }` — moves it to the review column, comments your summary, releases your lease and raises a **review** request.
The human decides with `POST …/review/decision { "verdict": "approve" | "changes", "comment": "…" }` (human only): approve moves it through the gate; changes moves it back to the working column. Moving a ticket with an open review into an approval gate (e.g. dragging it to Done) counts as approve. You receive `review.approved` or `review.changes_requested` (with `feedback`), and `GET …/work` lists it under `feedback` until you `start` it again.

### End a session
`POST /api/boards/main/finish { "summary": "markdown", "items": ["INT-12"] }` releases every lease you hold (and the master lease) and posts the summary to the digest. Standing-agent runs that exit cleanly get this release automatically.

### Metrics
`GET /api/boards/main/metrics?days=7` (or 30): tickets done (and the previous window), median cycle time (working column → done), median time in each column, open questions and how long the oldest has waited, and how fast the human answers. The UI shows it as a strip under the top bar.

### Daily digest
At the end of a session: `POST /api/boards/main/digest { "summary": "markdown", "items": ["INT-12"] }`. Read what others wrote with `GET /api/boards/main/digest?days=3` — a cheap way to catch up.

### Approval gates
Columns with `humanOnlyIn` / `humanOnlyOut` can only be entered / left by a human (`403` for agents). By default **Done** is human-only: move finished work to **Review** and let the human accept it.

### Grants: powers the human delegates
Some agents may do human-only things because the human said so in **agents.json** (or the manifest's `permissions.<name>.grants`) — never through the API:
```jsonc
"approver":   { "role": "reviewer", "grants": ["review.decide"] },
"gatekeeper": { "enabled": false, "grants": [{ "power": "column.gate", "where": { "column": "Done", "fields.risk": "low" } }] }
```
- `review.decide` — `POST …/review/decision`; the verdict is final, moves the ticket on, and is recorded as delegated (`review.delegated`, the event's `delegated`, a note in the comment).
- `column.gate` — move tickets into / out of human-only columns (a ticket with an open review must be decided instead: `409 REVIEW_OPEN`).
- `agents.control` — pause / resume / run *other* standing agents. Defining agents and grants stays with the human.
- `where` limits a grant to tickets matching every key (`column`, or any dotted path such as `fields.risk`, `properties.area`; a value or a list).
- Never on your own work: a ticket you worked on or whose review you requested → `403 OWN_WORK`. Out of scope → `403 OUT_OF_SCOPE`; no grant → `403 HUMAN_ONLY`.
- The human can override any delegated verdict or move. Grants in agents.json are re-read on change, so removing one takes effect at once. `GET /api/permissions/me` and your brief list yours; metrics count delegated decisions (`delegated`).

### Handoffs
`PATCH … { "assignee": "other-agent" }` hands a ticket over; the assignee receives its events (`for=<name>` / `assignee=<name>`).
When a ticket's last open blocker reaches the final column (or is archived), its watchers get `item.unblocked`.

### Asking for a ticket someone else holds
`POST …/items/<ID>/lease/request { "reason": "…" }` tells the holder. The holder (or the human) answers with `POST …/lease/handover { "to": "<you>", "note": "where I left off" }` — the lease moves to you in one step — or `POST …/lease/decline { "to": "<you>", "reason": "…" }`. Pending requests show up first in the holder's `…/work`. Requests are allowed even while the board is held.

### Working alone: the master lease
`POST /api/boards/main/master {}` holds the whole board until you release it (pass `minutes` for a time limit, `status` for a live line in the header). While you hold it you need no per-ticket leases and other agents are read-only — they can still comment, ask the human and post to the digest. It fails while other agents hold ticket leases. **Release it (`DELETE …/master`) before spawning helper agents**; they then use normal ticket leases. The human can revoke it at any time.

## 4. Talk to the human

```
POST   /api/boards/main/items/INT-12/attention  { "reason": "Rotate refresh tokens on every use, or only on expiry?" }
DELETE /api/boards/main/items/INT-12/attention  { "reply": "…" }   (normally the human does this)
```

The ticket glows on the board. The reply returns a `questionId`. A ticket can hold several open questions (from you and others); each is answered on its own and the answer arrives as an `attention.resolved` event with that `questionId` and `reply`, addressed to whoever asked — and in `GET …/work` under `answered`. Asking the same thing twice reuses the open question. The human answers one with `DELETE …/attention { questionId, reply }` (without `questionId`, every open question is closed).

**Where to ask.** While the human is actively chatting with you, quick back-and-forth belongs in chat. Anything that should outlive the conversation — a decision, an approval, a question raised while working unattended — goes on the card, so you never wait in one place while they answer in the other. If you asked in chat about a ticket, record the answer on the card.

**Reactions.** React to a card or a comment with an emoji — `POST …/items/<ID>/reactions { "emoji": "+1", "commentId": "c_…" }` (omit `commentId` for the card; names like `eyes`, `+1`, `tada`, `rocket`, `thinking`, `check` work; `DELETE` with the same body removes it). Reactions never wake anyone and are allowed even while others hold the ticket or the board. 👀 means "seen": it is added for you on comments you're woken for (standing agents and `intellagent wait`); add it yourself when you read a comment some other way. Use 👍 / ✅ for "done", 🤔 when you're unsure — then say why in a comment.

**What not to post.** Keep cards and the digest readable: no step-by-step progress logs, nothing git already shows (diffs, file lists), no restating the ticket. Post decisions, blockers, results and how to verify.

### Getting woken up
You only see board events when you look. Ways to make answers on cards reach you:
- **During a session:** run `intellagent wait --agent <you>` as a **background** command. It blocks until something arrives in your inbox, prints it and exits — your shell tool notifies you. It remembers its place, so nothing is missed between runs. Re-arm it after handling the events.
- **Standing agents (unattended, survives reboots):** the board itself starts a short headless run whenever events arrive for an agent defined in `.intellagent/agents.json`. Agents are disposable; the board keeps the queue. Details below.
- **Ad hoc:** `intellagent watch --agent <you> --claude` (or `-- <any command>`) does the same from a terminal you keep open.
- **Coordinating several agents:** add `--human` to `wait`/`watch` (or `"listen": "human"` for a standing agent) to hear about *everything* the human does on the board, not just your inbox — then delegate with `assignee` or a comment @mentioning a worker. `--filter "types=item.created&column=Ready"` takes any event filter.

### Standing agents
```jsonc
// .intellagent/agents.json — the human's file; commands only ever come from here, never from the API
{
  "defaults": { "maxRunsPerHour": 20, "maxFailures": 3, "timeoutMinutes": 60 },
  "agents": {
    "builder":     { "listen": "inbox", "description": "Implements tickets from Ready." },
    "coordinator": { "listen": "human", "run": "claude -p --permission-mode acceptEdits \"Handle the Intellagent events on stdin.\"" }
  }
}
```
- `listen`: `addressed` (default — wakes only when the event is *for* it: an @mention outside code/quotes, an assignment, a lease request or handover, an answer to its question, a verdict on its review, a request), `inbox` (also everything on tickets it worked on or commented on), `human` (everything the human does), `new-tickets` (tickets the human creates), an event filter object, or a list of these. The coordinator role uses `addressed` + `new-tickets`. Events that don't wake it still show in its inbox and `…/work`.
- **Work already on the board wakes it too.** On board start, on resume, after each run and every `sweepMinutes` (default 10), an idle agent checks for its waiting work (assigned and not started, answered questions, review feedback, open requests, lease requests) and gets one `work.pending` event listing it. With `pickup`, it also wakes for unassigned tickets: `"ready"` (or `true`) for the pickup columns, `"all"` for every open column. The coordinator role uses `"all"`, so the receptionist sees every unassigned ticket, not only new ones. Each piece of work wakes an agent once and again only after it leaves the list and comes back (e.g. reassigned), so leaving something alone never loops. Tickets waiting on the human never wake anyone.
- `run`: the command (default `claude -p …`). It gets the events as a prompt on stdin, `INTELLAGENT_AGENT`, `INTELLAGENT_URL` and `INTELLAGENT_EVENTS` (JSON file) in its environment, and runs in the project folder.
- **One run per agent at a time**; events that arrive meanwhile go into the next run.
- A run that fails, times out or is cut off by a restart is **retried automatically** with the same events (the prompt says it was interrupted — check for half-finished work). After `maxFailures` in a row the agent is **flagged failed** and waits for the human.
- `maxRunsPerHour` (default 20; `null` = no limit) and `throttleMinutes` (default 3; `0` = off): a quiet agent wakes as soon as something arrives, but for `throttleMinutes` after each wake further events wait and arrive together in one run — editing ten tickets in a row wakes it at most twice.
- Each run starts with no memory: **everything worth keeping goes on the card.**
- `intellagent agents` lists them; `agents add|pause|resume|run|log|remove <name>`. `GET /api/agents` shows status, queue and the last run; pause/resume/run are human-only. `intellagent autostart on` starts the board (and so its agents) at login.
- An open-ended master lease ends by itself after `masterIdleMinutes` (manifest, default 120) without activity from its holder, unless the holder is a standing agent mid-run.

Your inbox already includes tickets you created, leased (now or before), commented on, were assigned or @mentioned on — and, while you hold the master lease, every ticket on the board.

## 5. Events — know when things change

Every change emits an event with an increasing `seq`. Each event lists `recipients`: the leaseholder and past leaseholders, whoever asked for help, the agent author, the assignee, thread participants, the master-lease holder and @mentions. **`for=<your-name>` is your inbox.**

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

### Safe retries
- **`Idempotency-Key: <anything unique>`** on a write: repeating it (same caller, same key, within 24h) returns the first reply with `Idempotent-Replayed: true` instead of acting twice. Inside a standing-agent run, `intellagent api` and the MCP tools add one automatically, derived from the event batch — so a retried run that repeats an identical write doesn't duplicate it.
- **`X-Intellagent-Run: <id>`** tags every event a call causes (`actor.run`); filter with `?run=<id>`. Standing agents set it (`INTELLAGENT_RUN`), and a retried run's prompt lists what the failed attempt already did.
- **Subscriptions, at-least-once:** read with `GET /api/subscriptions/<id>/next?peek=true`, handle the events, then `POST /api/subscriptions/<id>/ack { "cursor": … }`. Without `peek`, `next` advances immediately (at-most-once).

### Permissions & tokens
The manifest may restrict agents (`permissions: { "<name>" | "*": { "columns": ["Backlog","Ready"], "readOnly": false } }`) and require tokens (`auth.agentTokens`). Check yours with `GET /api/permissions/me`; send tokens as `Authorization: Bearer <token>`. The human's own token (from `intellagent init`) lives in `.intellagent/local.json`; without it, requests sending `X-User` are refused, so agents cannot act as the human.

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

The human edits columns in Settings › Columns (rename, colour, icon, flags, order, add; delete only when empty). Custom flags are stored as-is; `pickup` and `working` tell agents where work starts and happens.

## 8. Shell tips

- If `intellagent` is on PATH (it finds this project's board automatically):
  `intellagent api GET /api/boards/main/summary`, `intellagent api POST /api/boards/main/items '{"title":"x"}'`, or pipe JSON with `-`.
  Set `INTELLAGENT_AGENT=<your-name>`. Without the global command: `node <install>/cli.js …`.
- Windows PowerShell: use `curl.exe`, not `curl`; quoting JSON is painful, so prefer the CLI.
- MCP clients: `node intellagent/mcp.js` exposes all of this as tools.

## 9. A good working loop

```
1. GET …/brief                        (once per session or run)
2. Take the first "next" action — usually POST …/items/<ID>/start { status }
3. Work. Update your status; renew the lease if it runs long (…/work warns you).
4. Unsure? POST …/attention { reason }; carry on with something else; the answer appears in …/work
5. Done → POST …/review { summary }   (Done itself is human-only)
6. GET …/work again — repeat from 2 until "next" is empty
7. End of session → POST …/finish { summary }
```

## 10. Setting up a board in a project

Asked to "set up Intellagent here"? Follow this. **Stop and ask the human at the three ✋ points** — the board is how they will steer you, so its shape is their call.

1. **Check.** `intellagent help` must work (if not: the human installs it with `npm link` from the Intellagent folder). If `intellagent status` already finds a `.intellagent/`, skip to step 5 and offer to reshape the existing board instead.
2. **Look around** before proposing anything: README, CLAUDE.md / AGENTS.md, package manifests, top-level folders, test setup, `TODO`/`FIXME` count, open issues (`gh issue list` if available).
3. ✋ **Ask** (one round of questions):
   - Template: `software`, `research`, `ops`, `default` or `simple` (`intellagent templates`). Recommend one from what you found.
   - Board name and ticket prefix (default: folder name, e.g. *Acme Billing* → `AB`).
   - What to seed tickets from: TODO comments, GitHub issues, a plan they give you, or nothing.
   - `init` also registers the MCP tools (`.mcp.json`), adds a short block to CLAUDE.md pointing agents at `intellagent brief`, sets the default agent name (`claude`; `--agent` to change) and generates the human's sign-in token (`.intellagent/local.json`, git-ignored). Opt out with `--no-mcp`, `--no-claude`.
4. **Scaffold and start:**
   `intellagent init --template software --name "Acme Billing" --prefix AB`
   It starts the board in the background and opens it signed in. Confirm with `intellagent status`; then run `intellagent brief` to see what agents will see.
5. **Tailor the schema and rules.** Draft, don't write yet:
   - Field options that fit the project, e.g. the software template's `area` tags from the repo's top-level folders.
   - Board rules about **how to use the board only** (where work comes from, when to ask, review). Do **not** copy CLAUDE.md or other conventions into them — the board already shows those files read-only next to its rules. If a convention is missing from CLAUDE.md, propose adding it there instead.
   - Column changes, if the template doesn't fit (`POST/PATCH /api/boards/main/columns`).
6. ✋ **Show the human** the proposed fields, rules and column changes in one message; apply only what they approve (`POST /schema/fields`, `PUT /directives`).
7. **Introduce yourself:** `PATCH /api/profiles/me` with a colour, glyph, label and a one-paragraph description of your role.
8. ✋ **Seed tickets** from the agreed source. Show the list first if there are more than ~10. Then create them with sensible `type`, `priority`, `parent` groups, description checklists and `blockedBy` links. Keep the first batch under ~25; mention what you left out.
9. **Wire up:** in a git repo, offer `intellagent hook install`. If you will be the only agent, take the master lease. Tell the human how answers reach you: `intellagent wait` in the background while you work, or offer a standing agent (`intellagent agents add <name>`) and `intellagent autostart on` for unattended work.
10. **Hand over:** post a digest entry describing the setup, raise *needs you* on anything still uncertain, and tell the human the URL (`intellagent open`).

Only touch `.intellagent/`, `.mcp.json`, `CLAUDE.md` and `.git/hooks/` — and only the ones the human agreed to.
