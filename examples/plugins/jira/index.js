'use strict';
// Example plugin: Jira. Speaks the plugin channel (docs/plugins.md): one JSON object per line on stdin and stdout.
//   { id, type: "test", connection }                         → { id, ok, result: { message } }
//   { id, type: "run", connection, action, inputs, ticket } → { id, ok, result }   ticket: { id, title, fields }
// It reads only its own folder, so it holds no dependencies: node's fetch does the calls.
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

async function jira(c, method, path, body) {
  const root = `${String(c.url).replace(/\/+$/, '')}/rest/api/2`;
  let res;
  try {
    res = await fetch(root + path, {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw new Error(`Jira could not be reached: ${e?.cause?.code || e.message}`); }
  const content = await res.text();
  if (res.status >= 300 && res.status < 400) throw new Error('Jira sent the sign-in page: check the address, username and password');
  if (!res.ok) {
    let m = '';
    try { const d = JSON.parse(content); m = [...(d.errorMessages || []), ...Object.values(d.errors || {})].join('; '); } catch { /* not json */ }
    throw new Error((m || (res.status === 401 ? 'Jira refused the username or password' : `Jira answered ${res.status}`)).slice(0, 300));
  }
  try { return content ? JSON.parse(content) : {}; } catch { throw new Error('Jira sent something that is not JSON'); }
}

const fill = (s, t) => String(s || '').replace(/\{(id|title)\}/g, (_, f) => String(t?.[f] ?? ''));
const k = encodeURIComponent;

// the input, else the ticket's `jira` field, else the first key in its title that isn't a ticket id of this board
function issueOf(inputs, t) {
  const own = String(inputs.issue || t?.fields?.jira || '').trim().toUpperCase();
  if (KEY_RE.test(own)) return own;
  const prefix = String(t?.id || '').split('-')[0].toUpperCase();
  for (const m of String(t?.title || '').toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]*-\d+)\b/g)) if (!prefix || !m[1].startsWith(`${prefix}-`)) return m[1];
  throw new Error("No Jira issue: give an issue key, set the ticket's jira field, or put a key like BET-12 in its title");
}

const actions = {
  async move(c, i, t) {
    const key = issueOf(i, t);
    const want = String(i.status || '').toLowerCase();
    const found = ((await jira(c, 'GET', `/issue/${k(key)}/transitions`)).transitions || []).find((x) => String(x.to?.name || x.name).toLowerCase() === want);
    if (!found) throw new Error(`${key} can't go to "${i.status}" from where it is`);
    await jira(c, 'POST', `/issue/${k(key)}/transitions`, { transition: { id: found.id } });
    return { issue: key, status: found.to?.name || found.name };
  },
  async comment(c, i, t) {
    const key = issueOf(i, t);
    await jira(c, 'POST', `/issue/${k(key)}/comment`, { body: fill(i.text, t) });
    return { issue: key };
  },
  async assign(c, i, t) {
    const key = issueOf(i, t);
    await jira(c, 'PUT', `/issue/${k(key)}/assignee`, { name: i.assignee || null });
    return { issue: key, assignee: i.assignee || null };
  },
  async create(c, i, t) {
    const text = fill(i.text, t);
    const d = await jira(c, 'POST', '/issue', { fields: { project: { key: String(i.project).toUpperCase() }, issuetype: { name: i.issueType || 'Task' }, summary: fill(i.summary || '{title}', t), ...(text ? { description: text } : {}) } });
    return { issue: d.key };
  },
};

async function handle(m) {
  try {
    if (m.type === 'test') return { id: m.id, ok: true, result: { message: `Signed in as ${(await jira(m.connection, 'GET', '/myself')).displayName}` } };
    if (m.type === 'run') {
      if (!actions[m.action]) throw new Error(`No action "${m.action}"`);
      return { id: m.id, ok: true, result: await actions[m.action](m.connection, m.inputs || {}, m.ticket) };
    }
    throw new Error(`Unknown call "${m.type}"`);
  } catch (e) { return { id: m.id, ok: false, error: e.message }; }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line)).then((r) => process.stdout.write(`${JSON.stringify(r)}\n`));
  }
});
