'use strict';
/* The Intellagent operations as tools: one definition per operation, shared by the MCP server (mcp.js) and the
   CLI (`intellagent do <op>`, `intellagent help <op>`), so both build exactly the same requests.
   makeTools({ board, agent, onIdentity }) → [[name, description, properties, required, call], …]
   call(args, getJson) → [method, path, body?] (may be async when it has to look something up first). */
function makeTools({ board: BOARD = 'main', agent = () => 'agent', onIdentity = () => {} } = {}) {
  const S = (type, description, extra = {}) => ({ type, description, ...extra });
  // Shared parameters, described once and briefly: every tool definition is loaded into the agent's context.
  const board = S('string', `Board (default ${BOARD})`);
  const id = S('string', 'Ticket id, e.g. INT-12');
  const column = S('string', 'Column id or name');
  const ids = S('array', 'Ticket ids', { items: { type: 'string' } });
  const filterProps = {
    board, types: S('string', 'Event types, comma list; lease.* wildcard'), itemId: id, column: S('string', 'Destination column'),
    claimant: S('string', 'Leaseholder'), for: S('string', 'Events for this agent (your inbox)'),
    itemType: S('string', 'issue|task|spike'), parent: S('string', 'Parent tag'),
    fields: S('string', 'Changed fields, e.g. priority,properties.risk'), excludeActor: S('string', 'Skip this actor'),
  };
  const itemFields = {
    title: S('string', 'Title'), description: S('string', 'Markdown'), type: S('string', 'issue|task|spike'),
    priority: S('string', 'Low|Medium|High|Critical'), parent: S('string', 'Parent tag'),
    properties: S('object', 'Free-form; merged, null deletes'), blockedBy: ids,
    fields: S('object', 'Schema field values; null clears'),
  };
  const fieldDef = {
    key: S('string', 'Field key'), label: S('string', 'Label'), type: S('string', 'text|markdown|number|boolean|enum|tags|date|url|user'),
    options: S('array', 'enum/tags: strings or {value,color}', { items: {} }), ui: S('string', 'edit|read|hidden'),
    stub: S('string', 'none|top|meta'), icon: S('string', 'Icon'), help: S('string', 'Tooltip'),
    required: S('boolean', 'Required on create'), default: S('string', 'Default'), min: S('number', 'Min'), max: S('number', 'Max'),
  };
  const b = (a) => encodeURIComponent(a.board || BOARD);
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  const item = (a, rest = '') => `/api/boards/${b(a)}/items/${encodeURIComponent(a.id)}${rest}`;

  // [name, description, properties, required, call]. Descriptions say only what is needed to choose and call
  // the tool; the how-and-why lives in the brief (get_briefing) and in skills/intellagent/SKILL.md.
  return [
    ['get_briefing', 'START HERE each session: who you are, what to do next, this board\'s columns, fields, rules and calls.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/brief?via=mcp`]],
    ['get_my_work', 'What needs you now: next actions, your leases, answers, review feedback, assigned/ready tickets.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/work`]],
    ['start_work', 'Claim and start (or resume) a ticket: leases it, moves it to the working column, assigns you.', { board, id, status: S('string', 'What you are about to do'), minutes: S('number', 'Lease minutes'), force: S('boolean', 'Start even if blocked') }, ['id'],
      (a) => ['POST', item(a, '/start'), pick(a, ['status', 'minutes', 'column', 'force'])]],
    ['get_transitions', 'Where a ticket may move, and why not elsewhere.', { board, id }, ['id'], (a) => ['GET', item(a, '/transitions')]],
    ['finish_session', 'End your session: releases your leases and posts a digest summary.', { board, summary: S('string', 'Markdown: done, left'), items: ids }, [],
      (a) => ['POST', `/api/boards/${b(a)}/finish`, pick(a, ['summary', 'items'])]],
    ['get_docs', 'The full agent guide.', {}, [], () => ['GET', '/api/docs']],
    ['get_schema', 'Data model, event types, filter keys, search operators.', {}, [], () => ['GET', '/api/schema']],
    ['list_boards', 'List boards.', {}, [], () => ['GET', '/api/boards']],
    ['create_board', 'Human only: create a board.', { name: S('string', 'Name'), idPrefix: S('string', 'Id prefix, e.g. REF'), template: S('string', 'default|simple|empty'), columns: S('array', 'Column definitions', { items: { type: 'object' } }), directives: S('string', 'Standing rules (markdown)') }, ['name'],
      (a) => ['POST', '/api/boards', pick(a, ['name', 'idPrefix', 'template', 'columns', 'directives'])]],
    ['board_summary', 'Compact board: columns, flags, one line per ticket.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/summary`]],
    ['get_directives', 'The human\'s standing rules and project conventions.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/directives`]],
    ['create_column', 'Create a column (human only).', { board, name: S('string', 'Name'), color: S('string', 'CSS colour'), icon: S('string', 'Icon or emoji'), position: S('number', 'Index'), flags: S('object', 'allowCreate, allowMoveIn/Out, wipLimit, …') }, ['name'],
      (a) => ['POST', `/api/boards/${b(a)}/columns`, pick(a, ['name', 'color', 'icon', 'position', 'flags'])]],
    ['update_column', 'Change a column; flags are merged. Agents may change name, colour, icon and custom flags; position and gate flags are the human\'s.', { board, column, name: S('string', 'New name'), color: S('string', 'CSS colour'), icon: S('string', 'Icon'), position: S('number', 'Index'), flags: S('object', 'Flags to merge') }, ['column'],
      (a) => ['PATCH', `/api/boards/${b(a)}/columns/${encodeURIComponent(a.column)}`, pick(a, ['name', 'color', 'icon', 'position', 'flags'])]],
    ['list_column_items', 'Tickets in a column, in order.', { board, column, full: S('boolean', 'Full tickets') }, ['column'],
      (a) => ['GET', `/api/boards/${b(a)}/columns/${encodeURIComponent(a.column)}/items?${q({ full: a.full })}`]],
    ['create_item', 'Create a ticket, optionally from a template.', { board, column, template: S('string', 'Template key, e.g. bug'), assignee: S('string', 'Agent to hand it to'), ...itemFields, needsHuman: S('string', 'Question for the human') }, ['title'],
      (a) => ['POST', `/api/boards/${b(a)}/items`, pick(a, ['column', 'template', 'title', 'description', 'type', 'priority', 'parent', 'assignee', 'properties', 'fields', 'blockedBy', 'needsHuman'])]],
    ['list_ticket_templates', 'Ticket templates on this board.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/ticket-templates`]],
    ['define_ticket_template', 'Add or change a ticket template (by label/key).', { board, label: S('string', 'e.g. Bug'), key: S('string', 'Optional'), help: S('string', 'Hint'), type: S('string', 'issue|task|spike'), priority: S('string', 'Low|Medium|High|Critical'), parent: S('string', 'Parent'), column: S('string', 'Start column'), title: S('string', 'Prefilled title'), description: S('string', 'Markdown'), fields: S('object', 'Field values'), properties: S('object', 'Properties') }, ['label'],
      async (a, call) => {
        const body = pick(a, ['label', 'key', 'help', 'type', 'priority', 'parent', 'column', 'title', 'description', 'fields', 'properties']);
        const key = String(a.key || a.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const list = await call('GET', `/api/boards/${b(a)}/ticket-templates`);
        return list.some((t) => t.key === key) ? ['PATCH', `/api/boards/${b(a)}/ticket-templates/${key}`, body] : ['POST', `/api/boards/${b(a)}/ticket-templates`, body];
      }],
    ['get_item', 'A ticket in full: description, comments, attachments, lease, fields.', { board, id }, ['id'], (a) => ['GET', item(a)]],
    ['update_item', 'Change a ticket. Pass version from your last read for a safe write.', { board, id, ...itemFields, column, position: S('string', 'Index, top or bottom'), cover: S('string', 'auto|none|attachment id'), version: S('number', 'Version') }, ['id'],
      (a) => ['PATCH', item(a), pick(a, ['title', 'description', 'type', 'priority', 'parent', 'properties', 'fields', 'blockedBy', 'column', 'position', 'cover', 'version'])]],
    ['get_board_schema', 'Ticket schema: declared fields and built-in field settings.', { board }, [], (a) => ['GET', `/api/boards/${b(a)}/schema`]],
    ['define_field', 'Declare a typed ticket field.', { board, ...fieldDef }, ['key', 'type'],
      (a) => ['POST', `/api/boards/${b(a)}/schema/fields`, pick(a, Object.keys(fieldDef))]],
    ['update_field', 'Change a declared field (merged).', { board, ...fieldDef }, ['key'],
      (a) => ['PATCH', `/api/boards/${b(a)}/schema/fields/${encodeURIComponent(a.key)}`, pick(a, Object.keys(fieldDef).filter((k) => k !== 'key'))]],
    ['configure_builtins', 'Hide, relabel or lock built-in fields (human only).', { board, builtins: S('object', '{ priority: { ui: "hidden" }, … }') }, ['builtins'],
      (a) => ['PUT', `/api/boards/${b(a)}/schema`, { builtins: a.builtins }]],
    ['move_item', 'Move a ticket to a column, or reorder it.', { board, id, column, position: S('string', 'Index, top or bottom'), beforeId: S('string', 'Before this ticket'), afterId: S('string', 'After this ticket') }, ['id'],
      (a) => ['POST', item(a, '/move'), pick(a, ['column', 'position', 'beforeId', 'afterId'])]],
    ['add_comment', 'Comment on a ticket (markdown; @name notifies). Optional files.', { board, id, body: S('string', 'Markdown'), files: S('array', 'Absolute file paths', { items: { type: 'string' } }) }, ['id'],
      (a) => ['POST', item(a, '/comments'), { body: a.body || '', attachments: (a.files || []).map((path) => ({ path })) }]],
    ['attach_file', 'Attach a file (absolute path, inside the project, your worktree or temp) or a URL.', { board, id, path: S('string', 'Absolute path'), url: S('string', 'Link'), name: S('string', 'Display name') }, ['id'],
      (a) => ['POST', item(a, '/attachments'), pick(a, ['path', 'url', 'name'])]],
    ['claim_lease', 'Claim or renew a lease.', { board, id, minutes: S('number', 'Default 30'), status: S('string', 'Live status') }, ['id'],
      (a) => ['POST', item(a, '/lease'), pick(a, ['minutes', 'status'])]],
    ['set_status', 'Live status line on a ticket you hold; empty clears.', { board, id, status: S('string', 'e.g. running tests 4/12') }, ['id', 'status'],
      (a) => ['PUT', item(a, '/status'), { status: a.status }]],
    ['set_activity', 'Live status line for a run that holds no ticket (triage, reviewing, answering a request); empty clears. Wakes nobody; ends with your run.', { status: S('string', 'e.g. triaging 4 new tickets'), items: ids }, ['status'],
      (a) => ['PUT', '/api/profiles/me/status', pick(a, ['status', 'items'])]],
    ['assign_item', 'Hand a ticket to someone; empty unassigns.', { board, id, assignee: S('string', 'Name') }, ['id'],
      (a) => ['PATCH', item(a), { assignee: a.assignee || null }]],
    ['my_permissions', 'What you may change, and your grants.', {}, [], () => ['GET', '/api/permissions/me']],
    ['request_review', 'Finished: moves the ticket to review with your explanation and the evidence that it works, releases the lease, asks the human.', { board, id, changed: S('string', 'What changed'), why: S('string', 'Why; alternatives rejected'), verify: S('string', 'How to check it'), evidence: S('string', 'What proves it works: screenshots, outputs, tests'), risks: S('string', 'Risks, open questions') }, ['id', 'changed', 'why', 'verify', 'evidence'],
      (a) => ['POST', item(a, '/review'), pick(a, ['changed', 'why', 'verify', 'evidence', 'risks', 'summary'])]],
    ['post_digest', 'Add a summary to today\'s digest.', { board, summary: S('string', 'Markdown'), items: ids }, ['summary'],
      (a) => ['POST', `/api/boards/${b(a)}/digest`, pick(a, ['summary', 'items'])]],
    ['read_digest', 'Recent digest entries.', { board, days: S('number', 'Default 7') }, [],
      (a) => ['GET', `/api/boards/${b(a)}/digest?days=${a.days || 7}`]],
    ['claim_board', 'Hold the whole board (master lease) when you work alone.', { board, minutes: S('number', 'Optional limit'), status: S('string', 'What you do') }, [],
      (a) => ['POST', `/api/boards/${b(a)}/master`, pick(a, ['minutes', 'status'])]],
    ['set_board_status', 'Live status while you hold the board.', { board, status: S('string', 'Status') }, ['status'],
      (a) => ['PUT', `/api/boards/${b(a)}/master/status`, { status: a.status }]],
    ['release_board', 'Release the whole board.', { board }, [], (a) => ['DELETE', `/api/boards/${b(a)}/master`]],
    ['release_lease', 'Release your lease on a ticket.', { board, id }, ['id'], (a) => ['DELETE', item(a, '/lease')]],
    ['list_requests', 'Requests the human sent you (not tied to a ticket).', { board, status: S('string', 'open|done') }, [], (a) => ['GET', `/api/boards/${b(a)}/requests?${q({ status: a.status || 'open', to: agent() })}`]],
    ['reply_request', 'Reply to a request; done: true when finished.', { board, requestId: S('string', 'Request id'), body: S('string', 'Markdown'), done: S('boolean', 'Done') }, ['requestId'],
      (a) => ['POST', `/api/boards/${b(a)}/requests/${encodeURIComponent(a.requestId)}/reply`, pick(a, ['body', 'done'])]],
    ['withdraw_request', 'Take back a request you sent, once it is met or no longer relevant.', { board, requestId: S('string', 'Request id'), reason: S('string', 'Why') }, ['requestId', 'reason'],
      (a) => ['POST', `/api/boards/${b(a)}/requests/${encodeURIComponent(a.requestId)}/withdraw`, pick(a, ['reason'])]],
    ['withdraw_question', 'Take back your open question or review request on a ticket (moves nothing).', { board, id, questionId: S('string', 'Question id (the ticket\'s "questions")'), reason: S('string', 'Why') }, ['id', 'questionId', 'reason'],
      (a) => ['POST', item(a, `/questions/${encodeURIComponent(a.questionId)}/withdraw`), pick(a, ['reason'])]],
    ['introduce_yourself', 'Save who you are after asking the human (name; blank = generated), role, alignment. Switches this session to that name.', { name: S('string', 'Name (omit: generated)'), role: S('string', 'coordinator|builder|reviewer|researcher|writer|…'), alignment: S('string', 'How you behave'), description: S('string', 'What you do here'), color: S('string', 'CSS colour'), glyph: S('string', 'Emoji or 1–2 chars') }, ['role'],
      async (a, call) => {
        const name = a.name && String(a.name).trim() ? String(a.name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64) : (await call('GET', '/api/names/suggest')).name;
        onIdentity(name);
        return ['PATCH', '/api/profiles/me', pick(a, ['role', 'alignment', 'description', 'color', 'glyph'])];
      }],
    ['request_lease', 'Ask the agent holding a ticket to hand it to you.', { board, id, reason: S('string', 'Why') }, ['id'],
      (a) => ['POST', item(a, '/lease/request'), pick(a, ['reason'])]],
    ['hand_over_lease', 'Hand a ticket you hold to the agent that asked.', { board, id, to: S('string', 'Agent'), note: S('string', 'Where you left off') }, ['id'],
      (a) => ['POST', item(a, '/lease/handover'), pick(a, ['to', 'note'])]],
    ['decline_lease_request', 'Decline a request for your ticket.', { board, id, to: S('string', 'Agent'), reason: S('string', 'Why not') }, ['id', 'reason'],
      (a) => ['POST', item(a, '/lease/decline'), pick(a, ['to', 'reason'])]],
    ['react', 'Emoji on a ticket or comment (wakes nobody); 👀 = seen.', { board, id, emoji: S('string', 'Emoji or name: eyes, +1, check…'), commentId: S('string', 'Comment (omit: the ticket)'), remove: S('boolean', 'Remove it') }, ['id', 'emoji'],
      (a) => [a.remove ? 'DELETE' : 'POST', item(a, '/reactions'), pick(a, ['emoji', 'commentId'])]],
    ['ask_human', 'Ask the human a question on a ticket; the answer comes back in get_my_work and as an event. Add a form to get answers as { key: value }.', { board, id, reason: S('string', 'Your question'),
      form: S('array', 'Optional: fields the human fills in on the card, in order — { key, label, type: text|longtext|choice|multi|yesno|number|date, options? (choice, multi), required?, default?, help? } or { type: "note", markdown }', { items: { type: 'object' } }) }, ['id', 'reason'],
      (a) => ['POST', item(a, '/attention'), { reason: a.reason, ...(a.form ? { form: a.form } : {}) }]],
    ['archive_items', 'Archive tickets (never deleted).', { board, ids, reason: S('string', 'Why') }, ['ids'],
      (a) => ['POST', `/api/boards/${b(a)}/archive`, pick(a, ['ids', 'reason'])]],
    ['search', 'Search tickets; where takes dotted paths and operators.', { board, q: S('string', 'Text'), where: S('object', '{ "properties.risk": "high", "priority": { "in": ["High"] } }'), includeArchived: S('boolean', 'Archive too'), sort: S('string', 'Path or priority'), order: S('string', 'asc|desc'), limit: S('number', 'Max'), full: S('boolean', 'Full tickets') }, [],
      (a) => ['POST', '/api/search', { ...pick(a, ['q', 'where', 'includeArchived', 'sort', 'order', 'limit', 'full']), board: a.board || BOARD }]],
    ['wait_for_events', 'Wait for events (long-poll). Returns { events, cursor }; pass cursor as since next time.', { since: S('number', 'Cursor (omit: future only)'), timeout: S('number', 'Seconds, default 25'), ...filterProps }, [],
      (a) => ['GET', `/api/events/wait?${q({ timeout: 25, ...a })}`]],
    ['subscribe', 'Durable subscription; the server keeps your cursor.', { label: S('string', 'Label'), filter: S('object', 'Filter keys as in wait_for_events') }, [],
      (a) => ['POST', '/api/subscriptions', { label: a.label, filter: a.filter || { for: agent() } }]],
    ['next_events', 'Next events of a subscription (long-poll).', { subscription: S('string', 'Subscription id'), timeout: S('number', 'Seconds, default 25') }, ['subscription'],
      (a) => ['GET', `/api/subscriptions/${encodeURIComponent(a.subscription)}/next?${q({ timeout: a.timeout ?? 25 })}`]],
    ['set_profile', 'How you look on the board: colour, glyph, label, description, avatar.', { color: S('string', 'CSS colour'), glyph: S('string', 'Emoji or 1–2 chars'), label: S('string', 'Label'), description: S('string', 'Markdown'), imagePath: S('string', 'Absolute image path'), image: S('string', 'https image URL') }, [],
      (a) => ['PATCH', '/api/profiles/me', pick(a, ['color', 'glyph', 'label', 'description', 'imagePath', 'image'])]],
    ['remember', 'Keep a lesson in your memory: you read it in your brief every run. Only what helps on future tickets, never progress or what a card already says.', { text: S('string', 'The lesson, in a sentence or two'), from: S('string', 'Ticket id it came from') }, ['text'],
      (a) => ['POST', '/api/profiles/me/memory', pick(a, ['text', 'from'])]],
    ['forget', 'Drop one of your own memory entries (its id is in your brief).', { id: S('string', 'Entry id, m_…') }, ['id'],
      (a) => ['DELETE', `/api/profiles/me/memory/${encodeURIComponent(a.id)}`]],
    ['rename_app', 'Human only: rename the app (white-label).', { name: S('string', 'Name') }, ['name'], (a) => ['PATCH', '/api/app', { name: a.name }]],
  ];
}

// The request a tool makes, without sending it (for help text): placeholder args fill the path.
function requestShape(tool) {
  const [, , props, required, call] = tool;
  const a = { board: '<board>', id: '<ID>', column: '<column>', requestId: '<requestId>', subscription: '<subscription>', key: '<key>' };
  try {
    const r = call(a, async () => []);
    if (r && typeof r.then === 'function') return null; // looks something up first
    const [method, p] = r;
    return { method, path: decodeURIComponent(p.split('?')[0]), query: p.includes('?') ? Object.keys(props).filter((k) => !['board', 'id'].includes(k)) : [], params: Object.keys(props), required };
  } catch { return null; }
}

module.exports = { makeTools, requestShape };
