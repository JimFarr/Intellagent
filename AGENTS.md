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
| Done | `POST …/items/<ID>/review { changed, why, verify, evidence, risks }` | Moves to review, releases your lease, asks the human — explain in four parts |
| Asked to explain | a comment with `intent: "explain"` (also first in `…/work`) | Answer in a comment; change nothing else |
| Verdict | (human) `review.approved` / `review.changes_requested` | Feedback shows in `…/work`; `start` again to address it |
| End of session | `POST …/finish { summary }` | Releases everything you hold, posts the digest |

Errors are `{ "error": "…", "code": "LEASED", "hint": "…" }`. Branch on `code`, follow `hint`. Codes:

| Group | Codes |
|---|---|
| Held or blocked | `LEASED` `NOT_LEASED` `BOARD_HELD` `LEASES_ACTIVE` `BLOCKED` `WIP_LIMIT` `LOCKED_COLUMN` |
| Not yours to do | `HUMAN_ONLY` `OWN_WORK` `OUT_OF_SCOPE` `NOT_DELEGABLE` `FORBIDDEN` `UNAUTHORIZED` |
| Wrong input | `BAD_REQUEST` `UNKNOWN_FIELD` `IMMUTABLE` `EXPLICIT` `BAD_EMOJI` `MODEL_NOT_ALLOWED` `WIDEN` `NO_AGENT` |
| Wrong state | `VERSION_CONFLICT` `REVIEW_OPEN` `NOT_TEST` `NOT_FOUND` `ARCHIVED` `LOCKED` `CONFLICT` `TOO_LARGE` |
| Agent management | `STANDING_AGENT` `ONLINE` `HOLDS_LEASES` |

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
Reviews explain themselves in five parts: `changed` (what changed), `why` (the reasoning, and alternatives you rejected), `evidence` (what proves it works: screenshots, outputs, tests), `verify` (how the human can check it) and `risks` (risks and open questions). The review card shows each part in full. A single `summary` still works.

Keep `changed` short, plain and to the point. A non-technical reader should be able to follow it: say what the change does for the user, and name files, functions or flags only where the change needs them. Keep the other three parts as complete as they need to be. Example:
- Before: "server.js (requestReview): counts commits via worktrees.commitsFor and stores `landing` on the review question; app.js renders a `.rv-does` line and a conditional button label."
- After: "The review card now says what Approve will do, and the button says *Approve and land* when agent commits are waiting."
When the human wants more, they **Ask why** — a comment with `intent: "explain"`, addressed to you if it @mentions you or, if not, to whoever requested the review or last worked the ticket. It arrives as an `[EXPLAIN ONLY]` event and tops your `…/work`. Answer in a comment and change nothing else: not the code, the ticket, its column or the review — the review stays open while they read your answer.

### Request review (preferred way to finish)
`POST /api/boards/main/items/INT-12/review { "summary": "What changed and how to verify" }` — moves it to the review column, comments your summary, releases your lease and raises a **review** request.
**Evidence is required.** The human approves only what they can see working, so every review carries `evidence`: screenshots (attach them to the ticket and name them), the command you ran and its output, test results, and for anything visible, what to look at in the Preview. A review without it comes back with a warning. On a board whose code is Intellagent itself, the review card has a **Preview** button: the board runs the author's branch on a temporary board (`sandboxes/preview/`, a fresh copy of the tickets) and opens it signed in, so commit everything the ticket needs before you ask (`POST …/items/<ID>/preview`, human only; `"preview": true` in `GET /api/app` says the board can).
The human decides with `POST …/review/decision { "verdict": "approve" | "changes", "comment": "…" }` (human only): approve moves it through the gate; changes moves it back to the working column. Moving a ticket with an open review into an approval gate (e.g. dragging it to Done) counts as approve. You receive `review.approved` or `review.changes_requested` (with `feedback`), and `GET …/work` lists it under `feedback` until you `start` it again.

### End a session
`POST /api/boards/main/finish { "summary": "markdown", "items": ["INT-12"] }` releases every lease you hold (and the master lease) and posts the summary to the digest. Standing-agent runs that exit cleanly get this release automatically.

