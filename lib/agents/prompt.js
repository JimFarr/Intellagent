'use strict';
// The text a standing agent's run is given: one line per event, and the prompt around them.

const eventLine = (e) => e.type === 'work.pending'
  ? ['work.pending — work waiting for you on the board:',
    ...e.work.map((w) => `    · ${w.action} ${w.id || w.requestId}${w.title ? ` "${w.title}"` : ''} — ${w.why}`)].join('\n')
  : e.type === 'request.created'
  ? `#${e.seq} REQUEST ${e.request.id} from ${e.actor?.name || '?'}${e.request.history?.length ? ` (a follow-up; the conversation so far, oldest first:${e.request.history.map((m) => `\n      ${m.from}: ${String(m.body).replace(/\s+/g, ' ')}`).join('')}\n    now:)` : ''}: ${e.request.body}${e.request.attachments?.length ? ` [attached files — open them: ${e.request.attachments.map((a) => a.path || a.url).join(', ')}]` : ''}  → do it, then reply: intellagent api POST /api/boards/${e.board}/requests/${e.request.id}/reply body="what you did (ticket ids)" done=true`
  : `#${e.seq} ${e.type}${e.intent === 'explain' ? ' [EXPLAIN ONLY]' : ''}${e.draft ? ' [WRITE THIS TICKET — see the write action in your brief]' : ''}${e.itemId ? ` ${e.itemId}` : ''}${e.item?.title ? ` "${e.item.title}"` : ''} by ${e.actor?.name || '?'}${e.reply ? ` — reply: ${e.reply}` : e.comment?.body ? ` — ${e.comment.body}` : e.reason ? ` — ${e.reason}` : ''}`;

// warm: a later turn in a live keep-alive session. The role brief and fixed rules are already in its
// context from the first turn, so it gets only what is new: the events, any retry notes and a reminder.
function promptFor(name, events, { listen, evFile, interrupted, failures, earlier = [], brief = '', warm = false, workspace = null, speciality = '' }) {
  const ws = workspace ? [
    ...(warm ? [] : [`You work in your own git worktree, ${workspace.path} (branch ${workspace.branch}), not the main checkout — other agents have their own. Edit, test and commit there, and put the ticket id in every commit message, e.g. "Fix the stack badge (INT-12)". When the human approves the ticket's review, its commits land on ${workspace.main}; nothing reaches ${workspace.main} otherwise.`]),
    ...(workspace.note ? [workspace.note] : []),
    '',
  ] : [];
  const notes = [
    ...(interrupted ? ['Your previous run on these events did not finish (error, timeout or restart). It may have done part of the work: check the cards (comments, status, column) and the working tree before redoing anything.', ''] : []),
    ...(events.some((e) => e.intent === 'explain') ? ['Events marked [EXPLAIN ONLY] are questions about work already done: answer them in a comment on the card — your reasoning, what you considered, the trade-offs — and change nothing else (no code, no ticket fields, no column, no review).', ''] : []),
    ...(earlier.length ? ['What the earlier attempt already did on the board (do not repeat it):', ...earlier.slice(-30).map((e) => `- ${eventLine(e)}`), ''] : []),
    ...(failures ? [`Attempt ${failures + 1}: the previous run exited with an error.`, ''] : []),
  ];
  if (warm) {
    const board = events.find((e) => e.board)?.board || '<board>';
    return [
      'New events for you:',
      ...events.map((e) => `- ${eventLine(e)}`),
      '',
      ...notes,
      `Same session, same rules as before. Check \`intellagent api GET /api/boards/${board}/work\` (the brief only if you need the board rules again), act, reply on the card, then finish. If nothing here needs you, end without commenting.`,
      ...ws,
      `Full event JSON: ${evFile}`,
    ].join('\n');
  }
  return [
    ...(speciality ? [speciality, ''] : []),
    ...(brief ? [brief, ''] : []),
    listen === 'inbox'
      ? `You are "${name}", working on this project's Intellagent board. These events are for you:`
      : `You are "${name}", coordinating this project's Intellagent board. New activity:`,
    ...events.map((e) => `- ${eventLine(e)}`),
    '',
    ...notes,
    'Start with: intellagent brief   (your situation, the board\'s rules and the exact next calls). Then act on it following the board\'s standing rules and the project\'s CLAUDE.md, and reply on the card.',
    'Finish with: intellagent api POST /api/boards/<board>/finish summary="…" — it releases anything you still hold.',
    'Anything worth remembering must go on the card — this run ends when you finish and nothing else is kept.',
    // Agents that once commented on a ticket hear about everything on it; most of that needs nothing from them.
    'If none of these events asks you to do or answer something, do nothing and end the run: no "noted"/"nothing to do" comments (your 👀 already says you saw it). Only post when you have work, an answer or a question.',
    // Agents tend to write `cd … && VAR=x intellagent …`, which no longer matches a `Bash(intellagent …)`
    // allowlist rule — so say plainly that neither is needed.
    `You are already "${name}" (INTELLAGENT_AGENT is set) and already in the project folder: run commands bare — \`intellagent …\`, \`npm test\` — with no \`cd\` and no environment-variable prefixes, or the permission allowlist will refuse them. The board's MCP tools (get_briefing, start_work, request_review, finish_session…) work too.`,
    ...ws,
    `Full event JSON: ${evFile}`,
  ].join('\n');
}

module.exports = { eventLine, promptFor };
