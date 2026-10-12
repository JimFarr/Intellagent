#!/usr/bin/env node
/*
 * Intellagent MCP server (stdio). Zero dependencies — thin wrapper over the HTTP API.
 *   claude mcp add intellagent -e INTELLAGENT_AGENT=my-agent -- node /abs/path/intellagent/mcp.js
 * Env: INTELLAGENT_URL (default http://127.0.0.1:7420), INTELLAGENT_AGENT, INTELLAGENT_BOARD (default main)
 */
'use strict';

const { baseUrl, tokenFor, defaultAgent, NO_BOARD } = require('./lib/locate');

const BASE = baseUrl(); // nearest .intellagent/ manifest from the working directory, or INTELLAGENT_URL
// Agent name: INTELLAGENT_AGENT, else the project's default agent (manifest), else the MCP client's own name.
// The project default keeps one identity whether the agent uses the CLI or these tools.
let AGENT = process.env.INTELLAGENT_AGENT || defaultAgent() || 'mcp-agent';
const BOARD = process.env.INTELLAGENT_BOARD || 'main';
const VERSION = '1.0.0';

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const board = S('string', `Board id (default "${BOARD}")`);
const id = S('string', 'Item id, e.g. INT-12');
const column = S('string', 'Column id or name');
const filterProps = {
  board, types: S('string', 'Comma list of event types; "lease.*" wildcard'), itemId: id, column: S('string', 'Destination column'),
  claimant: S('string', 'Leaseholder name'), for: S('string', 'Recipient name — events addressed to this agent'),
  itemType: S('string', 'issue | task | spike'), parent: S('string', 'Parent tag'),
  fields: S('string', 'Comma list of changed fields, e.g. "priority,properties.risk"'), excludeActor: S('string', 'Skip events by this actor'),
};
const itemFields = {
  title: S('string', 'Title'), description: S('string', 'Markdown'), type: S('string', 'issue | task | spike'),
  priority: S('string', 'Low | Medium | High | Critical'), parent: S('string', 'Parent tag for grouping'),
  properties: S('object', 'Free-form property bag; merged on update, null deletes a key'), blockedBy: S('array', 'Item ids', { items: { type: 'string' } }),
  fields: S('object', 'Values for the declared schema fields, e.g. { "risk": "high" }; null clears'),
};
const fieldDef = {
  key: S('string', 'Field key'), label: S('string', 'Label'), type: S('string', 'text | markdown | number | boolean | enum | tags | date | url | user'),
  options: S('array', 'For enum/tags: strings or { value, color }', { items: {} }), ui: S('string', 'edit | read (humans read-only) | hidden'),
  stub: S('string', 'none | top | meta — where it shows on the card'), icon: S('string', 'Icon name'), help: S('string', 'Tooltip / meaning'),
  required: S('boolean', 'Required on create'), default: S('string', 'Default value'), min: S('number', 'Number min'), max: S('number', 'Number max'),
};
const b = (a) => encodeURIComponent(a.board || BOARD);
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