### Metrics
`GET /api/boards/main/metrics?days=7` (or 30): tickets done (and the previous window), median cycle time (working column → done), median time in each column, open questions and how long the oldest has waited, and how fast the human answers. The UI shows it as a strip under the top bar.

### Daily digest
At the end of a session: `POST /api/boards/main/digest { "summary": "markdown", "items": ["INT-12"] }`. Read what others wrote with `GET /api/boards/main/digest?days=3` — a cheap way to catch up.

### Approval gates
Columns with `humanOnlyIn` / `humanOnlyOut` can only be entered / left by a human (`403` for agents). By default **Done** is human-only: move finished work to **Review** and let the human accept it.

A **sleeping** column (`flags.sleeping`, e.g. Backlog) holds work nobody should start yet. Assigning a ticket there wakes nobody; agents cannot start it there (`409 SLEEPING`) and it is not in their work. Moving it out — into Ready — wakes its assignee. On a board with a sleeping column, agents file new tickets into it (`403 SLEEPING` elsewhere); the **coordinator** decides where a ticket an agent filed goes (leave it asleep, or create or move it into any column it may use), and only the human wakes the human's own tickets.

### Grants: powers the human delegates
Some agents may do human-only things because the human said so — in **agents.json** (or the manifest's `permissions.<name>.grants`), or on the Agents page (an agent's *Edit* › Grants), which only works for the signed-in human on a board with a sign-in token (`intellagent token`; without one the API answers `403 NO_TOKEN`). Agents can never set grants:
```jsonc
"approver":   { "role": "reviewer", "grants": ["review.decide"] },
"gatekeeper": { "enabled": false, "grants": [{ "power": "column.gate", "where": { "column": "Done", "fields.risk": "low" } }] }
```
- `review.decide` — `POST …/review/decision`; the verdict is final, moves the ticket on, and is recorded as delegated (`review.delegated`, the event's `delegated`, a note in the comment).
- `column.gate` — move tickets into / out of human-only columns (a ticket with an open review must be decided instead: `409 REVIEW_OPEN`).
- `agents.control` — pause / resume / run *other* standing agents. Defining agents and grants stays with the human.
- `agents.manage` — `PATCH /api/agents/<name> { label?, glyph?, color?, alignment?, description?, role?, model?, perms?, permissions?: { columns?, readOnly? } }` on *other* standing agents (`where: { "agents": [names] }` limits which). Models only from the allowlist (`managerModels` in the manifest; default haiku, sonnet, opus); tool `perms` and board `permissions` can only narrow (stored as `limits` in agents.json, intersected with the manifest). Never the run command, grants, enabled, env or its own record (`403 NOT_DELEGABLE` / `OWN_WORK`). Every change is kept with before/after on the agent (Agents page, with Revert), emitted as `agent.managed`, and written to the digest.
- `where` limits a grant to tickets matching every key (`column`, or any dotted path such as `fields.risk`, `properties.area`; a value or a list). `reviewers.<name>` matches that reviewer's current verdict: `{ "power": "review.decide", "where": { "reviewers.nebula": "ok" } }` lets an agent approve what that reviewer passed.
- A delegated approval needs evidence in the review (`409 NO_EVIDENCE`) and no reviewer with concerns (`409 CONCERNS_OPEN`); without them only the human approves. An agent with `review.decide` sees each ticket waiting for a decision in its `…/work`: `decide` when everything is in, `chase` naming what is missing (a reviewer, a verdict, evidence, answered concerns) so it can @mention whoever owes it. Each wakes it once per change.
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

**Alerting another agent: @mention it.** Most agents wake only when they are addressed, so "Rocket, take this" wakes nobody; "@rocket, take this" does (so does assigning the ticket). An @ inside `code` or a `>` quote does not count. When an agent names another standing agent without @, the comment is still saved, and the reply carries a `warning` saying who was not alerted. Every brief carries this rule.

**What not to post.** Keep cards and the digest readable: no step-by-step progress logs, nothing git already shows (diffs, file lists), no restating the ticket. Post decisions, blockers, results and how to verify.

**Requests.** The human's free-form asks ("create tickets for X") are *requests*, sent to the board's coordinator or a named agent. They arrive as `handle_request` in `…/work`: do it, then `POST …/requests/<id>/reply { "body": "what you did, with ticket ids", "done": true }`. `GET …/requests` lists them; `POST …/requests { "body": "…", "to": "<agent>" }` sends one (to the coordinator if `to` is omitted). A request is usually a follow-up: its event carries `history`, the conversation so far with you (the last 10 messages of the week, oldest first), and your prompt shows it — answer the latest message in that context.

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
- **Supervision:** an agent with `supervise: true` (the coordinator role, by default) also hears about tickets another *standing* agent was given but isn't working on — its agent is paused or failed, or nobody holds the ticket, the agent is idle and nothing has happened on it for `superviseMinutes` (default 30). They show as `supervise` actions in its `…/work` and wake it once per stall; it resumes or runs the agent (with the `agents.control` grant) or @mentions it. After two unanswered nudges in a row it stops and leaves the ticket to the human. A new ticket the human already assigned to someone else doesn't wake the coordinator for triage.
- **Speciality:** `areas` (files and folders it owns: guidance for it and for routing, not a limit), `concerns` (what it checks before asking for review) and a context page, `agent-context/<name>.md` beside agents.json (or inline `context`; capped at 8k characters). The agent gets them first thing on each session's first turn and in its brief; the receptionist routes by areas first, then role, then tier. Edit them on the Agents page (agent profile › Speciality, with repo path suggestions from `GET /api/files?q=`), with `PATCH /api/agents/<name> { areas, concerns, context }` or `intellagent agents add … --areas … --concerns …`.
- **Reviewers:** an agent with `reviewer: true` (the reviewer role by default; the *Can review* switch in its Speciality) may be asked to review. The receptionist gets an `assign_reviewer` action for each ticket in review without one, and picks a reviewer whose areas or concerns fit: `POST …/items/<ID>/reviewers { name }` (the human or the receptionist only). **Never the author:** anyone who worked on the ticket, asked for its review or is assigned to it is refused (`403 OWN_WORK`), also if they start working on it later. The reviewer gets a `review_ticket` action and answers with `POST …/items/<ID>/reviewers/<name>/verdict { verdict: "ok" | "concerns", comment }`: a ✅ or ⚠ comment (concerns @mention the author) and a tick on the card. Reviewers never decide the review or move the ticket; the human approves. A new review request resets the ticks and wakes the reviewers again.
- `model` (per agent or in `defaults`): passed to the `claude` run as `--model` (a `run` that already names `--model` keeps it). Use it for **tiers**, and the receptionist's brief lists the team with role, model and description so it routes by them:
  ```jsonc
  "junior": { "role": "builder", "model": "haiku",  "description": "Small, well-specified tickets" },
  "mid":    { "role": "builder", "model": "sonnet", "description": "Normal features and bugs" },
  "senior": { "role": "builder", "model": "opus",   "description": "Risky or cross-cutting work (risk: high)" }
  ```
  `intellagent agents add junior --role builder --model haiku` writes the same.
- `keepAlive: true` (per agent or in `defaults`): instead of a fresh `claude -p` per wake, the agent keeps **one live session**, and each wake is a new turn in it (stream-json on stdin; the turn ends at its `result`). Only the session's first turn gets the full prompt (role brief, rules, "start with intellagent brief"); later turns get just the new events, any retry notes and a one-line reminder, since the rest is already in context — so a wake costs little more than its new events. The session is replaced after `recycleAfterRuns` turns (default 20), once its context per model call passes `recycleAboveTokens` (default 120000; `0` = off; shown on the Agents page), after a failed turn, on pause, removal or a board restart; a crash mid-turn is retried like any failed run. **Trade-off:** context grows and what the session remembers can go stale — the board always wins, so check `…/work` each turn (and the brief whenever the board rules matter). A custom (non-claude) `run` used with keepAlive must speak the same protocol. Inside a session, `intellagent api` and the MCP tools pick up the current run from `INTELLAGENT_RUN_FILE`.
- **Own worktree** (`worktree`, on by default for agents that edit files): each such agent works in its own git worktree on branch `agent/<name>` (in `.intellagent/worktrees/`, or `.worktrees/` beside a manifest at the repo root; git-ignored), so agents never overwrite or commit each other's half-finished work. Before each run it catches up with main (reset to main once all its work has landed, else merged; a conflict is reported in the prompt). Put the ticket id in every commit message. Requesting review lists the ticket's commits; **approving lands them on main** (a cherry-pick into the main checkout, only when that checkout has no uncommitted changes — otherwise the card says to run `intellagent merge <ID>` once it's clean). `"worktree": false` opts out.
- `commands` (per agent): exact extra commands the human allows it, e.g. `"commands": ["npm run measure:board"]`. Each one is allowed exactly as written; a trailing `:*` allows that one command with any arguments (`"npm run measure:board:*"`); anything else with a wildcard, quotes or shell punctuation is dropped. Only for agents whose run is built from their permissions.
- `run`: the command (default `claude -p …`). It gets the events as a prompt on stdin, `INTELLAGENT_AGENT`, `INTELLAGENT_URL` and `INTELLAGENT_EVENTS` (JSON file) in its environment, and runs in the project folder.
- **One run per agent at a time**; events that arrive meanwhile go into the next run.
- **Signs of life:** while a run is going, `GET /api/agents` gives `lastActivityAt` (its last call to the board or output in its log) and `stalled: true` once that is older than `stallMinutes` (default 10; `0` = never). A one-shot run prints nothing until it ends, so a long build or test without board calls also counts as stalled: it is a hint for the human, and nothing is killed. After a run, `lastRun.about` still says which tickets and requests it was woken to answer.
- **What a run is doing:** `now: { since, why, items, line }` per agent while a run is live (`null` otherwise). `line` is the newest of its own status line and the status of a ticket it holds. A run that holds no ticket (triage, reviewing, answering a request) sets its own with `PUT /api/profiles/me/status { status, items? }` (`""` clears; CLI `intellagent do set_activity status="…"`). Only your own line, never another agent's. It emits `agent.activity { agent, line, items }`, which wakes nobody (no recipients; at most one every 2 s per agent), and it ends with the run. `agent.run.started` carries `why`. Each agent keeps `history`, its last 10 runs `{ startedAt, durationMs, code, why, items }`, across restarts; `GET /api/agents?recent=10` adds the 10 newest across all agents.
- A run that fails, times out or is cut off by a restart is **retried automatically** with the same events (the prompt says it was interrupted — check for half-finished work). After `maxFailures` in a row the agent is **flagged failed** and waits for the human.
- `maxRunsPerHour` (default 20; `null` = no limit) and `throttleMinutes` (default 3; `0` = off): a quiet agent wakes as soon as something arrives, but for `throttleMinutes` after each wake further events wait and arrive together in one run — editing ten tickets in a row wakes it at most twice.
- Each run starts with no memory: **everything worth keeping goes on the card.**
- **Stop all agents** (Agents page, or `POST /api/agents/stop-all`; human or the `agents.control` grant): kills every run (not counted as a failure; its events stay queued), pauses every standing agent, releases agent leases and an agent's master lease, and moves the tickets they were working on in the working column back to Ready with a ⏹ comment (assignee kept). `POST /api/agents/resume-all` brings them back.
- **Stale work goes back:** a ticket left in the working column with no lease, no running agent and no activity for `staleWorkMinutes` (manifest, default 120; `0` = off) returns to Ready with a ⏸ comment. A person's own tickets are never swept.
- `intellagent agents` lists them; `agents add|pause|resume|run|log|remove <name>`. `GET /api/agents` shows status, queue and the last run; pause/resume/run are human-only. `intellagent autostart on` starts the board (and so its agents) at login.
- An open-ended master lease ends by itself after `masterIdleMinutes` (manifest, default 120) without activity from its holder, unless the holder is a standing agent mid-run.

Your inbox already includes tickets you created, leased (now or before), commented on, were assigned or @mentioned on — and, while you hold the master lease, every ticket on the board.

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
- HTTP for other tools: `GET /status`, `GET /machine`, `POST /ask`, `POST /leases/<id>/renew|done`, `PUT /ceiling`. Only programs on this PC: the Host must be `127.0.0.1:7499` or `localhost:7499`, a request with an `Origin` header (a web page) is refused, and writes need `content-type: application/json`. Errors are `{ error, code, hint }`. The CLI starts the program when it is not running; `intellagent leases start|stop` by hand.

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
The manifest may restrict agents (`permissions: { "<name>" | "*": { "columns": ["Backlog","Ready"], "readOnly": false } }`) and require tokens (`auth.agentTokens`). Check yours with `GET /api/permissions/me`; send tokens as `Authorization: Bearer <token>`. The human's own token (from `intellagent init`) lives in `.intellagent/local.json`; without it, requests sending `X-User` are refused, so agents cannot act as the human. A board made before tokens existed gets one with `intellagent token` (then restart the board and `intellagent open` to sign in; `--rotate` replaces it).

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

**How the board is governed is the human's.** Agents get `403 HUMAN_ONLY` for adding, deleting or reordering columns, changing a column's known flags (`allowCreate`, `allowMoveIn/Out`, `wipLimit`, `releaseLeaseOnEnter`, `autoArchiveAfterDays`, `humanOnlyIn/Out`, `review`, `sleeping`, `pickup`, `working`), choosing the `coordinator`, changing the board rules (`directives`) and the built-in field settings (`PUT …/schema { builtins }`). A column's name, colour, icon and other custom flags, and declared fields, stay open to agents. To change the rest, ask on a card.

## 8. MCP, CLI and the agent skill

Agents reach the board three ways; pick the lightest that works:
- **MCP core** — `node intellagent/mcp.js` lists ten tools by default (`get_briefing`, `get_my_work`, `get_item`, `start_work`, `set_status`, `add_comment`, `ask_human`, `request_review`, `wait_for_events`, `finish_session`; plus `introduce_yourself` until the agent has a role): ~4.5k characters of tool definitions instead of ~21k. `INTELLAGENT_MCP_PROFILE=full` (or `--profile full`) lists all 55; `INTELLAGENT_MCP_TOOLS=name,name` lists your own set. Every tool stays callable by name in every profile.
- **CLI** — `intellagent do <operation> key=value …` runs any of those operations by name (same parameters as the MCP tools); `intellagent help <operation>` prints its exact request; `intellagent api <METHOD> <path> key=value …` calls any route. Output is JSON; on an error the reply stays on stdout and `error <status> <CODE>: <message> — hint: <hint>` goes to stderr with exit 1 (2: board unreachable or bad input, 3: no board). It never prompts; `INTELLAGENT_AGENT` sets who you are.
- **Skill** — `skills/intellagent/SKILL.md` (`intellagent skill install`) teaches the day-to-day loop and the CLI for everything beyond the core; it loads only when the agent works a ticket.

A narrow Claude Code permission rule for agents: `Bash(intellagent *)` plus the core tools by name (`mcp__intellagent__get_briefing`, …). `mcp__intellagent` alone allows whatever the server lists.

**A board kept outside the project:** set `projectRoot` in its manifest (`intellagent init --project <path>`, or `intellagent project <path>` on an existing board, then restart). Standing agents then run in that folder (worktrees are kept in the board's folder), the project's CLAUDE.md and git are read from there, and every brief names the folder. In the project, `intellagent link <board folder>` lets the CLI, MCP tools and the agents you start there find the board (`.intellagent/link.json`, git-ignored); `intellagent status` shows the project folder.

**A board of your own to try things on (sandbox).** `intellagent sandbox <you>` starts a throwaway board just for you, on a port that stays yours (7431, 7432, …), and prints its address and a sign-in link for its own human. `--from main | <agent> | <folder>` picks the code it runs — main, an agent's worktree (yours, to see your branch working, or the author's, to review it) or any checkout; `--seed demo | empty | snapshot` what it starts with (`snapshot` copies the real board's tickets: for reproducing what the human saw); `--fresh` wipes it. Run it again after changing code to restart it; its data stays. `sandbox list`, `sandbox stop <you> | --all`. Talk to it with `--url <its address>` on any command (or `INTELLAGENT_URL`); `--as <name>` sets who you are there (or `INTELLAGENT_AGENT`). It is safe by construction: standing agents never run on a sandbox (`sandbox: true` in its manifest), its sign-in token is its own, and nothing you do there reaches the real board. It lives in `sandboxes/<you>/` beside the real board's manifest (git-ignored).

Shell tips: the CLI finds this project's board by itself (nearest `.intellagent/`), or set `INTELLAGENT_URL`. key=value nests on dots (`fields.risk=low`) and parses JSON values; pass a JSON body as one argument, `@file.json` or `-` for stdin. Windows PowerShell: use `curl.exe`, not `curl`; prefer the CLI.

### Agent tokens
A board may require every agent to send a token (`auth.requireAgentTokens` in the manifest; **new boards from `intellagent init` turn it on**, existing boards are unchanged). Tokens live in `.intellagent/local.json` (git-ignored), and the CLI and MCP tools in the project send the right one by themselves. The human issues one with `intellagent token --agent <name>` (`--rotate` replaces it; the board accepts it at once); standing agents get one automatically. An agent elsewhere passes `INTELLAGENT_TOKEN`. Without one: `401` with a hint naming that command. The board stays on 127.0.0.1 unless you change `host`.

## 9. Setting up a board in a project

Asked to "set up Intellagent here"? Use the **intellagent-setup** skill (`skills/intellagent-setup/SKILL.md`). It stops and asks the human at three points (template and prefix, the proposed fields and rules, the seed tickets) and only touches `.intellagent/`, `.mcp.json`, `CLAUDE.md` and `.git/hooks/`, and only the ones the human agreed to. The commands it uses: `intellagent init --template <t> --name "…" --prefix XX`, `intellagent templates`, `intellagent status`, `intellagent hook install`, `intellagent autostart on`.

## 10. Route index

Every route the server has, for checking a call before you make it. `GET /api` lists the same routes live, each with its description. `:board` is `main` unless `GET /api/boards` says otherwise; `:id` is a ticket id, case-insensitive.

```
Orient       GET /api  /api/docs  /api/schema  /api/app  /api/boards  /api/templates  /api/presence  /api/permissions/me
             GET /api/boards/:board  …/hash  …/summary  …/brief  …/work  …/metrics  …/listeners
Tickets      POST …/items  …/items/bulk          GET …/items/:id  …/items/:id/history  …/items/:id/transitions
             PATCH …/items/:id                   POST …/items/:id/move  …/comments  …/attachments  …/reactions  …/archive
             DELETE …/items/:id (test tickets)   DELETE …/items/:id/attachments/:att  …/reactions  …/test-items
Working      POST …/items/:id/start  …/review  …/review/decision (human or grant)  …/attention  …/finish  …/digest
             PUT …/items/:id/status              DELETE …/items/:id/attention        GET …/digest
             POST …/items/:id/questions/:qid/withdraw
Leases       POST …/items/:id/lease  …/lease/request  …/lease/handover  …/lease/decline   DELETE …/items/:id/lease
             GET/POST/DELETE …/master            PUT …/master/status
Requests     GET/POST …/requests                 POST …/requests/:id/reply  …/requests/:id/withdraw
Archive      GET …/archive                       POST …/archive  …/archive/:id/restore
Columns      GET/POST …/columns                  PATCH/DELETE …/columns/:column    GET …/columns/:column/items
Schema       GET/PUT …/schema                    POST …/schema/fields              PATCH/DELETE …/schema/fields/:key
             GET/POST …/ticket-templates         PATCH/DELETE …/ticket-templates/:key
Rules        GET/PUT …/directives                PATCH /api/boards/:board          POST /api/boards      PATCH /api/app
Search       GET/POST /api/search
Events       GET /api/events  /api/events/wait  /api/stream
             GET/POST /api/subscriptions         DELETE /api/subscriptions/:id     GET …/:id/next   POST …/:id/ack
Agents       GET/POST /api/agents  /api/agents/roles  /api/agents/:name  …/:name/log     PATCH/DELETE /api/agents/:name
             POST /api/agents/stop-all  /api/agents/resume-all  /api/agents/:name/pause  …/resume  …/run
Profiles     GET /api/profiles  /api/profiles/me  /api/names/suggest     PATCH /api/profiles/me     DELETE /api/presence/:name
Files        GET /avatars/:file  /files/:board/:file
```

`/api/boards/:board` is shortened to `…` in the table. Human-only actions (pausing or running standing agents, review decisions without a grant) answer `403 HUMAN_ONLY`.
