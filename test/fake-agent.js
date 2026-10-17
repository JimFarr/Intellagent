// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Stand-in for `claude -p` in the standing-agent tests.
//   node fake-agent.js ok          comment "handled <n> event(s)" on each ticket in the batch
//   node fake-agent.js fail        exit 1
//   node fake-agent.js slow <ms>   wait, then behave like ok
// The comment also says whether the prompt reported an interrupted earlier run.
//   node fake-agent.js flaky-once <marker>   comment through the real CLI, fail the first time, succeed on retry
const [mode, arg] = process.argv.slice(2);
//   node fake-agent.js linger <file> <ms>          one-shot: note its pid in <file>, and "overlap" there if another
//   node fake-agent.js stream-linger <file> <ms>   pid noted in it is still alive; then work <ms> and behave like ok
//   (stream-linger: keep-alive, the same per turn, but its first turn ever fails, and an ended session works on
//   for <ms> before it exits). Tests that an agent never has two live processes.
if (mode === 'linger' || mode === 'stream-linger') {
  const fs = require('fs');
  const ms = Number(process.argv[4]) || 0;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const note = () => {
    const before = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8').split('\n').map(Number).filter(Boolean) : [];
    const others = before.filter((p) => p !== process.pid && alive(p));
    fs.appendFileSync(arg, `${others.length ? `overlap ${others.join(',')}\n` : ''}${process.pid}\n`);
  };
  const work = async (events) => {
    await new Promise((r) => setTimeout(r, ms));
    for (const id of new Set(events.map((e) => e.itemId).filter(Boolean))) {
      await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${id}/comments`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT },
        body: JSON.stringify({ body: `lingered in pid ${process.pid}` }),
      }).catch(() => {});
    }
  };
  note();
  if (mode === 'linger') {
    process.stdin.resume();
    process.stdin.on('end', async () => { await work(JSON.parse(fs.readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8'))); });
  } else {
    const { runContext } = require('../lib/locate');
    let buf = '';
    process.stdin.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        // the first turn ever answers with an error, so the board ends this session and retries in a new one
        const first = !fs.existsSync(`${arg}.err`);
        if (first) fs.writeFileSync(`${arg}.err`, '');
        else await work(JSON.parse(fs.readFileSync(runContext().events, 'utf8')));
        process.stdout.write(`${JSON.stringify({ type: 'result', subtype: first ? 'error_during_execution' : 'success', is_error: first, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
      }
    });
    // a session whose board died: stdin ends, but it keeps working on the turn it has (as claude does)
    process.stdin.on('end', () => setTimeout(() => process.exit(0), ms));
  }
  return;
}
//   node fake-agent.js family <file> <ms>   start a child, write "<own pid>\n<child pid>\n" to <file>, and both sleep
//   <ms> (a run whose board dies under it: INT-262)
if (mode === 'family') {
  const fs = require('fs');
  const ms = Number(process.argv[4]) || 30000;
  const kid = require('child_process').spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(arg, `${process.pid}\n${kid.pid}\n`);
  setTimeout(() => {}, ms);
  return;
}
//   node fake-agent.js stream [crash-marker]   keep-alive: one process, a turn per stream-json user line; each turn
//   comments "turn <n> in pid <pid>" on the batch's tickets and answers with a result line. With a marker file
//   path, the first turn ever crashes the process (to test restart and retry).
if (mode === 'stream') {
  const fs = require('fs');
  const { runContext } = require('../lib/locate');
  let buf = '';
  let turns = 0;
  process.stdin.on('data', async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      turns++;
      if (arg && !fs.existsSync(arg)) { fs.writeFileSync(arg, 'crashed'); process.exit(1); }
      // which prompt this turn got: the full first-turn one (role brief + rules) or the short later-turn one
      const content = String(JSON.parse(line).message?.content || '');
      const kind = /Same session, same rules/.test(content) ? 'short' : 'full';
      const role = /Your role:/.test(content) ? '+role' : '';
      const ctx = runContext();
      const events = JSON.parse(fs.readFileSync(ctx.events, 'utf8'));
      for (const id of new Set(events.map((e) => e.itemId).filter(Boolean))) {
        await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${id}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT, ...(ctx.run ? { 'x-intellagent-run': ctx.run } : {}) },
          body: JSON.stringify({ body: `turn ${turns} in pid ${process.pid} (${kind}${role})` }),
        });
      }
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: turns * 50000 }, num_turns: 1 })}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
//   node fake-agent.js commit   in its working directory, write a file per ticket in the batch and commit it
//   with the ticket id, then say where on the card (to test per-agent worktrees)
if (mode === 'commit') {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  process.stdin.resume();
  process.stdin.on('end', async () => {
    const events = JSON.parse(fs.readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8'));
    for (const id of new Set(events.map((e) => e.itemId).filter(Boolean))) {
      fs.writeFileSync(`work-${id}.txt`, `done by ${process.env.INTELLAGENT_AGENT}\n`);
      execFileSync('git', ['add', `work-${id}.txt`]);
      execFileSync('git', ['commit', '-q', '-m', `Work on it (${id})`]);
      await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${id}/comments`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT },
        body: JSON.stringify({ body: `committed in ${process.cwd()}` }),
      });
    }
  });
  return;
}
let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', async () => {
  if (mode === 'fail') process.exit(1);
  // like `claude -p --output-format json`: one result object, with token counts, as the last line
  if (mode === 'usage') {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 } })}\n`);
    return;
  }
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
  // like an adapter that can't read local.json (INT-248): only the token in its environment
  if (mode === 'token') {
    const ev = JSON.parse(require('fs').readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8')).find((e) => e.itemId);
    await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${ev.itemId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT, authorization: `Bearer ${process.env.INTELLAGENT_TOKEN}` },
      body: JSON.stringify({ body: `token from env (${process.env.INTELLAGENT_TOKEN.length} chars)` }),
    });
    return;
  }
  if (mode === 'slow') await new Promise((r) => setTimeout(r, Number(arg) || 1000));
  const events = JSON.parse(require('fs').readFileSync(process.env.INTELLAGENT_EVENTS, 'utf8'));
  //   node fake-agent.js env A,B   comment "env A=<value or -> B=…" (what the run's environment holds)
  const tag = mode === 'env' ? ` env ${arg.split(',').map((k) => `${k}=${process.env[k] ?? '-'}`).join(' ')}`
    : /did not finish/.test(prompt) ? ' (resumed after interruption)' : '';
  for (const id of new Set(events.map((e) => e.itemId).filter(Boolean))) {
    await fetch(`${process.env.INTELLAGENT_URL}/api/boards/main/items/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': process.env.INTELLAGENT_AGENT },
      body: JSON.stringify({ body: `handled ${events.length} event(s)${tag}` }),
    });
  }
});
