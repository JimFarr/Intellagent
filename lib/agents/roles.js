'use strict';
/* Roles as data (INT-229): templates an agent is built from. The built-ins ship in roles.json and never
   change; the human adds their own under "roles" in agents.json (a built-in's name can't be reused). An agent
   names its template with "role"; config.js's load loop applies the template's defaults and the agent's own
   keys win. A role brings a brief, wake-up settings, permissions (keys from the permission library: a role
   never holds a power), and optionally a model and extra commands. */
const map = (o) => Object.assign(Object.create(null), o);
// no prototype, so a role named "constructor" or "toString" is never mistaken for a built-in
const BUILTIN = map(require('./roles.json'));
const NAME_RE = /^[\w.-]{1,64}$/;
const MODEL_RE = /^[\w.:-]{1,64}$/;
const LISTENS = ['addressed', 'inbox', 'human', 'new-tickets'];
// what a role sets on an agent that uses it; an agent's own value for any of these is a difference
const ROLE_KEYS = ['listen', 'throttleMinutes', 'description', 'pickup', 'supervise', 'reviewer', 'perms', 'model', 'commands'];

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (v == null ? '' : String(v).slice(0, max));
const strings = (v, what, key) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`Role "${key}": "${what}" must be a list of names`);
  return [...new Set(v.map((x) => x.trim()))];
};

// One custom role from agents.json, checked; throws with a message naming the role and the key.
function cleanRole(key, d) {
  if (!NAME_RE.test(key)) throw new Error(`Role "${key}": a name is letters, digits, dot, dash or underscore (max 64)`);
  if (BUILTIN[key]) throw new Error(`Role "${key}" is built in: pick another name for your own`);
  if (!isObj(d)) throw new Error(`Role "${key}" must be an object`);
  const out = { label: text(d.label, 80) || key, icon: text(d.icon, 40) || 'agent', description: text(d.description, 2000), brief: text(d.brief, 8000) };
  if (d.listen != null) {
    const ok = (l) => LISTENS.includes(l) || isObj(l);
    if (!(Array.isArray(d.listen) ? d.listen.length && d.listen.every(ok) : ok(d.listen))) throw new Error(`Role "${key}": "listen" is ${LISTENS.join(', ')}, an event filter object, or a list of these`);
    out.listen = d.listen;
  } else out.listen = 'addressed';
  if (d.pickup != null && d.pickup !== false) {
    if (![true, 'ready', 'all'].includes(d.pickup)) throw new Error(`Role "${key}": "pickup" is ready, all or false`);
    out.pickup = d.pickup === true ? 'ready' : d.pickup;
  }
  for (const k of ['supervise', 'reviewer']) {
    if (d[k] == null) continue;
    if (typeof d[k] !== 'boolean') throw new Error(`Role "${key}": "${k}" is true or false`);
    if (d[k]) out[k] = true;
  }
  if (d.throttleMinutes != null) {
    if (!Number.isFinite(d.throttleMinutes) || d.throttleMinutes < 0) throw new Error(`Role "${key}": "throttleMinutes" is a number of minutes, 0 or more`);
    out.throttleMinutes = d.throttleMinutes;
  }
  if (d.perms != null) out.perms = strings(d.perms, 'perms', key);
  if (d.commands != null) out.commands = strings(d.commands, 'commands', key);
  if (d.model != null && d.model !== '') {
    if (!MODEL_RE.test(String(d.model))) throw new Error(`Role "${key}": "model" is a plain name like haiku, sonnet or opus`);
    out.model = String(d.model);
  }
  return out;
}

/** The board's roles: the built-ins plus agents.json's "roles". A role that doesn't check out is left out and
 *  reported in errors (shown in GET /api/agents), never guessed at. */
function createRoles(raw = {}) {
  const custom = map({});
  const errors = [];
  for (const [key, d] of Object.entries(isObj(raw) ? raw : {})) {
    try { custom[key] = cleanRole(key, d); } catch (e) { errors.push(e.message); }
  }
  const get = (key) => (key == null ? null : BUILTIN[key] || custom[key] || null);

  // What a role gives an agent before the agent's own keys are applied (config.js's load loop).
  function defaultsOf(role) {
    if (!role) return {};
    // a key the role leaves out keeps the board's default (a custom role without throttleMinutes, say)
    return Object.fromEntries(Object.entries({
      listen: role.listen, throttleMinutes: role.throttleMinutes, description: role.description,
      pickup: role.pickup || undefined, supervise: role.supervise || undefined, reviewer: role.reviewer || undefined,
    }).filter(([, v]) => v !== undefined));
  }
  // The keys an agent sets itself that its role sets differently: { key: { role, agent } }, or null with no
  // role. d is the agent's own entry in agents.json, before any defaults.
  function differences(d) {
    const role = get(d?.role);
    if (!role) return null;
    const out = {};
    for (const k of ROLE_KEYS) {
      if (d[k] === undefined) continue;
      if (JSON.stringify(d[k]) !== JSON.stringify(role[k] ?? null)) out[k] = { role: role[k] ?? null, agent: d[k] };
    }
    return out;
  }
  const view = (key, r) => ({
    key, label: r.label, icon: r.icon, description: r.description || '', brief: r.brief || '',
    listen: r.listen, pickup: r.pickup || false, supervise: !!r.supervise, reviewer: !!r.reviewer,
    throttleMinutes: r.throttleMinutes ?? null, perms: r.perms || [], model: r.model || null, commands: r.commands || [],
    builtin: !!BUILTIN[key],
  });
  return {
    errors,
    get,
    has: (key) => !!get(key),
    keys: () => [...Object.keys(BUILTIN), ...Object.keys(custom)],
    list: () => [...Object.entries(BUILTIN), ...Object.entries(custom)].map(([k, r]) => view(k, r)),
    view: (key) => (get(key) ? view(key, get(key)) : null),
    defaultsOf,
    differences,
  };
}

module.exports = { BUILTIN, ROLE_KEYS, createRoles, cleanRole };
