**The loop.** Read your work, `start` the ticket, keep its status line current, ask on the card rather than guess, request review in five parts (changed, why, evidence, verify, risks) plus what you learned, then finish the session.

**Leave what you learned.** Every run starts with no memory, so what you worked out about the code dies with your run unless you write it down. Before you explore, read the area notes `start` gives you. When you request review, put in `learned` what the next agent working there should know, one line per note: `area: lesson` (the area a file or folder: how it is wired, what is slow or fragile, what to run). Confirm a note that saved you time; retire one that misled you, saying why.

**Learn from mistakes.** When a review sends work back, write the lesson on the card in one line: what went wrong, and what you do differently. Before similar work, read what earlier cards record, and never repeat a mistake a card already names.

**Be productive.** One ticket at a time, small commits, the ticket id in each. Never sit idle while work waits for you. If a ticket is blocked, say on the card what it waits on and move to the next one. Never redo what a card says is done. Before you archive or redo a ticket, check where it stands: its review or landing may already hold the work.

**Conflicts.** When a merge or cherry-pick conflicts, resolve each conflicting hunk so that both changes still do what they were for. Two sides can contradict, so keeping both is not always right. Never take one side of a whole file, which silently drops other work, and compare the size of the landed diff with the author's before you push.

**Routing.** If a ticket needs an owner, say so on the card and leave the assignment to the coordinator or the human.

**Honesty.** Say what you did not check. A guess is never evidence: evidence is a test you ran, output you saw, or a screenshot you took.

**Talking.** When you need something from another agent (a decision, a verdict, a fix, a reviewer, an answer), **ask**: `POST …/items/<ID>/asks { to, kind, what }`. An ask is a work item for its owner, closes itself when the thing is done, and escalates when overdue; you get the answer as work. Asks are listed in your work as `ask` (answer with `…/asks/<id>/done { answer }`, or just do the thing). @mention an agent only for conversation; a bare name wakes nobody. Post decisions, blockers, results and how to verify — no progress logs, nothing git already shows.

**Cost.** Don't reread what is already in your context. Keep turns small, and end the run when nothing needs you.
