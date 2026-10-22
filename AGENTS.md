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
| Done | `POST …/items/<ID>/review { changed, why, verify, evidence, risks }` | Moves to review, releases your lease, asks the human — explain in five parts |
| Asked to explain | a comment with `intent: "explain"` (also first in `…/work`) | Answer in a comment; change nothing else |
| Verdict | (human) `review.approved` / `review.changes_requested` | Feedback shows in `…/work`; `start` again to address it |
| End of session | `POST …/finish { summary }` | Releases everything you hold, posts the digest |

Errors are `{ "error": "…", "code": "LEASED", "hint": "…" }`. Branch on `code`, follow `hint`. Codes:

| Group | Codes |
|---|---|
| Held or blocked | `LEASED` `NOT_LEASED` `BOARD_HELD` `LEASES_ACTIVE` `BLOCKED` `WIP_LIMIT` `LOCKED_COLUMN` `OUT_OF_FOCUS` |
| Not yours to do | `HUMAN_ONLY` `OWN_WORK` `OUT_OF_SCOPE` `NOT_DELEGABLE` `NOT_ROUTABLE` `FORBIDDEN` `UNAUTHORIZED` |
| Wrong input | `BAD_REQUEST` `UNKNOWN_FIELD` `IMMUTABLE` `EXPLICIT` `BAD_EMOJI` `MODEL_NOT_ALLOWED` `WIDEN` `NO_AGENT` |
| Wrong state | `VERSION_CONFLICT` `REVIEW_OPEN` `OKS_MISSING` `REVIEW_PENDING` `NO_REVIEWER` `NO_REVIEW` `ALREADY_DECIDED` `NOT_TEST` `NOT_FOUND` `ARCHIVED` `LOCKED` `CONFLICT` `TOO_LARGE` `MEMORY_OFF` |
| Agent management | `STANDING_AGENT` `ONLINE` `HOLDS_LEASES` `PROBATION` |

## 0. Rules of the road

1. **Identify yourself** on every request: header `X-Agent: <your-name>` (or `?agent=<name>`). Use one stable name per agent.
2. **Read the board rules first**: `GET /api/boards/main/directives` returns the board rules (how to use the board) **and** the project conventions, the project's own convention files (e.g. CLAUDE.md, under `projectRules`). Conventions live in the repo; the board only adds how to use the board. Never copy one into the other.
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

- Attaching by `path`: agents may attach files from the project, their worktree and the OS temp folder (`403 FORBIDDEN` elsewhere; send `dataBase64` instead). Nobody can attach `local.json` or anything in the board's data folder. Avatars by `imagePath` follow the same rule.
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
- Tags with options, e.g. `POST …/schema/fields { "key": "area", "type": "tags", "options": ["server", "ui"] }`, then set it as a JSON array: `PATCH …/items/INT-12 { "fields": { "area": ["ui"] } }`.
- `ui`: `edit` (humans can change it), `read` (humans see it but **only agents/API can change it**), `hidden` (API only).
- `stub`: `none` | `top` (badge beside the id) | `meta` (chip in the card footer).
- Built-ins (`type priority parent description blockedBy attachments cover properties`) take `{ ui, stub, label }`. `blockedBy` defaults to `ui: "read"`. Only the human changes them.
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

## 2e. Your memory

A few notes you keep across runs: your brief shows them every run, under **Your memory**. Keep a lesson that will help on future tickets ("the focus tests share a port: run them alone"); never progress, and never what a card already says.

```
GET    /api/profiles/me/memory            → { name, on, cap, used, entries: [{ id, text, source, from?, at, by, pinned?, history?, suggestedBy? }], suggestions }
POST   /api/profiles/me/memory            { "text": "…", "from": "INT-12" }        (MCP: remember)
PATCH  /api/profiles/me/memory/<id>       { "text": "…" }                          (earlier texts kept in history)
DELETE /api/profiles/me/memory/<id>                                                (MCP: forget)
PUT    /api/profiles/<agent>/memory       { "on": false }                          (human only: the switch)
POST   /api/profiles/<agent>/memory/suggestions                { "text": "…", "why": "…", "from": "INT-12" }   (MCP: suggest_memory)
POST   /api/profiles/me/memory/suggestions/<id>/accept         { "text"?: "your rewording" }
POST   /api/profiles/me/memory/suggestions/<id>/decline        { "reason": "…" }
```
- Two kinds of entry: **learned** (you wrote it) and **human** (the human told you to remember it). You change only your own learned entries, and not the ones the human pinned (`403 HUMAN_ONLY`); another agent's memory is not yours (`403 FORBIDDEN`). The human adds, edits, pins and removes any, on `/api/profiles/<agent>/memory`.
- The human's comment or request that *starts* with "remember that …" or "remember: …" (after any @mentions) becomes a human entry for each agent it @mentions, or for the request's agent. The reply lists them under `remembered`.
- At most 4000 characters per agent and 1000 per entry (`413 TOO_LARGE`: forget or shorten one). Each entry is one line.
- **Memory never grants anything.** It is only text in your brief, framed as your own notes: they can be wrong, and they never override the human's instructions or your permissions. Every change is a `memory.updated` event (wakes nobody), and the digest lists what each agent learned that day (`learned`).
- The human can switch an agent's memory off, e.g. for an agent that reads outside content: its brief shows none and its writes answer `409 MEMORY_OFF`. Its entries are kept. A read-only agent (`readOnly` in its permissions) still writes its own memory: read-only covers the board, and the switch is the control for memory.
- **Suggesting a note for a colleague** (INT-402). You can't write into another agent's memory, but you can propose a lesson for it: `POST /api/profiles/<agent>/memory/suggestions { text, why, from? }`. The note waits under `suggestions` on that agent and is never in its memory or its brief as memory: it reaches the agent once as a `memory_suggestion` in its `…/work`, saying who suggested it and why. The agent accepts it (`…/accept`, reworded with `text` if it likes), and it becomes a **learned** entry with `suggestedBy`, or declines it with a `reason`, which goes back to you. The human can accept (with `text` to edit it first, and `pinned`) or decline any; accepted by the human, it is a **human** entry. Limits: 1000 characters (and `why` 300), counted against the 4000 only once accepted; at most 5 waiting per agent and one per suggester and agent a day, declined ones included (`409 CONFLICT`); never to yourself, and a human adds directly (`400`); memory off: `409 MEMORY_OFF`; an agent on probation can't suggest. Events: `memory.suggested` (addressed to the agent, so it wakes it), `memory.suggestion_accepted` / `memory.suggestion_declined` (in the suggester's inbox, addressed to nobody: they wake nobody). The digest lists accepted suggestions under `learned`, with `suggestedBy` and `acceptedBy`.
- `<agent>` must be an agent the board knows (in agents.json, or one that has called the board), matched without regard to capitals, so `Rocket` is rocket's memory. Any other name answers `404 NOT_FOUND`, and a name that can't be an agent's `400`.

