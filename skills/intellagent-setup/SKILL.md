---
name: intellagent-setup
description: Set up an Intellagent kanban board in the current project and shape it to the work — template, columns, ticket fields, standing rules, seed tickets, MCP and git wiring. Use when the user asks to set up, add, install or initialise Intellagent, an agent kanban, or a task board for coordinating with agents in a project.
---

# Set up Intellagent in this project

Intellagent is a local kanban that the human and agents share: the human steers work by editing tickets, answering questions and approving reviews; agents work through its HTTP API. Your job is to give this project a board that fits it, **with the human deciding its shape at three checkpoints (✋)**.

Use `intellagent api <METHOD> <path> [key=value … | json | @file | -]` for API calls (it finds this project's board automatically and refuses if there is none). Set `INTELLAGENT_AGENT` to your name for every call. Prefer `key=value` arguments (`title="Fix login" priority=High fields.risk=low`) — they avoid shell quoting problems on every platform.

## 1. Preconditions

- Run `intellagent help`. If the command is missing, stop and tell the user: clone/locate the Intellagent folder and run `npm link` there.
- Run `intellagent status`. If it reports an existing `.intellagent/` manifest, this project is already set up: skip to step 5 and offer to reshape it rather than re-initialising.

## 2. Understand the project (no questions yet)

Read just enough to make good recommendations:
- README, CLAUDE.md / AGENTS.md, CONTRIBUTING
- Package manifests and the top-level folder layout
- How tests and linting run
- Rough count of `TODO` / `FIXME` comments (search the repo)
- Open issues, if the `gh` CLI is available: `gh issue list --limit 30`

## 3. ✋ Ask once

Ask the user in a single round (use the AskUserQuestion tool if available, max 4 questions, recommended option first):
1. **Template or preset** — run `intellagent templates` and `intellagent preset list`; recommend `software`, `research` or `ops` based on step 2, or a preset when one fits the work better (`stories` is for writing, not code). A preset can bring column rules the human should see first: see step 4.
2. **Name and ticket prefix** — default to the folder name and its initials.
3. **Seed tickets from** — TODO comments / GitHub issues / a plan they paste / nothing for now.
4. **Wiring** — by default `init` registers the MCP tools (`.mcp.json`, the small core profile), appends a short block to CLAUDE.md that points agents at `intellagent brief`, and names the default agent `claude`. Ask only if they want to opt out (`--no-mcp`, `--no-claude`) or use another agent name (`--agent`). Suggest `intellagent skill install` too: the `intellagent` skill teaches agents the day-to-day loop and the CLI.
   **Board outside the project?** If the board must live somewhere other than the code, pass `--project <path to the code>` to init (or run `intellagent project <path>` later), and run `intellagent link <board folder>` inside the project so agents working there find the board.
   **Safety:** the board listens on 127.0.0.1 only, and new boards require agent tokens (the default agent gets one in `.intellagent/local.json`, git-ignored; `--open-agents` turns this off). Any other agent needs `intellagent token --agent <name>` from the human; standing agents get theirs automatically.

## 4. Scaffold and start

```
intellagent init --template <t> --name "<name>" --prefix <PFX>
intellagent init --preset <name|folder> --name "<name>" --prefix <PFX>   # instead, for a preset
intellagent status           # it is already running in the background; note the URL
intellagent brief            # exactly what agents will see: next steps, columns, templates, calls
```
**A preset first lists the powers it gives (human-only columns, read-only fields, board rules) and asks.** You have no terminal, so run `init --preset …` without `--yes` once: it prints the list and stops. Show that list to the user in your own words, and only when they agree run it again with `--yes`.
`init` starts the board in the background, opens it signed in for the user, and writes the user's token to `.intellagent/local.json` (git-ignored). Don't open or print that file.

## 5. Draft the tailoring (don't write yet)

- **Field options** that match the project. For `software`, set the `area` tag options from real top-level folders/packages; adjust `estimate` units if the team uses points.
- **Board rules** about how to use the board only (where work comes from, when to ask on a card, review, digest). Start from the template's rules. **Do not copy CLAUDE.md or other conventions into them** — the board shows the project's CLAUDE.md read-only next to its own rules, so copying creates two sources of truth. If a convention is missing from CLAUDE.md, propose adding it there.
- **Column changes** only if the template clearly doesn't fit.

## 6. ✋ Confirm the shape

Show the user, in one message, the proposed fields (key, type, options), the board rules (and any CLAUDE.md additions you suggest), and any column changes. Apply only what they approve:
- Fields, yourself: `POST /api/boards/main/schema/fields` or `PATCH /api/boards/main/schema/fields/<key>`
- Board rules and column changes are the human's (agents get `403 HUMAN_ONLY`): give the user the final rules text to paste into Settings › Rules, and the column changes to make in Settings › Columns.

## 7. Introduce yourself

`PATCH /api/profiles/me` with `color`, a `glyph` (1–2 characters or an emoji), a short `label`, and a `description` of your role on this project.

## 8. ✋ Seed tickets

Collect candidates from the agreed source and de-duplicate them. If there are more than ~10, show the list (title, type, priority, parent) and let the user trim it. Then create them:
- `type`: issue (broken), task (work), spike (research); `priority` honestly — most things are Medium.
- Group related tickets with the same `parent`.
- Put checklists in descriptions (`- [ ] step`) so cards show progress.
- Add `blockedBy` links only where the dependency is real.
- Keep the first batch under ~25 and mention what you left out.

## 9. Wire up

- In a git repo, offer `intellagent hook install` (links commits mentioning ticket IDs).
- If you will be the only agent working this board, take the master lease: `POST /api/boards/main/master { "status": "…" }` (release it before spawning helpers).
- Explain how answers on cards reach an agent: `intellagent wait --agent <name>` in the background during a session, or a **standing agent** for unattended work — offer `intellagent agents add <name>` (and `--listen human` for a coordinator) plus `intellagent autostart on` so the board and its agents come back after a reboot. Ask before adding either.
- **Permissions beyond the built-ins.** A standing agent's tools come from its `perms` (`read edit test build git web`). When the project needs something more (a deploy command, an MCP tool, writes limited to `docs/**`, a bundle of these), the human can add a **custom permission** to the library (`GET /api/permissions` lists it), and an agent holds it like a built-in. Only the human adds them (agents get `403 HUMAN_ONLY`), so suggest the exact `POST /api/permissions` body and let them run it, e.g. `{ "key": "deploy-staging", "kind": "command", "name": "Deploy to staging", "commands": ["npm run deploy:staging"], "needs": ["test"] }`. A `folders` permission needs `read`, not `edit` (which would undo its limit). A **verbal** permission is only words in the brief and nothing enforces it, so say so when you suggest one. The kinds are listed in AGENTS.md, under "The permission library".

## 10. Hand over

- `POST /api/boards/main/finish { "summary": "…" }` summarising what you set up (it also releases anything you hold).
- Raise *needs you* (`POST /items/<id>/attention`) on anything you were unsure about — on the card, not only in chat, so the answer stays with the work.
- Tell the user the board URL (or run `intellagent open`), what was created, and how to use it: answer questions on cards, approve reviews, edit standing rules.

## Boundaries

- Only create or modify `.intellagent/`, `.mcp.json`, `CLAUDE.md` and `.git/hooks/` — and only those the user agreed to in step 3.
- Never write the board's `data/` files directly; everything goes through the API.
- Don't start working tickets as part of setup unless the user asks.
