'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* grants: may an agent run this deployment, with these values? Every step and sequence is its own power,
   deploy.step.<id> and deploy.sequence.<id>, granted per agent in Assignments. Its rules ("where") are about
   what reaches Azure DevOps, not how it got there, so a value that came through an input, a fixed value or an
   earlier step is judged the same:
     branch: <names>   parameters.<name>: <values>   variables.<name>: <values>   inputs.<id>: <values> (sequences)
   Each key takes a value or a list; "release/*" matches by prefix. On a step every key must hold, and a key the
   step doesn't send never holds. On a sequence, inputs must hold, and branch, parameters and variables bind each
   step that sends them (a build that sends no environment is not held to an environment rule).
   "approve": "human" lets a run wait for the human's OK instead of being refused; the agent runs without asking
   only when a grant that needs no OK holds. */

type Where = Record<string, string | string[]>;
type Grant = { power: string; where?: Where; approve?: string };
type Kind = 'step' | 'sequence' | 'jira' | 'devstack' | 'confluence' | 'ado';
type Values = { project?: string | null; status?: string | null; service?: string | null; source?: string | null; space?: string | null; repo?: string | null; branch: string | null; parameters: Record<string, string>; variables: Record<string, string>; inputs?: Record<string, string> };
type Verdict = { ok: boolean; approve: boolean; deferred: string[]; why: string };

// A Jira action (lib/jira) is a power the same way, jira.action.<id>; its rules name project and status. So is a
// DevStack action (lib/devstack), devstack.action.<id>; its rules name service and source (the build it tests). And a
// Confluence action (lib/confluence), confluence.action.<id>; its rules name space (the page's space key). And an
// Azure DevOps pull request action (lib/deploy/pr-actions.ts), ado.action.<id>; its rules name repo.
const POWER_RE = /^(?:deploy\.(step|sequence)|(jira|devstack|confluence|ado)\.action)\.([a-z0-9][a-z0-9-]{0,59})$/;
const powerOf = (kind: Kind, id: string) => (kind === 'jira' || kind === 'devstack' || kind === 'confluence' || kind === 'ado' ? `${kind}.action.${id}` : `deploy.${kind}.${id}`);
const parsePower = (key: string): { kind: Kind; id: string } | null => { const m = POWER_RE.exec(String(key)); return m ? { kind: (m[1] || m[2]) as Kind, id: m[3] } : null; };
const validKey = (k: string, kind: Kind) => (kind === 'jira' ? /^(project|status)$/.test(k) : kind === 'devstack' ? /^(service|source)$/.test(k) : kind === 'confluence' ? k === 'space' : kind === 'ado' ? k === 'repo'
  : /^(branch|(parameters|variables)\.[^.\s]\S*)$/.test(k) || (kind === 'sequence' && /^inputs\.[^.\s]\S*$/.test(k)));
const KEYS_HINT = (kind: Kind) => (kind === 'jira' ? 'project (the issue\'s project key), status (where it moves it to)'
  : kind === 'devstack' ? 'service (the DevStack service), source (the build it tests, e.g. branch:feature/*)'
  : kind === 'confluence' ? 'space (the page\'s space key, e.g. ENG)'
  : kind === 'ado' ? 'repo (the PR\'s repository, e.g. SB.Placement)'
  : `branch, parameters.<name>, variables.<name>${kind === 'sequence' ? ', inputs.<id>' : ''}; a value may end in * (release/*)`);

const matches = (want: string | string[], have: string | null | undefined) => have != null && [].concat(want as any).some((w: string) => {
  const s = String(w);
  return s.endsWith('*') ? String(have).startsWith(s.slice(0, -1)) : String(have) === s;
});
function valueOf(k: string, v: Values): string | null | undefined {
  if (k === 'branch' || k === 'project' || k === 'status' || k === 'service' || k === 'source' || k === 'space' || k === 'repo') return v[k];
  const [bag, ...rest] = k.split('.');
  const name = rest.join('.');
  return bag === 'parameters' ? v.parameters[name] : bag === 'variables' ? v.variables[name] : bag === 'inputs' ? v.inputs?.[name] : undefined;
}

// grants: the agent's grants of this deployment's power. unknown: keys whose value only an earlier step's run will
// tell (a binding or link from it); they count as held now and come back in `deferred`, so the runner asks again,
// with the real value, before the step starts.
function judge(grants: Grant[], kind: Kind, v: Values, unknown: Set<string> = new Set()): Verdict {
  if (!grants.length) return { ok: false, approve: false, deferred: [], why: 'no grant' };
  let best: Verdict | null = null;
  // why each grant didn't hold, merged by key: it reads once, not once per grant
  const misses = new Map<string, { have: string | null | undefined; allow: Set<string>; grants: number }>();
  for (const g of grants) {
    const deferred: string[] = [];
    let missed = false;
    for (const [k, want] of Object.entries(g.where || {})) {
      if (!validKey(k, kind)) { misses.set(k, { have: undefined, allow: new Set(), grants: 1 }); missed = true; break; }
      if (unknown.has(k)) { deferred.push(k); continue; }
      const have = valueOf(k, v);
      // a sequence's rules on what a step sends bind only the steps that send it
      if (kind === 'sequence' && have == null && !k.startsWith('inputs.')) continue;
      if (!matches(want, have)) {
        const m = misses.get(k) || { have, allow: new Set<string>(), grants: 0 };
        for (const w of [].concat(want as any)) m.allow.add(String(w));
        m.grants++;
        misses.set(k, m);
        missed = true;
        break;
      }
    }
    if (missed) continue;
    const verdict = { ok: true, approve: g.approve === 'human', deferred, why: '' };
    // prefer a grant that needs no OK, then one with nothing left to check later
    if (!best || (best.approve && !verdict.approve) || (best.approve === verdict.approve && best.deferred.length > deferred.length)) best = verdict;
  }
  const why = [...misses].map(([k, m]) => (!m.allow.size ? `"${k}" is not something a deployment's rules can name (${KEYS_HINT(kind)})`
    : `${k} is ${m.have == null ? 'not set' : `"${m.have}"`}, ${m.grants > 1 ? 'your grants allow' : 'the grant allows'} ${[...m.allow].join(', ')}`)).join('; ');
  return best || { ok: false, approve: false, deferred: [], why };
}

module.exports = { judge, validKey, powerOf, parsePower, KEYS_HINT };
