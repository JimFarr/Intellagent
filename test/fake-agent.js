'use strict';
// Stand-in for `claude -p` in the standing-agent tests.
//   node fake-agent.js ok          comment "handled <n> event(s)" on each ticket in the batch
//   node fake-agent.js fail        exit 1
//   node fake-agent.js slow <ms>   wait, then behave like ok
// The comment also says whether the prompt reported an interrupted earlier run.
//   node fake-agent.js flaky-once <marker>   comment through the real CLI, fail the first time, succeed on retry
const [mode, arg] = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', async () => {
  if (mode === 'fail') process.exit(1);
  if (mode === 'flaky-once') {
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    const ev = JSON.parse(fs.readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8')).find((e) => e.itemId);
    const cli = (...a) => execFileSync(process.execPath, [require('path').join(__dirname, '..', 'cli.js'), ...a], { env: process.env });
    cli('POST', `/api/boards/main/items/${ev.itemId}/comments`, 'body=picked this up'); // identical on both attempts
    if (!fs.existsSync(arg)) { fs.writeFileSync(arg, 'failed once'); process.exit(1); }
    cli('POST', `/api/boards/main/items/${ev.itemId}/comments`, `body=retry saw earlier work: ${/already did/.test(prompt) && /picked this up/.test(prompt)}`);
    return;
  }
  if (mode === 'slow') await new Promise((r) => setTimeout(r, Number(arg) || 1000));
  const events = JSON.parse(require('fs').readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8'));
  const tag = /did not finish/.test(prompt) ? ' (resumed after interruption)' : '';
  for (const id of new Set(events.map((e) => e.itemId).filter(Boolean))) {
    await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT },
      body: JSON.stringify({ body: `handled ${events.length} event(s)${tag}` }),
    });
  }
});