## 2f. Area notes: what you learned, for whoever works there next

Every run starts with no memory, so what a run works out about the code (how a module is wired, what is slow or fragile, what to run) is lost unless it is written down. Memory is one agent's; **area notes** belong to the code: each is kept by area (a file or a folder of the project) and read by any agent that works there.

```
GET    /api/notes?path=lib/alerts/        → { notes: [{ id, area, text, by, from?, at, confirmedBy? }], count }   (MCP: area_notes)
POST   /api/notes                         { "area": "lib/alerts/work.js", "text": "…", "from": "INT-12" }        (MCP: add_note)
POST   /api/notes/<id>/confirm            this one helped (not its author)
POST   /api/notes/<id>/retire             { "why": "…" }: wrong or out of date (anyone; kept for the record, ?retired=true)
PATCH  /api/notes/<id>                    { text?, area? } (its author or the human)
DELETE /api/notes/<id>                    (the human only)
```
- **Leave them when you request review:** `learned` is the review's sixth part, one note per line: `area: lesson` (`lib/alerts/work.js: the TAG table decides when work is new again`), or `none`. Each line becomes a note from that ticket; the review card shows it under *Learned for next time*. An agent's review with no `learned` (not even `none`) comes back with a warning, as one without evidence does, and a line with no area is reported, not kept.
- **They come back to you:** `start` returns `notes` for the paths the ticket names (in its title and description), your own `areas` and the ticket's earlier notes; your brief lists the notes on your areas under **Area notes**. Read them before you explore.
- A folder note covers what is in it, and asking about a folder finds the notes inside it. Notes others confirmed come first. An area keeps at most 8 (the least confirmed, oldest goes, retired rather than lost), a note is at most 600 characters, and the same lesson on the same area counts as a confirmation instead of a second note.
- Notes are only text an agent reads, like memory: they never grant anything, and they can be wrong. Retire one that misled you, saying why.

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
Reviews explain themselves in five parts: `changed` (what changed), `why` (the reasoning, and alternatives you rejected), `evidence` (what proves it works: screenshots, outputs, tests), `verify` (how the human can check it) and `risks` (risks and open questions), plus `learned`: what the next agent working on that code should know (area notes, section 2f). The review card shows each part in full. A single `summary` still works.

Keep `changed` short, plain and to the point. A non-technical reader should be able to follow it: say what the change does for the user, and name files, functions or flags only where the change needs them. Keep the other four parts as complete as they need to be. Example:
- Before: "server.js (requestReview): counts commits via worktrees.commitsFor and stores `landing` on the review question; app.js renders a `.rv-does` line and a conditional button label."
- After: "The review card now says what Approve will do, and the button says *Approve and land* when agent commits are waiting."
When the human wants more, they **Ask why** — a comment with `intent: "explain"`, addressed to you if it @mentions you or, if not, to whoever requested the review or last worked the ticket. It arrives as an `[EXPLAIN ONLY]` event and tops your `…/work`. Answer in a comment and change nothing else: not the code, the ticket, its column or the review — the review stays open while they read your answer.

### Request review (preferred way to finish)
`POST /api/boards/main/items/INT-12/review { "summary": "What changed and how to verify" }` — moves it to the review column, comments your summary, releases your lease and raises a **review** request.
**Evidence is required.** The human approves only what they can see working, so every review carries `evidence`: screenshots (attach them to the ticket and name them), the command you ran and its output, test results, and for anything visible, what to look at in the Preview. A review without it comes back with a warning. A design decision a person sees (a look, layout, theme, motion or flow) needs its screenshots attached before review is requested: light and dark theme, and 375 px wide where the layout changes, each named for what it shows (e.g. `int202-light-375.png`) and listed in `evidence`. An API or CLI change shows its command output instead. On a board whose code is Intellagent itself, the review card has a **Preview** button: the board runs the author's branch on a temporary board (`sandboxes/preview/`, a fresh copy of the tickets) and opens it signed in, so commit everything the ticket needs before you ask (`POST …/items/<ID>/preview`, human only; `"preview": true` in `GET /api/app` says the board can).
The human decides with `POST …/review/decision { "verdict": "approve" | "changes", "comment": "…" }` (human only): approve moves it through the gate; changes moves it back to the working column. Moving a ticket with an open review into an approval gate (e.g. dragging it to Done) counts as approve. You receive `review.approved` or `review.changes_requested` (with `feedback`), and `GET …/work` lists it under `feedback` until you `start` it again.
**Reviewers:** an agent with `reviewer: true` (the human or the receptionist assigns it) answers `POST …/items/<ID>/reviewers/<name>/verdict { verdict: "ok" | "concerns", comment }`; never the ticket's author (`403 OWN_WORK`). A verdict never decides the review.
**Landing:** an approved ticket lands with `POST …/items/<ID>/land` (`409 NOT_APPROVED` before approval). A failed landing shows as a `land` action for the agents holding `work.land`.
**Delegated approval:** a `review.decide` grant approves only when its rules hold, and a `409` names what is missing: `OKS_MISSING` (a named reviewer has not said ok), `REVIEW_PENDING`, `NO_REVIEWER`, `NO_EVIDENCE`, `CONCERNS_OPEN`, `BLOCKED`. `403 APPROVALS_OFF` means the human has switched delegated approval off. The grant rules are in docs/operators.md, under Grants.

### End a session
`POST /api/boards/main/finish { "summary": "markdown", "items": ["INT-12"] }` releases every lease you hold (and the master lease) and posts the summary to the digest. Standing-agent runs that exit cleanly get this release automatically.