const TOOLS = [
  ['get_briefing', 'START HERE. Who you are, what to do next, the columns, templates, fields, rules and which tools to use.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/brief?via=mcp`]],
  ['get_my_work', 'What needs you now: next actions, your leases, answered questions, review feedback, assigned and ready tickets.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/work`]],
  ['start_work', 'Start or resume a ticket in one step: claims it, moves it to the working column, assigns you, sets your status. Also the way to resume after an answer or review feedback.', { board, id, status: S('string', 'What you are about to do'), minutes: S('number', 'Lease length'), column: S('string', 'Override the target column'), force: S('boolean', 'Start even if blocked') }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/start`, pick(a, ['status', 'minutes', 'column', 'force'])]],
  ['get_transitions', 'Where you can move a ticket, and why not elsewhere.', { board, id }, ['id'], (a) => ['GET', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/transitions`]],
  ['finish_session', 'End your session: releases all your leases and the board hold, posts your digest summary.', { board, summary: S('string', 'Markdown: what you did, what is left'), items: S('array', 'Ticket ids it covers', { items: { type: 'string' } }) }, [],
    (a) => ['POST', `/api/boards/${b(a)}/finish`, pick(a, ['summary', 'items'])]],
  ['get_docs', 'The full agent guide (get_briefing is usually enough).', {}, [], () => ['GET', '/api/docs']],
  ['get_schema', 'Data model, event types, filter keys, search operators.', {}, [], () => ['GET', '/api/schema']],
  ['list_boards', 'List boards.', {}, [], () => ['GET', '/api/boards']],
  ['create_board', 'Create a new kanban board.', { name: S('string', 'Board name'), idPrefix: S('string', 'Item id prefix, e.g. REF'), template: S('string', 'default | simple | empty'), columns: S('array', 'Optional column definitions', { items: { type: 'object' } }), directives: S('string', 'Standing rules (markdown)') }, ['name'],
    (a) => ['POST', '/api/boards', pick(a, ['name', 'idPrefix', 'template', 'columns', 'directives'])]],
  ['board_summary', 'Compact overview: columns, flags, one line per item.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/summary`]],
  ['get_directives', 'Standing rules from the human. Read before working.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/directives`]],
  ['create_column', 'Create a column (agents only).', { board, name: S('string', 'Name'), color: S('string', 'CSS color'), icon: S('string', 'inbox|target|play|eye|check|… or emoji'), position: S('number', 'Index'), flags: S('object', 'allowCreate, allowMoveIn, allowMoveOut, wipLimit, releaseLeaseOnEnter, autoArchiveAfterDays, or custom') }, ['name'],
    (a) => ['POST', `/api/boards/${b(a)}/columns`, pick(a, ['name', 'color', 'icon', 'position', 'flags'])]],
  ['update_column', 'Rename, recolor, reorder or change flags (merged).', { board, column, name: S('string', 'New name'), color: S('string', 'CSS color'), icon: S('string', 'Icon'), position: S('number', 'Index'), flags: S('object', 'Flags to merge') }, ['column'],
    (a) => ['PATCH', `/api/boards/${b(a)}/columns/${encodeURIComponent(a.column)}`, pick(a, ['name', 'color', 'icon', 'position', 'flags'])]],
  ['list_column_items', 'Items in a column, in order.', { board, column, full: S('boolean', 'Return full items') }, ['column'],
    (a) => ['GET', `/api/boards/${b(a)}/columns/${encodeURIComponent(a.column)}/items?${q({ full: a.full })}`]],
  ['create_item', 'Create a work item. Pass template (see list_ticket_templates) to start from a preset; your values override it.', { board, column, template: S('string', 'Ticket template key, e.g. bug'), assignee: S('string', 'Hand it to an agent'), ...itemFields, needsHuman: S('string', 'Ask the human something right away') }, ['title'],
    (a) => ['POST', `/api/boards/${b(a)}/items`, pick(a, ['column', 'template', 'title', 'description', 'type', 'priority', 'parent', 'assignee', 'properties', 'fields', 'blockedBy', 'needsHuman'])]],
  ['list_ticket_templates', 'Ticket templates on this board (presets for new tickets).', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/ticket-templates`]],
  ['define_ticket_template', 'Add a ticket template, or change one (same label/key).', { board, label: S('string', 'e.g. Bug'), key: S('string', 'Optional; derived from label'), help: S('string', 'Hint shown on the chip'), type: S('string', 'issue | task | spike'), priority: S('string', 'Low | Medium | High | Critical'), parent: S('string', 'Parent group'), column: S('string', 'Column it starts in'), title: S('string', 'Prefilled title'), description: S('string', 'Markdown, e.g. a checklist'), fields: S('object', 'Field values'), properties: S('object', 'Property values') }, ['label'],
    async (a, call) => {
      const body = pick(a, ['label', 'key', 'help', 'type', 'priority', 'parent', 'column', 'title', 'description', 'fields', 'properties']);
      const key = String(a.key || a.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const list = await call('GET', `/api/boards/${b(a)}/ticket-templates`);
      return list.some((t) => t.key === key) ? ['PATCH', `/api/boards/${b(a)}/ticket-templates/${key}`, body] : ['POST', `/api/boards/${b(a)}/ticket-templates`, body];
    }],
  ['get_item', 'Full item: description, comments, attachments, lease, properties.', { board, id }, ['id'], (a) => ['GET', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}`]],
  ['update_item', 'Change any fields. Include version for safe writes.', { board, id, ...itemFields, column, position: S('string', 'Index, top or bottom'), cover: S('string', 'Card image: auto | none | attachment id'), version: S('number', 'Version from your last read') }, ['id'],
    (a) => ['PATCH', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}`, pick(a, ['title', 'description', 'type', 'priority', 'parent', 'properties', 'fields', 'blockedBy', 'column', 'position', 'cover', 'version'])]],
  ['get_board_schema', 'Ticket schema: declared fields + built-in field config.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/schema`]],
  ['define_field', 'Declare a typed field on the ticket schema.', { board, ...fieldDef }, ['key', 'type'],
    (a) => ['POST', `/api/boards/${b(a)}/schema/fields`, pick(a, Object.keys(fieldDef))]],
  ['update_field', 'Change a declared field (merged).', { board, ...fieldDef }, ['key'],
    (a) => ['PATCH', `/api/boards/${b(a)}/schema/fields/${encodeURIComponent(a.key)}`, pick(a, Object.keys(fieldDef).filter((k) => k !== 'key'))]],
  ['configure_builtins', 'Hide, relabel or make read-only the built-in fields, e.g. { "priority": { "ui": "hidden" } }.', { board, builtins: S('object', '{ type|priority|parent|description|blockedBy|attachments|cover|properties: { ui, stub, label } }') }, ['builtins'],
    (a) => ['PUT', `/api/boards/${b(a)}/schema`, { builtins: a.builtins }]],
  ['move_item', 'Move between columns or reorder.', { board, id, column, position: S('string', 'Index, top or bottom'), beforeId: S('string', 'Place before this item'), afterId: S('string', 'Place after this item') }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/move`, pick(a, ['column', 'position', 'beforeId', 'afterId'])]],
  ['add_comment', 'Comment on an item (markdown, @mentions notify). Optional files by absolute path.', { board, id, body: S('string', 'Markdown'), files: S('array', 'Absolute file paths to attach', { items: { type: 'string' } }) }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/comments`, { body: a.body || '', attachments: (a.files || []).map((path) => ({ path })) }]],
  ['attach_file', 'Attach a local file (absolute path) or a URL.', { board, id, path: S('string', 'Absolute file path'), url: S('string', 'Link'), name: S('string', 'Display name') }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/attachments`, pick(a, ['path', 'url', 'name'])]],
  ['claim_lease', 'Claim or renew a lease on an item.', { board, id, minutes: S('number', 'Lease length (default 30)'), status: S('string', 'Optional live status line') }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/lease`, pick(a, ['minutes', 'status'])]],
  ['set_status', 'Post a live status line on an item you hold (shown on the card). Empty clears.', { board, id, status: S('string', 'e.g. "running tests 4/12"') }, ['id', 'status'],
    (a) => ['PUT', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/status`, { status: a.status }]],
  ['assign_item', 'Hand an item to another agent (or a human).', { board, id, assignee: S('string', 'Name; empty to unassign') }, ['id'],
    (a) => ['PATCH', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}`, { assignee: a.assignee || null }]],
  ['my_permissions', 'What this agent is allowed to change.', {}, [], () => ['GET', '/api/permissions/me']],
  ['request_review', 'Done with an item? One call: moves it to the review column, posts your summary, releases your lease, and asks the human to review.', { board, id, summary: S('string', 'Markdown summary of what you did and how to verify it') }, ['id'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/review`, pick(a, ['summary'])]],
  ['post_digest', "Append an end-of-session summary to today's digest.", { board, summary: S('string', 'Markdown: what you did, what is next, open questions'), items: S('array', 'Related item ids', { items: { type: 'string' } }) }, ['summary'],
    (a) => ['POST', `/api/boards/${b(a)}/digest`, pick(a, ['summary', 'items'])]],
  ['read_digest', 'Read recent digest entries (what other agents and the human summarised).', { board, days: S('number', 'Days back, default 7') }, [],
    (a) => ['GET', `/api/boards/${b(a)}/digest?days=${a.days || 7}`]],
  ['claim_board', 'Hold the whole board as the only agent (master lease): no per-ticket leases needed; other agents become read-only. Omit minutes to hold until released.', { board, minutes: S('number', 'Optional time limit'), status: S('string', 'What you are doing') }, [],
    (a) => ['POST', `/api/boards/${b(a)}/master`, pick(a, ['minutes', 'status'])]],
  ['set_board_status', 'Live status while you hold the whole board.', { board, status: S('string', 'e.g. "fixing auth tickets"') }, ['status'],
    (a) => ['PUT', `/api/boards/${b(a)}/master/status`, { status: a.status }]],
  ['release_board', 'Release the whole board (do this before spawning helper agents that use ticket leases).', { board }, [],
    (a) => ['DELETE', `/api/boards/${b(a)}/master`]],
  ['release_lease', 'Release your lease.', { board, id }, ['id'], (a) => ['DELETE', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/lease`]],
  ['ask_human', 'Flag the item as needing the human, with a question.', { board, id, reason: S('string', 'Your question') }, ['id', 'reason'],
    (a) => ['POST', `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}/attention`, { reason: a.reason }]],
  ['archive_items', 'Archive items (never deleted).', { board, ids: S('array', 'Item ids', { items: { type: 'string' } }), reason: S('string', 'Why') }, ['ids'],
    (a) => ['POST', `/api/boards/${b(a)}/archive`, pick(a, ['ids', 'reason'])]],
  ['search', 'Search items with filters incl. property bag.', { board, q: S('string', 'Text'), where: S('object', '{ "properties.risk": "high", "priority": { "in": ["High"] } }'), includeArchived: S('boolean', 'Include archive'), sort: S('string', 'Field path or "priority"'), order: S('string', 'asc | desc'), limit: S('number', 'Max results'), full: S('boolean', 'Full items') }, [],
    (a) => ['POST', '/api/search', { ...pick(a, ['q', 'where', 'includeArchived', 'sort', 'order', 'limit', 'full']), board: a.board || BOARD }]],
  ['wait_for_events', 'Long-poll for events matching a filter. Returns { events, cursor }; pass cursor as since next time.', { since: S('number', 'Cursor (omit = only future events)'), timeout: S('number', 'Seconds, default 25'), ...filterProps }, [],
    (a) => ['GET', `/api/events/wait?${q({ timeout: 25, ...a })}`]],
  ['subscribe', 'Create a durable subscription; server remembers your cursor.', { label: S('string', 'Label'), filter: S('object', 'Filter keys: ' + Object.keys(filterProps).join(', ')) }, [],
    (a) => ['POST', '/api/subscriptions', { label: a.label, filter: a.filter || { for: AGENT } }]],
  ['next_events', 'Get the next events for a subscription (long-polls, advances the cursor).', { subscription: S('string', 'Subscription id'), timeout: S('number', 'Seconds, default 25') }, ['subscription'],
    (a) => ['GET', `/api/subscriptions/${encodeURIComponent(a.subscription)}/next?${q({ timeout: a.timeout ?? 25 })}`]],
  ['set_profile', 'Set how you appear on the board: colour, glyph (1–2 chars/emoji), label, description (what you were designed to do), avatar image.', { color: S('string', 'CSS colour'), glyph: S('string', '1–2 characters or an emoji'), label: S('string', 'Display label'), description: S('string', 'Markdown: your purpose and how to work with you'), imagePath: S('string', 'Absolute path to an image'), image: S('string', 'https image URL') }, [],
    (a) => ['PATCH', '/api/profiles/me', pick(a, ['color', 'glyph', 'label', 'description', 'imagePath', 'image'])]],
  ['rename_app', 'White-label: rename the app.', { name: S('string', 'New app name') }, ['name'], (a) => ['PATCH', '/api/app', { name: a.name }]],
];

