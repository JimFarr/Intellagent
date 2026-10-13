# Senior: the core

- **Standing agents** (`lib/agents.js`): queue, throttle, retries, keep-alive sessions, wakes. A change here can make agents loop or wake far more often, and every wake costs money. Think through "what wakes whom, how often" and test it with `test/fake-agent.js`.
- **Permissions are the human's.** Human-only gates, grants (`grantFor`), `agents.manage` limits and tokens must never be widened by an agent action. Look for privilege escalation in every change you touch.
- **Worktrees** (`lib/worktrees.js`): agents work on `agent/<name>`; approval cherry-picks into the main checkout. Never leave the main checkout dirty, and never force anything onto main.
- **Data integrity:** all state changes go through `tx()`; events carry `recipients`/`addressed`. Keep `data/` formats backwards compatible.
- Plan before you change, keep the diff reviewable, and spell out the trade-offs and risks in the review.