### Metrics
`GET /api/boards/main/metrics?days=7` (or 30): tickets done (and the previous window), median cycle time (working column → done), median time in each column, open questions and how long the oldest has waited, and how fast the human answers. The UI shows it as a strip under the top bar.

`GET /api/analytics?days=7` (1-90, default 7; `&agent=<name>` for one agent) is the agents' side: per agent, time in each state (`states`: running, queued, waiting, throttled, idle, paused, failed… in ms; `unknownMs` before its first known state), queue depth at each run start (`queue`), runs and how they ended, tokens, cost (`cost`, with `unpriced` counting runs that reported none: unknown, never 0), the same per model, and the top tools and command names; per ticket, runs, time, tokens and cost (a run woken for several tickets is shared between them equally, so tickets add up to the agents' totals). Each agent also has `segments` (`{ from, to, status, note? }`, clipped to the window, the newest 500: one lane on a time axis; `note` is the board's own words, e.g. "usage limit"), each agent and `totals` also carry `daily`, one `{ day, runs, cost, unpriced }` per UTC day of the window, oldest first, by the day a run ended (a day with no priced run has `cost: null`, never 0), and the reply has `suggestions` (`{ kind, text, agents?, items? }`): `rebalance` when one agent spent a fifth of the window queued, throttled or waiting while another sat idle half of it, and `waiting-on-human` for tickets waiting on the human over a day. It is worked out on each call from the `agent.status` events and the run records in `agent-stats.jsonl`, live and rolled files, reading only the files of the window. **Anyone who can read the board may read it**, the human and every agent: it holds command names only, never command lines, prompts or ticket text.

`GET /metrics` is the same board for Prometheus: off until the manifest turns it on, and it answers only to a metrics token. Its setup, token and autonomy counters are in docs/operators.md, under Metrics: Prometheus. The board can also push the same metrics, and one span per agent run, to an OTLP collector (`metrics.otlp` in the manifest; docs/operators.md, under Metrics: OTLP).

### Daily digest
At the end of a session: `POST /api/boards/main/digest { "summary": "markdown", "items": ["INT-12"] }`. Read what others wrote with `GET /api/boards/main/digest?days=3` — a cheap way to catch up.

### Approval gates
Columns with `humanOnlyIn` / `humanOnlyOut` can only be entered / left by a human (`403` for agents). By default **Done** is human-only: move finished work to **Review** and let the human accept it.

A **sleeping** column (`flags.sleeping`, e.g. Backlog) holds work nobody should start yet. Assigning a ticket there wakes nobody; agents cannot start it there (`409 SLEEPING`) and it is not in their work. Moving it out — into Ready — wakes its assignee. On a board with a sleeping column, agents file new tickets into it (`403 SLEEPING` elsewhere); the **coordinator** decides where a ticket an agent filed goes (leave it asleep, or create or move it into any column it may use), and only the human wakes the human's own tickets.

### Grants: powers the human delegates
The human delegates a power (review.decide, column.gate, work.land, agents.control, agents.manage, the Board admin set) through agents.json or the Agents page, and every call is checked. The grant syntax, required reviewers, guidance and switches are in docs/operators.md, under Grants.

### The permission library
Every permission an agent can hold, as data: `GET /api/permissions` lists the built-ins and the human-added ones. How the human adds one, its kinds and the grid are in docs/operators.md, under The permission library.

### Handoffs
`PATCH … { "assignee": "other-agent" }` hands a ticket over; the assignee receives its events (`for=<name>` / `assignee=<name>`).
When a ticket's last open blocker reaches the final column (or is archived), its watchers get `item.unblocked`.

### Asking for a ticket someone else holds
`POST …/items/<ID>/lease/request { "reason": "…" }` tells the holder. The holder (or the human) answers with `POST …/lease/handover { "to": "<you>", "note": "where I left off" }` — the lease moves to you in one step — or `POST …/lease/decline { "to": "<you>", "reason": "…" }`. Pending requests show up first in the holder's `…/work`. Requests are allowed even while the board is held.

### Working alone: the master lease
`POST /api/boards/main/master {}` holds the whole board until you release it (pass `minutes` for a time limit, `status` for a live line in the header). While you hold it you need no per-ticket leases and other agents are read-only — they can still comment, ask the human and post to the digest. It fails while other agents hold ticket leases. **Release it (`DELETE …/master`) before spawning helper agents**; they then use normal ticket leases. The human can revoke it at any time.

### Focus boards: the human is working on a handful of tickets
A focus board is a saved view over a board: a name and a list of its tickets, never a copy. The human makes one from a bulk selection; it shows only those tickets, in the same columns under the same rules, and every change on it is a change to the real ticket. **One board is active** — the full board, or one focus board — and while a focus board is active, **you work only on its tickets**:
- `…/work` and your brief say so (`focus: { name, items, note }`, and `focus: ["<name>"]` on each ticket that is on one) and suggest only its tickets; pickup skips the rest. Work you held outside it when it became active went back to the pickup column, still assigned to you, with a 🎯 comment.
- What still reaches you outside it: an @mention, a request or an explain from the human, the lease housekeeping on what you hold, and landing approved work (`work.land`). `start` outside it answers `409 OUT_OF_FOCUS`; when the human asked you for that ticket directly, pass `"outsideFocus": true`. Reviews and delegated approvals outside it wait (`409 OUT_OF_FOCUS`).
- Tickets you file go where they always do (e.g. Backlog), not onto the focus board. The **coordinator** may add tickets to a focus board when the human asks (`PATCH …/focus/<id> { add: [ids] }`); only the human (or an agent the human granted `admin.focus`) makes, renames, takes tickets out of, activates or retires one.
- Retiring removes the view only: no ticket moves, and the full board is active again (your held work comes back in `…/work`).

```
GET    /api/boards/main/focus                  → { active, focusBoards: [{ id, name, itemIds, active, count, createdAt, createdBy }] }
GET    /api/boards/main/focus/<id>             → one focus board with its tickets
POST   /api/boards/main/focus                  { name, itemIds, activate? }      (human)
PATCH  /api/boards/main/focus/<id>             { name?, add?, remove? }          (human; the coordinator may only add)
PUT    /api/boards/main/focus/active           { id } | { id: null }             (human)
DELETE /api/boards/main/focus/<id>             → what moved while it was open    (human)
POST   /api/boards/main/items                  { …, focus: "<id>" }              (created on the board, added to that focus board)
```
Events: `focus.created`, `focus.updated`, `focus.activated` (to every standing agent's inbox; wakes nobody), `focus.retired`. A ticket archived or deleted leaves every focus board.

### Card rules and review facts
The human names a **condition** and the **look** a ticket earns when it holds. `GET …/card-rules` reads them; the condition terms and look fields are in docs/operators.md, under Card rules: the condition and the look.

Every ticket in search carries **review facts**: `review.oks`, `review.pending`, `review.concerns`, `review.allOk`, `review.evidence`, and `reviewers.<name>`. They count only verdicts that stand (given with the reviewer's own token, about the commits the ticket has now), so a stale ok never shows as approval. `review.evidence` is true only while a review is open (the evidence lives on the open review). The facts sit beside the decision record (`review.verdict`, `review.by`…) in the same `review` object. Use them in `where` (`{ "review.oks": { "gte": 2 } }`) or as `filter` (`POST /api/search { filter: "review.allOk" }`, `GET /api/search?filter=…`).

## 4. Talk to the human

```
POST   /api/boards/main/items/INT-12/attention  { "reason": "Rotate refresh tokens on every use, or only on expiry?" }
DELETE /api/boards/main/items/INT-12/attention  { "reply": "…" }   (normally the human does this)
```

The ticket glows on the board. The reply returns a `questionId`. A ticket can hold several open questions (from you and others); each is answered on its own and the answer arrives as an `attention.resolved` event with that `questionId` and `reply`, addressed to whoever asked — and in `GET …/work` under `answered`. Asking the same thing twice reuses the open question. The human answers one with `DELETE …/attention { questionId, reply }` (without `questionId`, every open question is closed).

**A question with a form.** When the answer has a shape, give the question a `form` and the card draws the controls:
```
POST …/items/INT-12/attention { "reason": "Storage setup?", "form": [
  { "type": "note", "markdown": "Pick what **fits**." },
  { "key": "db", "label": "Database", "type": "choice", "options": ["postgres", { "value": "sqlite", "label": "SQLite" }], "required": true },
  { "key": "extras", "label": "Extras", "type": "multi", "options": ["cache", "queue"] },
  { "key": "migrate", "label": "Migrate now?", "type": "yesno", "default": false } ] }
```
Types: `text longtext choice` (radio) `multi` (checkboxes) `yesno number` (`min`/`max`) `date` (YYYY-MM-DD), plus `note` blocks of markdown; each field may have `required`, `default` and `help`. Combine them in any order. The answers come back as `{ key: value }` (unanswered ones `null`) in the event's `form` and in `…/work` under `answered[].form`, and as a readable comment on the card. A form the board cannot draw, or answers that don't fit it, get `400 BAD_REQUEST` with a hint. The human can still reply in words or resolve without filling it in, so read `form` when it is there and `answer` always.

**Withdrawing.** Once your ask is met or no longer relevant, take it back with a reason instead of leaving it open: `POST …/items/<ID>/questions/<questionId>/withdraw { "reason": "…" }` for a question or a review request on a card, `POST …/requests/<id>/withdraw { "reason": "…" }` for a request you sent. It is recorded on the card (↩) and leaves everyone's `…/work`; it moves nothing (whoever leases the ticket, or the coordinator, decides that). Only whoever raised it, the coordinator or the human may close it: anyone else gets `403 FORBIDDEN`, and the same holds for an agent calling `DELETE …/attention`. A review that was withdrawn and never decided can't be carried through a gate by an agent (`409 REVIEW_OPEN`).

**Where to ask.** While the human is actively chatting with you, quick back-and-forth belongs in chat. Anything that should outlive the conversation — a decision, an approval, a question raised while working unattended — goes on the card, so you never wait in one place while they answer in the other. If you asked in chat about a ticket, record the answer on the card.

**Reactions.** React to a card or a comment with an emoji — `POST …/items/<ID>/reactions { "emoji": "+1", "commentId": "c_…" }` (omit `commentId` for the card; names like `eyes`, `+1`, `tada`, `rocket`, `thinking`, `check` work; `DELETE` with the same body removes it). Reactions never wake anyone and are allowed even while others hold the ticket or the board. ⏳ means "queued": a comment for a standing agent that is busy, settling or throttled gets ⏳ from that agent (hover says when it runs), swapped for 👀 when the run starts. 👀 means "seen": it is added for you on comments you're woken for (standing agents and `intellagent wait`); add it yourself when you read a comment some other way. Use 👍 / ✅ for "done", 🤔 when you're unsure — then say why in a comment.

**Seen, not answered.** A comment that @mentions an agent whose 👀 is on it, with no later comment from that agent on the card and no reaction of its own on the comment other than 👀/⏳, is *seen, not answered*: the ticket (`GET …/items/<ID>`) carries `unanswered: [{ commentId, agent, by, since }]`, and that agent's `GET …/work` lists a `reply` action and an `unanswered` array. It is read off the card, never a reason to run: `work.pending` does not carry `reply`, so it starts no run and cannot loop. It clears by itself when the agent comments or reacts (✅ / 👍 for a mention that needs no words: the 👀 alone does not count). Not counted: an agent mid-run, explain comments (their own action), comments older than 3 days, finished tickets and archived ones.

**Typing.** The board page tells the others that someone is writing a comment: `POST …/items/<ID>/typing` (people only; an agent gets `403 HUMAN_ONLY`, and `PUT …/status` is how it shows what it does). It is sent live on `/api/stream` as `item.typing { itemId, actor }` with no recipients and no `seq`: it is not stored, logged or replayed, changes no version, history or digest, and wakes nobody. One per person and ticket every 3 seconds (`{ sent: false }` between); a client lets the pip lapse a few seconds after the last one. Agents have no tool for it.

**Asking another agent: an ask, not an @mention** (INT-391). When you need something from another agent, make it an obligation the board tracks: `POST …/items/<ID>/asks { to, kind, what, options?, dueMinutes? }` → `{ ask }`. Kinds: `answer`, `decide`, `review`, `fix`, `assign_reviewer`, `unblock`, `other`. It is an `ask` in its owner's `…/work` (it wakes the owner once) and closes itself when the thing is done (`review`: the owner's verdict; `fix`: its next review request; `assign_reviewer`: a reviewer assigned) or when the owner answers `POST …/asks/<askId>/done { answer }` (the answer goes on the card, and back to you as `ask_answered` in your work). Not done by its due time (default 60 minutes), it escalates once: to the coordinator as an ask of its own (an escalation never escalates again). The human is not asked; with no coordinator, or when it is the asker or the owner, the `ask.overdue` event wakes the asker instead. The escalation closes with the original. Withdraw one you no longer need: `POST …/asks/<askId>/withdraw { reason }` (the asker, the coordinator or the human). Events: `ask.created` (addressed to the owner), `ask.done` (to the asker), `ask.withdrawn`, `ask.overdue`. A `chase` or a `supervise` action proposes the ask to make.

**Alerting another agent: @mention it** (for conversation; for an obligation, ask). Most agents wake only when they are addressed, so "Rocket, take this" wakes nobody; "@rocket, take this" does (so does assigning the ticket). An @ inside `code` or a `>` quote does not count. When an agent names another standing agent without @, the comment is still saved, and the reply carries a `warning` saying who was not alerted. Only standing agents wake on an @mention: an @ of any other name (not a person on the board, and not waiting on the board right now with `intellagent wait` or a stream) is saved too, and its reply carries a `warning` that nobody was woken. Every brief carries this rule.

**What not to post.** Keep cards and the digest readable: no step-by-step progress logs, nothing git already shows (diffs, file lists), no restating the ticket. Post decisions, blockers, results and how to verify.

**Requests.** The human's free-form asks ("create tickets for X") are *requests*, sent to the board's coordinator or a named agent. They arrive as `handle_request` in `…/work`: do it, then `POST …/requests/<id>/reply { "body": "what you did, with ticket ids", "done": true }`. `GET …/requests` lists them; `POST …/requests { "body": "…", "to": "<agent>" }` sends one (to the coordinator if `to` is omitted). A request is usually a follow-up: its event carries `history`, the conversation so far with you (the last 10 messages of the week, oldest first), and your prompt shows it — answer the latest message in that context.

**Waiting on a condition: a trigger** (INT-435). Don't hold a ticket or poll while you wait for something: put a trigger on the card and end the run. `POST …/items/<ID>/triggers { when, priority?, wake?, note? }` → the trigger; `DELETE …/items/<ID>/triggers/<triggerId>` removes it. Anyone may do either.
- `when`: `{ machine: "exclusive", busyBelow?: 15 }` (the PC free for a timing run: no machine lease, processor under busyBelow %), `{ idle: "60m" }` (quiet that long, then again every 60m while it stays quiet), `{ quietFor: "30m" }` (once per quiet stretch), `{ every: "15m" }` or `{ until: "<ISO time>" }` (once). Durations are at least a minute. At most 5 active per card (`409 CONFLICT`).
- `wake`: the standing agent to wake (default the coordinator; a helper: `403 NOT_ROUTABLE`). `priority`: `now` (sent at the next sweep, within a couple of minutes) or `batch` (default: gathered per agent and sent together once the oldest has waited the batch window, 15 minutes).
- Triggers are edge-triggered, so leaving one on never loops. What fires arrives as one `trigger.fired` event per agent, `{ wake, cards: [{ id, title, why, note, priority, owner, firedAt }] }`, addressed to it.
- **Idle check:** every picked-up card that isn't done gets `{ idle: "60m" }` at `batch` priority to the coordinator (`default: true`). Remove it when a long quiet stretch is expected; the board won't put it back. A card with any other active trigger is waiting on purpose: the stuck watch lists it as `waiting_on_trigger` and escalates it to nobody.
- The card shows a 🔔 chip with the count; in the drawer the chip lists them and removes one.

### Getting woken up
You only see board events when you look. Ways to make answers on cards reach you:
- **During a session:** run `intellagent wait --agent <you>` as a **background** command. It blocks until something arrives in your inbox, prints it and exits — your shell tool notifies you. It remembers its place, so nothing is missed between runs. Re-arm it after handling the events.
- **Standing agents (unattended, survives reboots):** the board itself starts a short headless run whenever events arrive for an agent defined in `.intellagent/agents.json`. Agents are disposable; the board keeps the queue. Details below.
- **Ad hoc:** `intellagent watch --agent <you> --claude` (or `-- <any command>`) does the same from a terminal you keep open.
- **Coordinating several agents:** add `--human` to `wait`/`watch` (or `"listen": "human"` for a standing agent) to hear about *everything* the human does on the board, not just your inbox — then delegate with `assignee` or a comment @mentioning a worker. `--filter "types=item.created&column=Ready"` takes any event filter.

### Standing agents
The human runs standing agents from `.intellagent/agents.json`: wake settings, models and tiers, roles, probation, worktrees, commands, MCP servers and stop-all. All of it is in docs/operators.md, under Standing agents. A run is taught its brief and layers: `GET /api/agents/<name>/layers`.

### Machine leases: heavy work, rationed
Several agents on one PC can each run a browser, a simulation or a timing run; all at once they run the machine out of processor or graphics-card memory and spoil each other's timings. The **lease program** (`leases-server.js`, one per PC on `127.0.0.1:7499`, shared by every board; state in `~/.intellagent/leases.json`) rations it. Usually a **Guard** agent asks on the others' behalf; any agent may ask directly.
```
intellagent leases ask --holder natasha --cpu 11 --gpu 2048 --minutes 20 --ticket LNZ-3 --purpose "heat solve"
  → { granted: true, lease: { id: "L4", expiresAt … }, floor, ceiling }
  → { granted: false, reason: "no room: 11 threads, 2048 MB of card in use of 12 threads, 8192 MB", freesAt: "…" }
intellagent leases renew L4 --minutes 15      # still at it
intellagent leases done L4                    # finished: free it at once
intellagent leases status | machine           # what is leased (the floor) | what the machine is actually doing
intellagent leases ceiling --cpu 8 --gpu 5000 # the most that may be leased at once (Guard / human)
```
- Ask in **threads** (`cpu`) and **MB of card** (`gpu`); `--exclusive` wants the machine to itself (timing runs) and waits until it is empty.
- A no is not an error: it says why and, where waiting helps, `freesAt`. A request bigger than the ceiling gets `freesAt: null`.
- Every lease **ends by itself** when its time is up (at most 120 minutes; renew to keep it), so a crashed agent never strands the machine. Declare `done` as soon as you are.
- The human's own work never asks: the Guard watches `leases machine` and lowers the ceiling to leave them room.
- `leases machine` also lists the busiest processes with their command lines; `agent: true` marks one started from the board's own folders (a worktree, a review checkout, an agent's build). A test still running after its run ended shows here, holding threads no lease accounts for. `intellagent leases reap <pid>` stops it and its children; it refuses any process not marked `agent` (`403 NOT_AGENTS`), so the person's programs are out of reach. Processes are listed, and reaped, on Windows only for now: elsewhere reap answers `501 UNSUPPORTED`.
- HTTP for other tools: `GET /status`, `GET /machine`, `POST /ask`, `POST /leases/<id>/renew|done`, `PUT /ceiling`. Only programs on this PC: the Host must be `127.0.0.1:7499` or `localhost:7499`, a request with an `Origin` header (a web page) is refused, and writes need `content-type: application/json`. Errors are `{ error, code, hint }`. The CLI starts the program when it is not running; `intellagent leases start|stop` by hand.

## 5. Events — know when things change

Every change emits an event with an increasing `seq` (the log, `events.jsonl`, is set aside once it passes `eventsMaxMB`, default 20, and only the newest `eventsKeep`, default 5, are kept; `seq` carries on). Each event lists `recipients`: the leaseholder and past leaseholders, whoever asked for help, the agent author, the assignee, thread participants, the master-lease holder and @mentions. **`for=<your-name>` is your inbox.**

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

A subscription is its creator's: only they (or the human) may delete it, ack it or read it without `peek` (`403 FORBIDDEN` otherwise). Anyone may read it with `?peek=true`, which moves nothing.

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
The manifest may restrict agents (`permissions: { "<name>" | "*": { "columns": ["Backlog","Ready"], "readOnly": false } }`) and require tokens (`auth.agentTokens`). Check yours with `GET /api/permissions/me`; send tokens as `Authorization: Bearer <token>`. The human's own token (from `intellagent init`) lives in `.intellagent/local.json`; without it, requests sending `X-User` are refused, so agents cannot act as the human. A board made before tokens existed gets one with `intellagent token` (then restart the board and `intellagent open` to sign in; `--rotate` replaces it). **Sign-in link:** `intellagent open` and `intellagent init` print the link they open (`<url>/#token=…`, the human's own token, so only the human runs them; an agent is refused with `HUMAN_ONLY`). `intellagent open --print` prints it and opens no browser, for handing someone access. The page removes the fragment from the address bar at once, so copy the link from the terminal.

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
GET   /api/app                            → also code (the folder of the code it runs), foreignCode (true: an agent's worktree, not its installation), runningCommit, runningSince, mainCommit, behind, behindCommits, behindTickets
POST  /api/app/restart                    (human only) restart onto the code on main; never happens by itself
GET   /api/presence                       → who is connected, their leases and subscriptions
```

The human edits columns in Settings › Columns (rename, colour, icon, flags, order, add; delete only when empty). Custom flags are stored as-is; `pickup` and `working` tell agents where work starts and happens.

**How the board is governed is the human's.** Unless the human granted the matching Board admin power (see *Grants*), agents get `403 HUMAN_ONLY` for adding, deleting or reordering columns, changing a column's known flags (`allowCreate`, `allowMoveIn/Out`, `wipLimit`, `releaseLeaseOnEnter`, `autoArchiveAfterDays`, `humanOnlyIn/Out`, `review`, `sleeping`, `pickup`, `working`), choosing the `coordinator`, changing the board rules (`directives`) and the built-in field settings (`PUT …/schema { builtins }`). A column's name, colour, icon and other custom flags, and declared fields, stay open to agents. Renaming the app (`PATCH /api/app`) and adding a board (`POST /api/boards`) are the human's too. To change the rest, ask on a card. A read-only agent may still comment, ask and keep its own profile, memory and subscriptions, and nothing more: holding `agents.control` or `agents.manage` doesn't change that.

### Presets: a package for a kind of team
A preset is a folder with `preset.json` that the human installs in the CLI (`intellagent preset list|add|diff|update|export`). Its shape, the team in a preset, and the grant rules are in docs/operators.md, under Presets.

## 8. MCP, CLI and the agent skill

Agents reach the board three ways; pick the lightest that works:
- **MCP core** — `node intellagent/mcp.js` lists ten tools by default (`get_briefing`, `get_my_work`, `get_item`, `start_work`, `set_status`, `add_comment`, `ask_human`, `request_review`, `wait_for_events`, `finish_session`; plus `introduce_yourself` until the agent has a role): ~4.5k characters of tool definitions instead of ~21k. `INTELLAGENT_MCP_PROFILE=full` (or `--profile full`) lists all 63; `INTELLAGENT_MCP_TOOLS=name,name` lists your own set. Every tool stays callable by name in every profile, `ask_agent`, `answer_ask` and `withdraw_ask` (the asks of section 4) among them.
- **CLI** — `intellagent do <operation> key=value …` runs any of those operations by name (same parameters as the MCP tools); `intellagent help <operation>` prints its exact request (`intellagent help <command>`, e.g. `help init`, prints a command's usage); `intellagent api <METHOD> <path> key=value …` calls any route. Output is JSON; on an error the reply stays on stdout and `error <status> <CODE>: <message> — hint: <hint>` goes to stderr with exit 1 (2: board unreachable or bad input, 3: no board). It never prompts; `INTELLAGENT_AGENT` sets who you are.
- **Skill** — `skills/intellagent/SKILL.md` (`intellagent skill install`) teaches the day-to-day loop and the CLI for everything beyond the core; it loads only when the agent works a ticket.

A narrow Claude Code permission rule for agents: `Bash(intellagent *)` plus the core tools by name (`mcp__intellagent__get_briefing`, …). `mcp__intellagent` alone allows whatever the server lists.

**A board kept outside the project:** set `projectRoot` in its manifest (`intellagent init --project <path>`, or `intellagent project <path>` on an existing board, then restart). Standing agents then run in that folder (worktrees are kept in the board's folder), the project's CLAUDE.md and git are read from there, and every brief names the folder. In the project, `intellagent link <board folder>` lets the CLI, MCP tools and the agents you start there find the board (`.intellagent/link.json`, git-ignored); `intellagent status` shows the project folder.

**A board of your own to try things on (sandbox).** `intellagent sandbox <you>` starts a throwaway board just for you, on a port that stays yours (7431, 7432, …), and prints its address and a sign-in link for its own human. `--from main | <agent> | <folder>` picks the code it runs — main, an agent's worktree (yours, to see your branch working, or the author's, to review it) or any checkout; `--seed board | demo | empty | snapshot` what it starts with (`board`, the default when the real board has data, copies the board `init` set up — columns, fields, ticket templates, rules, id prefix — with no tickets, and the output names that board; `snapshot` copies the real board's tickets: for reproducing what the human saw); `--fresh` wipes it. Run it again after changing code to restart it; its data stays. `sandbox list`, `sandbox stop <you> | --all` (it stops whichever process holds the sandbox's port, as long as the board there says it is a sandbox, even when its `server.pid` is missing or stale). **Stop says why:** `stop` prints `stopped`, `not running` (nothing answers on the port) or `STILL RUNNING — <reason>` with the port (the board there is not a sandbox, no process holds the port, the process could not be killed, or the port stayed taken), and exits 1 unless the sandbox is gone; `--json` gives `{ name, port, stopped, code, reason }`. **Unused sandboxes stop themselves:** a sandbox that has had no request for `sandboxIdleHours` (default 4; `--idle-hours N` on start; the liveness poll of `GET /api/app` does not count, and an open stream does: a tab on the board or `intellagent wait` keeps it up; `--idle-hours` takes a number, 0 = never) exits and leaves `data/stopped.json`, which `sandbox list` shows (`stopped: idle for 4 h`). `--keep` exempts one (`sandboxKeep` in its manifest; a restart keeps both settings). When all 200 ports are taken, starting a new sandbox takes the port of the one stopped longest (over a minute ago, with a `stopped.json`; its data stays, it gets a new port when started again, and it leaves `sandbox list`). Talk to it with `--url <its address>` on any command (or `INTELLAGENT_URL`); `--as <name>` sets who you are there (or `INTELLAGENT_AGENT`). `--manifest <path to intellagent.manifest.json>` (or `INTELLAGENT_MANIFEST`) does the same for a board folder you are not in: its URL and your token in its `local.json` are found from anywhere, for a shell that cannot `cd`. It is named for you ("Nebula's Board", in the header and as the board's name, even when seeded from a snapshot), so it is never mistaken for the real board. It is safe by construction: standing agents never run on a sandbox (`sandbox: true` in its manifest), its sign-in token is its own, and nothing you do there reaches the real board. It lives in `sandboxes/<you>/` beside the real board's manifest (git-ignored).

**Never start a live board on your worktree's code.** A sandbox is the only place your branch runs: never `node <your worktree>/bin/intellagent.js start|restart` (or `node server.js`) for this board or any other project's. From a worktree, `start`, `start --background`, `restart` and `init`'s start refuse any board that is not a sandbox or in the temp folder (`403 FORBIDDEN`); a board that runs worktree code anyway says so in its log and in `GET /api/app` (`foreignCode: true`), and every start logs the code folder, the time and the pid (INT-405).

**Trying the author's CLI (review).** `intellagent sandbox exec <name> -- <command…>` runs `bin/intellagent.js` *of the code that sandbox runs* (`sandbox <name> --from <author>`), on that sandbox's board and as its human, e.g. `intellagent sandbox exec nebula -- preset add ./x --yes`. Output and exit code come back unchanged. It needs no shell permission beyond `intellagent *`, but an agent needs the **Run an author's code** permission (`run-authors-code`; the Reviewer role holds it): the board says in `GET /api/permissions/me` (`runAuthorsCode`, and `runAuthorsCodeWhy` / `runAuthorsCodeHint` when false) and without it the CLI exits 1 with `403 NO_PERMISSION`. It cannot reach another board: no `INTELLAGENT_*` of yours is passed on (so never the real board's URL or token), `--url`, `--as` and `--manifest` are refused (`403 FORBIDDEN`), and so are `start`, `stop`, `merge`, `autostart`, `token`, `hook`, `skill`, `link`, `project`, `sandbox`, `watch`, `mcp` and `leases`; `init` only in the temp folder, never started. A sandbox that is not running answers `404 NOT_FOUND` with the command to start it. Put `--` before the command: flags after it belong to the command. **It is still the author's code running as you:** it gets your other environment variables (API keys included) and your files, as running their tests does. Only for a ticket you are reviewing.

Shell tips: the CLI finds this project's board by itself (nearest `.intellagent/`), or set `INTELLAGENT_URL`. key=value nests on dots (`fields.risk=low`) and parses JSON values; pass a JSON body as one argument, `@file.json` or `-` for stdin. **One long value from a file:** `key=@path` reads that value from the file as text (`intellagent api POST …/comments body=@C:/tmp/review.md`; the same in `intellagent do`), and `key=@@text` sends the text `@text`. The file must be in the project, its worktrees or the temp folder, and never `local.json` or the board's data (exit 2 with a code and hint otherwise). A word after `@` that is not a file stays text, so `body="@rocket take this"` still mentions rocket. A comment or verdict whose whole text is a file path is saved as written, but the reply has a `warning`: the board does not read files named in a comment. Windows PowerShell: use `curl.exe`, not `curl`; prefer the CLI.

### Agent tokens
A board may require every agent to send a token (`auth.requireAgentTokens` in the manifest; **new boards from `intellagent init` turn it on**, existing boards are unchanged). Tokens live in `.intellagent/local.json` (git-ignored), and the CLI and MCP tools in the project send the right one by themselves. The human issues one with `intellagent token --agent <name>` (`--rotate` replaces it; the board accepts it at once); standing agents get one automatically. An agent elsewhere passes `INTELLAGENT_TOKEN`. Without one: `401` with a hint naming that command. The board stays on 127.0.0.1 unless you change `host`. It answers only to its own names (`127.0.0.1`, `localhost`, the `host` it is bound to; `allowedHosts` in the manifest adds more, e.g. a proxy): any other Host gets `403 BAD_HOST`, so a web page that rebinds its name to this PC can't reach it. Writes from a browser must be `application/json`. Big replies are gzipped for clients that aren't on this PC (`compress` in the manifest: `remote`, the default, `always` or `never`); on this PC compressing only makes them slower.

## 9. Setting up a board in a project

Asked to "set up Intellagent here"? Use the **intellagent-setup** skill (`skills/intellagent-setup/SKILL.md`). It first asks what the board is for (kind of work, team size, how hands-off), then stops and asks the human at each checkpoint (template and prefix, the proposed fields and rules, a recommended team with reasons, the seed tickets, and the features as choices with a recommended setting each; nothing is switched on without a yes) and only touches `.intellagent/`, `.mcp.json`, `CLAUDE.md` and `.git/hooks/`, and only the ones the human agreed to. The commands it uses: `intellagent init --template <t> --name "…" --prefix XX` (or `--preset <name|folder>` instead, after showing the human the powers it lists), `intellagent preset list`, `intellagent templates`, `intellagent status`, `intellagent hook install`, `intellagent autostart on`.

## 10. Route index

Every route the server has, for checking a call before you make it. `GET /api` lists the same routes live, each with its description. `:board` is `main` unless `GET /api/boards` says otherwise; `:id` is a ticket id, case-insensitive.

```
Orient       GET /api  /api/docs  /api/schema  /api/app  /api/boards  /api/templates  /api/presence  /api/permissions/me
             GET /api/boards/:board  …/hash  …/summary  …/brief  …/work  …/metrics  …/listeners
             GET /metrics (Prometheus; off unless metrics.prometheus; metrics token as a bearer)
Tickets      POST …/items  …/items/bulk          GET …/items/:id  …/items/:id/history  …/items/:id/transitions
             PATCH …/items/:id                   POST …/items/:id/move  …/comments  …/attachments  …/reactions  …/typing  …/archive
             DELETE …/items/:id (test tickets)   DELETE …/items/:id/attachments/:att  …/reactions  …/test-items
Working      POST …/items/:id/start  …/review  …/review/decision (human or grant)  …/attention  …/finish  …/digest
             PUT …/items/:id/status              DELETE …/items/:id/attention        GET …/digest
             POST …/items/:id/questions/:qid/withdraw
Triggers     POST …/items/:id/triggers           DELETE …/items/:id/triggers/:triggerId
Leases       POST …/items/:id/lease  …/lease/request  …/lease/handover  …/lease/decline   DELETE …/items/:id/lease
             GET/POST/DELETE …/master            PUT …/master/status
Requests     GET/POST …/requests                 POST …/requests/:id/reply  …/requests/:id/withdraw
Archive      GET …/archive                       POST …/archive  …/archive/:id/restore
Columns      GET/POST …/columns                  PATCH/DELETE …/columns/:column    GET …/columns/:column/items
Schema       GET/PUT …/schema                    POST …/schema/fields              PATCH/DELETE …/schema/fields/:key
             GET/POST …/ticket-templates         PATCH/DELETE …/ticket-templates/:key
Focus        GET/POST …/focus                    GET/PATCH/DELETE …/focus/:id      PUT …/focus/active
Idle alarm   GET/PUT …/idle-alarm (PUT human)
Stuck watch  GET …/stuck
Approvals    GET/PUT …/approvals  …/admin (PUT human)
Rebalancing  GET/PUT …/rebalance (PUT human or admin.rebalancing)  POST/DELETE …/items/:id/pin  POST …/items/:id/rebalance/undo (human)
Rules        GET/PUT …/directives                PATCH /api/boards/:board          POST /api/boards      PATCH /api/app  POST /api/app/restart (human)
Card rules   GET/PUT …/card-rules (PUT human or admin.cardRules)    GET …/card-rules/check  …/card-rules/matches
Search       GET/POST /api/search
Events       GET /api/events  /api/events/wait  /api/stream   POST /api/stream-ticket (the UI)
             GET/POST /api/subscriptions         DELETE /api/subscriptions/:id     GET …/:id/next   POST …/:id/ack
Agents       GET/POST /api/agents  /api/agents/roles  /api/agents/:name  …/:name/log  …/:name/layers  …/:name/skills     PATCH/DELETE /api/agents/:name
             GET/PUT /api/agents/base-context (PUT human)    GET /api/analytics
             POST /api/agents/stop-all  /api/agents/resume-all  /api/agents/:name/pause  …/resume  …/run
             POST /api/agents/:name/accept  …/return (human only: probation of a new agent)
Permissions  GET/POST /api/permissions         PATCH/DELETE /api/permissions/:key (human)
             GET /api/agents/grid                PUT /api/agents/:name/permissions/:key (human)
Roles        GET /api/roles  /api/roles/:key  PUT /api/roles/:key (human)
Profiles     GET /api/profiles  /api/profiles/me  /api/names/suggest     PATCH /api/profiles/me     DELETE /api/presence/:name
Memory       GET/POST/PUT /api/profiles/:name/memory (PUT human)  PATCH/DELETE /api/profiles/:name/memory/:id   (:name may be "me")
             POST /api/profiles/:name/memory/suggestions  …/suggestions/:id/accept  …/suggestions/:id/decline
Area notes   GET/POST /api/notes   PATCH /api/notes/:id   POST /api/notes/:id/confirm  …/retire   DELETE /api/notes/:id (human)
Files        GET /avatars/:file  /files/:board/:file
```

`/api/boards/:board` is shortened to `…` in the table. Human-only actions (pausing or running standing agents, review decisions without a grant) answer `403 HUMAN_ONLY`.

**Who may call each write route** is one table in the server, listed by `GET /api?policies=true`: `{ method, pattern, who, readOnly?, held? }`. `who` names who may call it besides the human: `human` (nobody else), `any`, `self` (an agent acting for itself: its own lease, question, request, profile, memory), `coordinator`, or a power (`review.decide`, `admin.columns`…; the power's scope and switches still apply). `readOnly: true` means a read-only agent may still call it, and `held: true` that it goes through while another agent holds the board. The ticket's own rules (leases, gates, columns, which fields a power covers) are checked on top.
