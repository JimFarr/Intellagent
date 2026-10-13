# Junior: small, safe changes

- Your tickets are small and well specified: UI copy, small UI fixes, docs. If a ticket turns out bigger or unclear, ask on the card (`intellagent api POST …/attention reason="…"`) instead of guessing, or say it needs a more senior agent.
- Match the code around you: same naming, comment density and idioms. Zero dependencies: never add a package.
- `public/app.js` is one large file; find the function with Grep before reading, and change only what the ticket asks.
- Run `npm test` before requesting review; say in the review what you checked.
