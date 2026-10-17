'use strict';
// Token usage of a run, read from its "result" object, and when a keep-alive session has grown too big.
const { DEFAULTS } = require('./config');

// Token usage from a "result" object: { input, output, cacheRead, cacheCreated }, or null when it reports
// none (callers show "n/a" rather than a made-up zero). Claude's usage, or the OpenAI-compatible one most
// other providers and adapters print (prompt_tokens counts cached ones too: they are taken out of input).
function usageOf(m) {
  const u = m && typeof m === 'object' ? m.usage : null;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  let out;
  if (Number.isFinite(u.input_tokens) || Number.isFinite(u.output_tokens)) {
    out = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheCreated: n(u.cache_creation_input_tokens) };
  } else if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens)) {
    const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens); // OpenAI ?? DeepSeek
    out = { input: Math.max(0, n(u.prompt_tokens) - cached), output: n(u.completion_tokens), cacheRead: cached, cacheCreated: 0 };
  } else return null;
  // what the model read per call: a result's usage sums every call of the turn, num_turns says how many
  if (Number.isFinite(m.num_turns) && m.num_turns > 0) out.context = Math.round((out.input + out.cacheRead + out.cacheCreated) / m.num_turns);
  return out;
}
const recycleTokens = (def) => (def.recycleAboveTokens === 0 ? 0 : Number(def.recycleAboveTokens) || DEFAULTS.recycleAboveTokens);
const bloated = (def, usage) => { const t = recycleTokens(def); return !!t && !!usage?.context && usage.context > t; };
// Usage from the last result object in a one-shot run's log (everything after the prompt).
function parseUsage(text) {
  const out = String(text || '');
  const lines = out.slice(Math.max(0, out.lastIndexOf('--- output ---'))).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { const m = JSON.parse(line); if (m.type === 'result' || m.usage) return usageOf(m); } catch { /* not a result line */ }
  }
  return null;
}
// A run the account's usage limit refused (INT-293): claude prints a rate_limit_event with status "rejected"
// and when the limit resets (epoch seconds). Returns that time in ms, a short wait when it gives none, or null
// for any other run. Only the run's own output counts, never the prompt above it.
const LIMIT_FALLBACK_MS = 15 * 60_000;
function parseLimit(text, now = Date.now()) {
  const out = String(text || '');
  for (const line of out.slice(Math.max(0, out.lastIndexOf('--- output ---'))).split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    let m;
    try { m = JSON.parse(line.trim()); } catch { continue; }
    const info = m.type === 'rate_limit_event' ? m.rate_limit_info : null;
    if (info?.status !== 'rejected') continue;
    const at = Number(info.resetsAt) * 1000;
    return at > now ? at : now + LIMIT_FALLBACK_MS;
  }
  return null;
}
const dayOf = (d = new Date()) => d.toLocaleDateString('en-CA'); // local YYYY-MM-DD: "today" is the human's today

module.exports = { usageOf, recycleTokens, bloated, parseUsage, parseLimit, dayOf };
