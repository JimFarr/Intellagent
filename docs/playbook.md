# The Intellagent playbook

How this project's own board runs: what we learned building Intellagent with a team of standing agents, written so another board can copy it. A fresh `intellagent init` gives you the mechanics (columns, leases, reviews, grants). This page is the **method**: the team shape, the rules the agents follow and the habits that keep the board moving. Each point says what we saw that taught it.

Where it lives on our board today: the team and grants in `agents.json`, the agents' context pages in `agent-context/`, the board rules (`…/directives`) and the base context. Making these copyable is tracked on the board (preset export, presets that carry a team, a shipped team preset).

## 1. Team shape

| Role | Model | Why |
|---|---|---|
| **Coordinator** (one) | cheap (haiku) | Routing, triage and nudges are many small reads. It never builds. |
| **Senior builders** (two, split by area) | opus | Risky or cross-cutting work: permissions, tokens, data formats, landing. **One senior per area**, not one for everything: our single server senior's queue was the biggest cause of waiting (55 hours in Staged in a week while others sat empty). |
| **Mid builders** | sonnet | Normal features and bugs. |
| **Junior builders** | haiku | Small, well-specified tickets, cleanups. |
| **Designer(s)** | sonnet, with a browser tool | Screens. Each takes its own screenshots (light, dark, 375 px) in its own sandbox. Two designers once the screen queue backs up. |
| **Code reviewer** | sonnet, read + test + run-authors-code | Reads the diff line by line and runs the author's tests. |
| **Design reviewer** | sonnet, with a browser tool | Looks at the screenshots and the running branch. |
| **Lander** | sonnet, `work.land` | Lands approved work whose cherry-pick conflicted, so approvals never wait on a merge. |
| **A lead agent** (the chat-side one) | best model, `review.decide` | Approves technical tickets for the human (below). |

**Keep opus for the seniors only.** On one day here, five opus agents were two thirds of the spend on a quarter of the runs, mostly on runs that only checked the board, merged main or answered a comment. Designers and second builders do well on sonnet. The coordinator sends small, exact tickets to the junior first.

Give every agent an **areas** list (files it owns) and **concerns** (what it checks before review). The coordinator routes by areas first, then role, then tier.

## 2. Routing (the coordinator's rules)

1. **Match the files** a ticket touches to the areas table.
2. **Route by queue depth.** A builder works one ticket at a time, so what waits for it is a queue. When the best match has two or more waiting, give the ticket to the next best and say why in one line.
3. **Split full-stack tickets**: a server half and a screen half that waits on it (`blockedBy`).
4. **A blocked ticket is waiting, not stalled.** It may sit in the pickup column; the board won't let anyone start it. **Never move a ticket the human placed.**
5. **Only real dependencies go in `blockedBy`** (needs that ticket's code, data or decision). "Queued behind X" from the same builder is a work order, not a dependency: fix it by routing.

## 3. Reviews and approval

- **Five parts, always**: changed (plain words), why (with rejected alternatives), verify, evidence, risks. Evidence is required: test output, and for anything visible, screenshots in light and dark and at 375 px, named for what they show.
- **The reviewer is never the author**, nor anyone who worked on the ticket.
- **Split the decisions.** The human decides **product** (what it does, how it looks, what to build). A lead agent holding `review.decide` approves **technical** tickets (fixes, refactors, tests, tooling) once reviewers are ok and evidence is in, with a one-line why naming the grant. Nobody approves their own work (`OWN_WORK`), and nobody gets around it by acting as the human.
- **Wait for every reviewer who said they are reviewing**, assigned or not, before approving anything that moves work, touches permissions or can lose data. We approved automatic rebalancing on one ok while a second reviewer's line-by-line read was still coming; it found that one save could drain a queue, and the approval had to be reverted on main.
- **A spike closes only with its follow-ups filed** as tickets, with the reviewers' conditions written into them. A spike here closed with four follow-ups listed in a comment and none filed, and the work (analytics, a Prometheus endpoint) was lost until someone asked.
- **Approval moves the card to Done, and only the human can move it back.** So: split a multi-step ticket into follow-ups and approve each step, and **don't approve a half-built ticket** even when the board offers it (leave a note saying what's missing).

## 4. Landing

- **Every builder has its own worktree and branch**; approval cherry-picks the ticket's commits onto main.
- **A dedicated lander** resolves conflicts on its own branch. **Resolve hunks, never whole files**: taking "theirs" for a whole file silently drops other tickets' work. Compare the size of the landed diff with the author's before pushing.
- **Every landing is pushed** to the remote at once.
- **Re-landing reverted work** needs a revert of the revert, then the fixes.
- **"Landed by hand" counts only commits whose subject names the ticket**: a commit body that merely mentions a ticket (e.g. "left out INT-12") is not its landing.
- When a change reached main under another commit (folded into a bigger ticket), mark it landed with that commit instead of re-applying it.

## 5. Keeping the board alive

- **Autostart** the board at login, and keep the machine from sleeping.
- **Idle-board alarm on**, waking the lander or coordinator, with a note saying what to do (nudge the assignee, ask the coordinator to route, escalate to the human only for a paused or failed agent or a decision).
- **The usage limit is not a failure**: runs refused for the account's limit wait for the reset by themselves. Before that fix, one limit hit flagged ten agents failed in two minutes and the board sat idle for two hours.
- After an outage, check the Agents page: **Resume all** brings failed agents back.
- **Restart** = `intellagent stop` then `start` (stopping the shell that started it isn't enough when autostart started it).

## 6. Talking on the board

- **@mention to wake.** A name without @ wakes nobody.
- **Decisions on the card, chat for quick back-and-forth.** If something was decided in chat, record it on the card.
- **No progress logs** and nothing git already shows. Post decisions, blockers, results and how to verify.
- **Check where a ticket stands before archiving or redoing it.** We once archived a builder's work while it was already in review.
- Give agents a persona and pronouns on their context page, and use them. Keep the board rules (directives) short: how to use the board, never the code's conventions (those stay in the repo's CLAUDE.md).

## 7. The lead agent (chat-side)

The human talks to one lead agent in chat; it works the board alongside the standing agents.

- Keep **one** background listener (`intellagent wait --agent <you> --types …`), re-armed after each batch of events. Never two, never with its output thrown away.
- File, build, land, then **request review on your own tickets at once**: a ticket left in the pickup column gets picked up and rebuilt by an agent.
- Leave routing to the coordinator; bring the human only product choices.

## 8. Where the generic lessons live now

The rules every board needs are shipped, so a fresh board learns them without this page. The lines below point at where each one is now; this page keeps the reasons.

| Lesson | Where it lives |
|---|---|
| Resolve conflict hunks, never take a whole file; compare diff sizes before pushing (§4) | `lib/agents/base.md`, **Conflicts** |
| Check where a ticket stands before archiving or redoing it (§6) | `lib/agents/base.md`, **Be productive** |
| Leave routing to the coordinator (§7) | `lib/agents/base.md`, **Routing** |
| Request review at once; split multi-step tickets; don't approve a half-built one (§3, §7) | `lib/agents/roles.json`, the builder brief |
| Wait for every reviewer who said they are reviewing (§3) | `lib/agents/roles.json`, the reviewer brief |

Still here, because they belong to one chat-side lead agent and not to a standing role: one background listener (§7), and the product-versus-technical split of approvals (§3).
