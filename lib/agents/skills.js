'use strict';
// Skills (INT-237): SKILL.md files the human attaches to an agent. The prompt lists each by name and description;
// for a Claude run the board also copies the skill into the agent's own worktree (.claude/skills/<id>/), where
// Claude Code loads it only when the task needs it. A skill is instructions, never a permission.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARK = '.intellagent-skill'; // in every folder the board wrote, so it only ever removes its own
const MAX_FILES = 200;
const MAX_BYTES = 2_000_000;
const OWN = /^(local\.json|agents\.json)$/i;

const badRequest = (message, hint) => { const e = new Error(message); e.status = 400; e.code = 'BAD_REQUEST'; if (hint) e.extra = { hint }; return e; };

// skills: [{ id?, path, on? }]; path is a SKILL.md or the folder holding one. Name and description are read from the
// file's front matter on every use, so an edit to the file shows at once.
function cleanSkills(v, checkPath) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw badRequest('skills must be a list', '[{ "path": "skills/intellagent/SKILL.md" }]');
  if (v.length > 30) throw badRequest('At most 30 skills');
  const ids = new Set();
  return v.map((raw, i) => {
    const at = `skills[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${at} must be an object`);
    const p = String(raw.path || '').trim();
    if (!p) throw badRequest(`${at}.path is required`, 'The path of a SKILL.md, or of the folder that holds one, inside the project');
    if (p.length > 500) throw badRequest(`${at}.path is too long`);
    const c = checkPath(p);
    if (!c.ok) { const e = badRequest(`${at}.path: ${c.why}`, 'Attach a skill inside the project; never the board\'s own files'); e.status = 403; e.code = 'FORBIDDEN'; throw e; }
    const src = locate(c.abs);
    if (!src) throw badRequest(`${at}.path: no SKILL.md there`, 'Point at a SKILL.md, or a folder with a SKILL.md in it');
    let id = typeof raw.id === 'string' && /^[\w.-]{1,40}$/.test(raw.id) ? raw.id : slug(path.basename(src.dir)) || `skill_${crypto.randomBytes(3).toString('hex')}`;
    if (ids.has(id)) id = `${id}_${crypto.randomBytes(2).toString('hex')}`;
    ids.add(id);
    return { id, path: p, on: raw.on !== false };
  });
}
const slug = (s) => String(s).toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// { dir, file } of the skill an absolute path means, or null
function locate(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) { const file = path.join(abs, 'SKILL.md'); return fs.existsSync(file) ? { dir: abs, file } : null; }
    return path.basename(abs).toLowerCase() === 'skill.md' ? { dir: path.dirname(abs), file: abs } : null;
  } catch { return null; }
}

// name and description from the front matter ("name: x" / "description: y"), else the folder name
function describe(file, fallback) {
  let head = '';
  try { head = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing */ }
  const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] || '';
  const pick = (k) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  return { name: pick('name') || fallback, description: pick('description') };
}

// The agent's switched-on skills, resolved: [{ id, name, description, path, dir, file }]; a skill that can't be read
// is returned with `error` and is neither listed nor copied.
function resolve(skills, checkPath) {
  return (skills || []).filter((s) => s && s.on !== false).map((s) => {
    const c = checkPath(s.path);
    if (!c.ok) return { id: s.id, path: s.path, error: `not read: ${c.why}` };
    const src = locate(c.abs);
    if (!src) return { id: s.id, path: s.path, error: 'not read: no SKILL.md there' };
    return { id: s.id, path: s.path, ...describe(src.file, s.id), ...src };
  });
}

// The lines of the prompt: name, description and where the skill is
function listText(resolved) {
  const ok = resolved.filter((r) => !r.error);
  if (!ok.length) return '';
  return ['Skills the human attached to you. Each loads in full only when the task needs it:', ...ok.map((r) => `- **${r.name}**${r.description ? ` — ${r.description}` : ''} (\`${r.path}\`)`)].join('\n');
}

// What a changed skill list means to a warm session: a different signature replaces it
// Claude reads skills when a session starts, so an edited file counts too: the signature hashes every file's content.
function hashDir(dir, h, budget = { files: 0 }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink() || OWN.test(e.name) || e.name === '.git' || e.name === MARK) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) hashDir(p, h, budget);
    else if (e.isFile() && ++budget.files <= MAX_FILES) { h.update(`${e.name}\0`); try { h.update(fs.readFileSync(p)); } catch { /* gone */ } }
  }
}
const signature = (resolved) => resolved.filter((r) => !r.error).map((r) => { const h = crypto.createHash('sha1'); hashDir(r.dir, h); return `${r.id}:${r.file}:${h.digest('hex')}`; }).join('|');

function copyDir(from, to, budget) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isSymbolicLink() || OWN.test(e.name) || e.name === '.git' || e.name === MARK) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) { copyDir(a, b, budget); continue; }
    if (!e.isFile()) continue;
    const size = fs.statSync(a).size;
    if (++budget.files > MAX_FILES || (budget.bytes += size) > MAX_BYTES) throw new Error(`a skill folder holds more than ${MAX_FILES} files or ${Math.round(MAX_BYTES / 1e6)} MB`);
    fs.copyFileSync(a, b);
  }
}

/**
 * Make <workspace>/.claude/skills hold exactly the agent's skills: copy each one in, remove the ones the board
 * wrote earlier that it no longer has. A folder the board did not write is never touched. Each carries a
 * .gitignore of `*`, so nothing of it is ever committed from the worktree. Returns problems (a skill that failed
 * to copy), never throws: a run goes ahead without the skill rather than not at all.
 */
function deliver(workspace, resolved) {
  const root = path.join(workspace, '.claude', 'skills');
  const problems = [];
  const want = new Set(resolved.filter((r) => !r.error).map((r) => r.id));
  try {
    for (const e of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
      if (e.isDirectory() && !want.has(e.name) && fs.existsSync(path.join(root, e.name, MARK))) fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    }
  } catch (e) { problems.push(`could not clean ${root}: ${e.message}`); }
  for (const r of resolved) {
    if (r.error) { problems.push(`${r.id}: ${r.error}`); continue; }
    const to = path.join(root, r.id);
    try {
      if (fs.existsSync(to) && !fs.existsSync(path.join(to, MARK))) { problems.push(`${r.id}: .claude/skills/${r.id} exists and is not the board's`); continue; }
      fs.rmSync(to, { recursive: true, force: true });
      copyDir(r.dir, to, { files: 0, bytes: 0 });
      fs.writeFileSync(path.join(to, MARK), `${r.path}\n`);
      fs.writeFileSync(path.join(to, '.gitignore'), '*\n');
    } catch (e) { problems.push(`${r.id}: ${e.message}`); }
  }
  return problems;
}

module.exports = { cleanSkills, resolve, listText, signature, deliver, locate, describe, MARK };
