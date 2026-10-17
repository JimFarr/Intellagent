---
name: intellagent-setup
description: Set up an Intellagent kanban board in the current project and shape it to the work — template, columns, ticket fields, standing rules, seed tickets, MCP and git wiring. Use when the user asks to set up, add, install or initialise Intellagent, an agent kanban, or a task board for coordinating with agents in a project.
---

# Set up Intellagent in this project

Intellagent is a local kanban that the human and agents share: the human steers work by editing tickets, answering questions and approving reviews; agents work through its HTTP API. Your job is to give this project a board and a team that fit it, **with the human deciding at the checkpoints (✋)**. Nothing is switched on, added or granted without their yes: every feature below is an option you explain, recommend a setting for and ask about.

Use `intellagent api <METHOD> <path> [key=value … | json | @file | -]` for API calls (it finds this project's board automatically and refuses if there is none). Set `INTELLAGENT_AGENT` to your name for every call. Prefer `key=value` arguments (`title="Fix login" priority=High fields.risk=low`) — they avoid shell quoting problems on every platform.

## 1. Preconditions

- Run `intellagent help`. If the command is missing, stop and tell the user: clone/locate the Intellagent folder and run `npm link` there.
- Run `intellagent status`. If it reports an existing `.intellagent/` manifest, this project is already set up: skip to step 6 and offer to reshape it rather than re-initialising.

## 2. Understand the project (no questions yet)

Read just enough to make good recommendations:
- README, CLAUDE.md / AGENTS.md, CONTRIBUTING
- Package manifests and the top-level folder layout
- How tests and linting run
- Rough count of `TODO` / `FIXME` comments (search the repo)
- Open issues, if the `gh` CLI is available: `gh issue list --limit 30`

## 3. ✋ Ask what the board is for

Before any setting, ask one round (the recommended answer first, from what you read in step 2):
1. **Kind of work** — a code project; a big or long-lived codebase; UI-heavy; writing; research; support or operations; something else.
2. **Team size** they want to pay for — each standing agent is a model running when it is woken, so a bigger team costs more.
3. **How hands-off** — approve everything themselves (recommended to start); let a trusted agent approve low-risk work that a reviewer passed; mostly unattended.

These answers drive the template or preset in step 4 and the team in step 8.

## 4. ✋ Ask the setup details

Ask the user in a single round (use the AskUserQuestion tool if available, max 4 questions, recommended option first):
1. **Template or preset** — run `intellagent templates` and `intellagent preset list`; recommend `software`, `research` or `ops` based on step 2, or a preset when one fits the work better (`stories` is for writing, not code). A preset can bring column rules the human should see first: see step 5.
2. **Name and ticket prefix** — default to the folder name and its initials.
3. **Seed tickets from** — TODO comments / GitHub issues / a plan they paste / nothing for now.
4. **Wiring** — by default `init` registers the MCP tools (`.mcp.json`, the small core profile), appends a short block to CLAUDE.md that points agents at `intellagent brief`, and names the default agent `claude`. Ask only if they want to opt out (`--no-mcp`, `--no-claude`) or use another agent name (`--agent`). Suggest `intellagent skill install` too: the `intellagent` skill teaches agents the day-to-day loop and the CLI.
   **Board outside the project?** If the board must live somewhere other than the code, pass `--project <path to the code>` to init (or run `intellagent project <path>` later), and run `intellagent link <board folder>` inside the project so agents working there find the board.
   **Safety:** the board listens on 127.0.0.1 only, and new boards require agent tokens (the default agent gets one in `.intellagent/local.json`, git-ignored; `--open-agents` turns this off). Any other agent needs `intellagent token --agent <name>` from the human; standing agents get theirs automatically.

## 5. Scaffold and start

```
intellagent init --template <t> --name "<name>" --prefix <PFX>
intellagent init --preset <name|folder> --name "<name>" --prefix <PFX>   # instead, for a preset
intellagent status           # it is already running in the background; note the URL
intellagent brief            # exactly what agents will see: next steps, columns, templates, calls
```
**A preset first lists the powers it gives (human-only columns, read-only fields, board rules) and asks.** You have no terminal, so run `init --preset …` without `--yes` once: it prints the list and stops. Show that list to the user in your own words, and only when they agree run it again with `--yes`.
`init` starts the board in the background, opens it signed in for the user, and writes the user's token to `.intellagent/local.json` (git-ignored). Don't open or print that file.

## 6. Draft the tailoring (don't write yet)

- **Field options** that match the project. For `software`, set the `area` tag options from real top-level folders/packages; adjust `estimate` units if the team uses points.
- **Board rules** about how to use the board only (where work comes from, when to ask on a card, review, digest). Start from the template's rules. **Do not copy CLAUDE.md or other conventions into them** — the board shows the project's CLAUDE.md read-only next to its own rules, so copying creates two sources of truth. If a convention is missing from CLAUDE.md, propose adding it there.
- **Column changes** only if the template clearly doesn't fit.

## 7. ✋ Confirm the shape

Show the user, in one message, the proposed fields (key, type, options), the board rules (and any CLAUDE.md additions you suggest), and any column changes. Apply only what they approve:
- Fields, yourself: `POST /api/boards/main/schema/fields` or `PATCH /api/boards/main/schema/fields/<key>`
- Board rules and column changes are the human's (agents get `403 HUMAN_ONLY`): give the user the final rules text to paste into Settings › Rules, and the column changes to make in Settings › Columns.

## 8. ✋ Recommend a team

From the answers in step 3, recommend a team **with the reason for each member**, and let the user accept it, edit it or start smaller. A second builder only adds conflicts until the first has more work than it can finish, so lean small.

| Kind of work | Team | Why |
|---|---|---|
| Small project, one person | coordinator (haiku) and one builder (sonnet); the human approves everything | Cheap, and nothing to collide. |
| Big or long-lived codebase | coordinator; a **senior** builder (opus) for the core; a **mid** builder (sonnet) for features; a **junior** (haiku) for small, well-specified tickets; a **reviewer** (sonnet); a **lander** that lands approved work and keeps main green; a **helper** for chores | One senior cannot carry the core of a big project: split it between seniors by files if you need two. |
| UI-heavy | add a **designer** and a reviewer who can open a browser | Only they can see what a person sees. |
| Writing | the `stories` preset: drafter, lore keeper, continuity editor, publisher | Different permissions: folders, not code. |
| Research | one or two **researchers** and an editor to check the sources | Mostly read and cite. |

Rules of thumb to say out loud:
- Give each agent its own **areas**, by files. Overlapping areas are where conflicts and pile-ups start.
- If more than about six tickets queue for a day, rebalance the work first, then add an agent.
- A reviewer is never the author of the work; use two reviewers on risky changes.
- A helper is an agent with `"helper": true` in agents.json: builders call on it with a request for a chore, and only the human assigns it a ticket.
- Keep-alive (below) saves cost, because a session's first turn is the expensive one.

The roles on offer are in `GET /api/agents/roles` (coordinator, builder, reviewer, researcher, designer, writer); a tier is `--model haiku|sonnet|opus`. **Agents are the human's to add** (`403 HUMAN_ONLY` for you): give them the exact commands, one per member, and run nothing yourself. For example:
```
intellagent agents add rocket --role builder --model opus --areas "server.js,lib/" --concerns "permissions,data"
intellagent agents add mid --role builder --model sonnet --areas "public/,cli.js"
intellagent agents add nebula --role reviewer --model sonnet
```
Each new agent introduces itself on its first run (name, look, what it does), so ask the user to expect that first message on the board.

## 9. Introduce yourself

`PATCH /api/profiles/me` with `color`, a `glyph` (1–2 characters or an emoji), a short `label`, and a `description` of your role on this project.

## 10. ✋ Seed tickets

Collect candidates from the agreed source and de-duplicate them. If there are more than ~10, show the list (title, type, priority, parent) and let the user trim it. Then create them:
- `type`: issue (broken), task (work), spike (research); `priority` honestly — most things are Medium.
- Group related tickets with the same `parent`.
- Put checklists in descriptions (`- [ ] step`) so cards show progress.
- Add `blockedBy` links only where the dependency is real.
- Keep the first batch under ~25 and mention what you left out.

## 11. Wire up

- In a git repo, offer `intellagent hook install` (links commits mentioning ticket IDs).
- If you will be the only agent working this board, take the master lease: `POST /api/boards/main/master { "status": "…" }` (release it before spawning helpers).
- Explain how answers on cards reach an agent: `intellagent wait --agent <name>` in the background during a session, or a **standing agent** for unattended work — offer `intellagent agents add <name>` (and `--listen human` for a coordinator) plus `intellagent autostart on` so the board and its agents come back after a reboot. Ask before adding either.
- **Permissions beyond the built-ins.** A standing agent's tools come from its `perms` (`read edit test build git web`). When the project needs something more (a deploy command, an MCP tool, writes limited to `docs/**`, a bundle of these), the human can add a **custom permission** to the library (`GET /api/permissions` lists it), and an agent holds it like a built-in. Only the human adds them (agents get `403 HUMAN_ONLY`), so suggest the exact `POST /api/permissions` body and let them run it, e.g. `{ "key": "deploy-staging", "kind": "command", "name": "Deploy to staging", "commands": ["npm run deploy:staging"], "needs": ["test"] }`. A `folders` permission needs `read`, not `edit` (which would undo its limit). A **verbal** permission is only words in the brief and nothing enforces it, so say so when you suggest one. The kinds are listed in AGENTS.md, under "The permission library".
- **Roles beyond the built-ins.** `intellagent agents add <name> --role builder` starts an agent from a built-in role (coordinator, builder, reviewer, researcher, designer, writer; `GET /api/roles` lists them). When the team needs a kind of agent none of them fits (a triager, a translator), the human can add their own role under `"roles"` in `.intellagent/agents.json`, e.g. `"triager": { "label": "Triager", "description": "Sorts new tickets", "brief": "Your role: triager. …", "perms": ["read"], "model": "haiku" }`, then `--role triager`. Suggest the entry and let the human add it: agents.json is the human's file. A role can't reuse a built-in's name and never carries grants (those go on each agent), and only the human gives an agent a custom role. A role that doesn't check out is named in `GET /api/roles` → `errors`.
- **Agent memory.** Every agent keeps a few notes of its own across runs, shown in its brief (AGENTS.md, "Your memory"); the human tells one to remember something with a comment starting "@name remember that …". For an agent that will read outside content (web pages, pasted text, issues from strangers), suggest the human switch its memory off, so an instruction hidden in that content can't stick: `PUT /api/profiles/<name>/memory { "on": false }` (human only).

## 12. ✋ Walk the features as choices

Not a lecture: for each feature give **one line on what it is, the setting you recommend for their kind of work, and one question**. Ask in one or two rounds, skip what does not fit, and change nothing without the user's yes. Most of these are the human's to switch (`403 HUMAN_ONLY` for you), so hand over the call or the Settings page.

| Feature | What it is | Recommend | Ask |
|---|---|---|---|
| **Focus boards** | A saved view of a few tickets; while one is active, agents work only on those. | Mention it; nothing to set up. | "Do you want to steer agents onto a handful of tickets at times?" |
| **Permissions** | An agent's tools come from its `perms` (`read edit test build git web`); the human can add custom ones (`GET /api/permissions`). A **verbal** permission is only words in the brief and nothing enforces it. | Built-ins only at first. | "Does any agent need more (a deploy command, writes only under `docs/**`)?" Say the verbal warning if they pick one. |
| **Approvals for you** | The human can let one agent approve for them (`review.decide` grant), only on tickets that match, never on its own work, and one switch turns all of it off. | Off. If they want hands-off: low-risk tickets with a reviewer's ok, and the reviewer is not the approver. | "Should an agent approve low-risk work for you?" |
| **Board admin** | The human can hand out the board's settings one piece at a time (`admin.columns`, `admin.rules`, `admin.coordinator`, `admin.fields`, `admin.focus`, `admin.cardRules`, `admin.rebalancing`, or `admin` for all). An agent with one may never lift an approval gate, choose itself as coordinator, or touch tokens, grants and run commands, and one switch (`PUT …/admin { on: false }`) suspends them all. | Off. Offer at most `admin.focus` or `admin.cardRules` to the coordinator, and only if the human wants it to tidy the board. | "Should an agent be able to change any board settings for you, such as focus boards?" |
| **Landing** | Approved work reaches main by a cherry-pick; the `work.land` grant lets a lander agent retry a failed landing. | A lander on a big project; otherwise the human. | "Should one agent land approved work and keep main green?" |
| **The helper** | Not a separate feature: an ordinary builder on a cheap model (`--model haiku`) that other agents hand chores to (a slow test run, logs, a small exact edit) with a request: `POST /api/boards/main/requests { "to": "<helper>", "body": "…" }`. It replies on the request. | One helper once there are two builders; tell the builders its name in their `description`. | "Do you want a cheap helper for chores? What should it be called?" Add it like any builder: `intellagent agents add cosmo --role builder --model haiku --description "Takes chores for the builders: test runs, logs, small edits"` |
| **Keep-alive and cost** | `keepAlive` keeps one live session per agent; later wakes cost little, but its context grows and can go stale. | On for agents that wake often, with the default recycling. | "Cheaper per wake, with a longer memory, or a fresh start every time?" |
| **Idle-board alarm** | Wakes named agents when tickets wait and no builder has run for N minutes. | On, 20 minutes, waking the coordinator. | "Should the board nudge someone when work waits and nobody is building?" |
| **Reviewers** | An agent with `reviewer: true` gets asked to check work in Review and gives an ok or concerns; the human still decides. | At least one on a team of two or more builders. | "Who reviews, and what do they check?" |
| **Prometheus and Grafana** | `GET /metrics` serves the board's numbers (tickets per column, runs, tokens, open questions) to Prometheus, with a dashboard to import (`docs/grafana/`). Off until the manifest has `"metrics": { "prometheus": true }`; then it answers only to a read-only metrics token, issued with `intellagent token --metrics`, that opens nothing else. | Off. Only for someone who already runs Prometheus and Grafana. | "Do you already chart things in Grafana, and want the board in it?" If yes, the human adds the manifest line, restarts the board and runs the token command themselves (it is theirs: `403 HUMAN_ONLY`/the CLI refuses an agent); point them to `docs/grafana/README.md`. |

Features that are not on the board yet (card rules, rebalancing, analytics, agent memory, the base context and its layers, permissions "with rules") get their option when their ticket lands; do not offer them, and if the user asks, say they are coming.

## 13. Hand over

- `POST /api/boards/main/finish { "summary": "…" }` summarising what you set up (it also releases anything you hold).
- Raise *needs you* (`POST /items/<id>/attention`) on anything you were unsure about — on the card, not only in chat, so the answer stays with the work.
- Tell the user the board URL (or run `intellagent open`), what was created, and how to use it: answer questions on cards, approve reviews, edit standing rules.

## Boundaries

- Only create or modify `.intellagent/`, `.mcp.json`, `CLAUDE.md` and `.git/hooks/` — and only those the user agreed to in step 4.
- Never write the board's `data/` files directly; everything goes through the API.
- Don't start working tickets as part of setup unless the user asks.
