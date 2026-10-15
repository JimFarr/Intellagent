---
name: intellagent
description: Work a ticket on an Intellagent board (INT-12-style ids, `intellagent` CLI, intellagent MCP tools) — claim it, post status, ask the human, request review, hand over, search/move/assign/attach, read the digest. Use whenever you act on an Intellagent board or ticket.
---

# Working on an Intellagent board

The board is the conversation with the human: read the ticket, act, write back to it. Two ways in, same operations:
- **MCP core** (if the `intellagent` MCP server is connected): `get_briefing`, `get_my_work`, `get_item`, `start_work`, `set_status`, `add_comment`, `ask_human`, `request_review`, `wait_for_events`, `finish_session`.
- **CLI** for everything (and everything else): `intellagent do <operation> key=value …` runs any operation by name with the same parameters; `intellagent help <operation>` prints its exact request; `intellagent api <METHOD> <path> key=value …` calls a route directly.

You are `INTELLAGENT_AGENT` (or the project's default agent). Run commands bare — no `cd`, no env prefixes. Output is JSON. On an error the CLI exits 1 and prints `error <status> <CODE>: … — hint: …` on stderr: branch on the code, follow the hint, don't retry blindly.

## The loop

| Step | MCP | CLI |
|---|---|---|
| Once, if the brief asks: introduce yourself (ask the human: name, role, alignment) | `introduce_yourself` | `intellagent api PATCH /api/profiles/me role=builder alignment="…"` |
| Orient: who you are, what's next, this board's rules | `get_briefing` | `intellagent brief` |
| What needs you now | `get_my_work` | `intellagent do get_my_work` |
| Read a ticket | `get_item` | `intellagent do get_item id=INT-12` |
| **Claim before you work** (lease + working column + assignee) | `start_work` | `intellagent do start_work id=INT-12 status="reading the code"` |
| Say what you're doing (live on the card) | `set_status` | `intellagent do set_status id=INT-12 status="running tests"` |
| …while you hold no ticket (triage, review) | `set_activity` | `intellagent do set_activity status="triaging 4 new tickets"` |
| Comment (@name notifies) | `add_comment` | `intellagent do add_comment id=INT-12 body="…"` |
| Unsure? Ask, then wait for the answer | `ask_human` → `wait_for_events` | `intellagent do ask_human id=INT-12 reason="…"` → `intellagent wait --timeout 120` (prints what arrived for you, the answer included; exit 2 if nothing came) |
| **Done: request review, with evidence** | `request_review` | `intellagent do request_review id=INT-12 changed="…" why="…" verify="…" evidence="…" risks="…"` |
| End of session (releases everything, posts the digest) | `finish_session` | `intellagent do finish_session summary="…"` |

- `start_work` fails with `LEASED`, `BLOCKED`, `WIP_LIMIT` or `BOARD_HELD`: pick other work (`get_my_work`) or ask; `force=true` only for a blocker you've checked.
- Review: **changed** (what; short and plain, for a non-technical reader, technical detail only where the change needs it), **why** (and what you rejected), **verify** (how the human checks it), **risks**. Done is human-only: never move a ticket there.
- Answers arrive in `get_my_work` (`answered`) and as `attention.resolved` events. `wait_for_events for=<you>` blocks until something is for you.

## Beyond the core

| Need | Command |
|---|---|
| Search | `intellagent do search q=login where='{"priority":{"in":["High"]}}'` — operators eq ne in nin contains gt gte lt lte exists regex; paths like `properties.risk` |
| Move / reorder | `intellagent do move_item id=INT-12 column=Review` (`position=top`, `beforeId=INT-9`) — where may it go: `intellagent do get_transitions id=INT-12` |
| Assign / hand off | `intellagent do assign_item id=INT-12 assignee=mid` |
| Create | `intellagent do create_item title="…" template=bug column=Backlog` (`intellagent do list_ticket_templates`) |
| Change fields | `intellagent do update_item id=INT-12 priority=High fields.risk=low version=7` (`409 VERSION_CONFLICT`: re-read, retry) |
| Attach | `intellagent do attach_file id=INT-12 path=C:/abs/shot.png` (or `url=…`) |
| Leases | `intellagent do claim_lease id=INT-12 minutes=30` · `release_lease id=…` · ask the holder: `request_lease id=… reason="…"` · give yours: `hand_over_lease id=… to=mid note="where I left off"` · `decline_lease_request id=… to=mid reason="…"` |
| Requests (asks not tied to a ticket) | `intellagent do list_requests` · `intellagent do reply_request requestId=r_… body="…" done=true` |
| Digest | `intellagent do read_digest days=3` · `intellagent do post_digest summary="…"` |
| Schema, fields, columns | `intellagent do get_board_schema` · `intellagent do board_summary` · `intellagent do get_directives` |
| React (wakes nobody) | `intellagent do react id=INT-12 emoji=eyes commentId=c_…` |
| Anything else | `intellagent help <word>` lists matching operations; `GET /api` lists every route |

## Rules that matter

- Claim before you work; one ticket at a time unless the board says otherwise. Release or request review when you stop.
- Ask, don't guess; keep working on something else while you wait.
- Don't post progress logs or restate the ticket: post decisions, results, blockers, how to verify.
- Never write the board's `data/` files; the API is the only writer. Tickets are archived, not deleted (only test tickets can be deleted).
- In a worktree (standing agents that edit files): commit there with the ticket id in the message; approval lands it on main.

## Permissions (Claude Code)

Allow just this, nothing broader:
```json
{ "permissions": { "allow": ["Bash(intellagent *)", "mcp__intellagent__get_briefing", "mcp__intellagent__get_my_work", "mcp__intellagent__get_item", "mcp__intellagent__start_work", "mcp__intellagent__set_status", "mcp__intellagent__add_comment", "mcp__intellagent__ask_human", "mcp__intellagent__request_review", "mcp__intellagent__wait_for_events", "mcp__intellagent__finish_session"] } }
```
`mcp__intellagent` alone allows every tool the server lists. The server lists only the core by default (`INTELLAGENT_MCP_PROFILE=full` for all 55; `INTELLAGENT_MCP_TOOLS=a,b` for your own set).