const tools = TOOLS.map(([name, description, properties, required, call]) => ({
  name, description,
  inputSchema: { type: 'object', properties: { ...properties, agent: S('string', `Act as this agent name (default "${AGENT}")`) }, required },
  call,
}));

async function callTool(name, args = {}) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  if (!BASE) return { text: NO_BOARD, isError: true };
  const headers = { 'Content-Type': 'application/json', 'X-Agent': args.agent || AGENT, ...(tokenFor(args.agent || AGENT) ? { Authorization: `Bearer ${tokenFor(args.agent || AGENT)}` } : {}) };
  // A tool spec may look something up first (e.g. create-or-update), so it can be async and gets a JSON GET helper.
  const getJson = async (m, p) => (await fetch(BASE + p, { method: m, headers })).json();
  const [method, path, body] = await t.call(args, getJson);
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { text, isError: !res.ok };
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(msg) {
  const { id: rid, method, params } = msg;
  if (rid === undefined) return; // notification
  try {
    if (method === 'initialize') {
      const client = params?.clientInfo?.name;
      if (!process.env.INTELLAGENT_AGENT && !defaultAgent() && client) AGENT = String(client).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64);
      return send({ jsonrpc: '2.0', id: rid, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'intellagent', version: VERSION },
        instructions: BASE
          ? `Kanban shared with the human at ${BASE}. You are "${AGENT}". Call get_briefing first: it says what to do next, how this board works and which tools to use. Work a ticket with start_work → set_status → request_review; ask_human when unsure; finish_session at the end.`
          : NO_BOARD,
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id: rid, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id: rid, result: { tools: tools.map(({ call, ...t }) => t) } });
    if (method === 'tools/call') {
      let out;
      try { out = await callTool(params.name, params.arguments); }
      catch (e) { out = { text: `Error: ${e.message} (is the server running at ${BASE}?)`, isError: true }; }
      return send({ jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } });
    }
    send({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = handle(msg).finally(() => pending.delete(p));
    pending.add(p);
  }
});
process.stdin.on('end', async () => { await Promise.allSettled([...pending]); process.exit(0); });
