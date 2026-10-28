'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* runner: runs a step, or a sequence of them, in Azure DevOps. Ported from KM.Launchpad's SequenceRunner (MIT):
   each step is triggered, then polled every few seconds until it finishes; the next starts only when it
   succeeded, and a failure stops the run with the rest marked skipped. A step's branch comes from an input,
   else the one the caller sent, else the item, else the step ("__smart__" = the token owner's most recent branch,
   "__ticket__" = the branch of the run's ticket), else the pipeline's default. Bindings fill a parameter or variable from an input, a literal or an earlier step's run (runId,
   buildNumber, tag, branch); a link hands the previous run on as a pipeline resource, a container tag, a
   parameter or a variable. Runs go on detached from the request, so a closed tab never stops one.

   What Intellagent adds: a run an agent asked for is checked against its deploy.run grants twice, before it
   starts (server) and before each step triggers, with the values that step will really send (authorize). */
const { SMART, TICKET } = require('./store.ts');

type Obj = Record<string, any>;
type Ado = Obj; // lib/deploy/ado.ts
// What names a ticket in a branch: its own branch if it says one, else the keys a branch would carry (id, Jira key)
type TicketHint = { branch: string | null; keys: string[] } | null;
type Deps = {
  store: Obj; ado: () => Ado | null; uniqueName: () => string; now: () => string; emit: (type: string, run: Obj, extra?: Obj) => void;
  authorize: (run: Obj, index: number, values: Obj) => string | null; ticket?: (id: string) => TicketHint;
  pollMs?: number; stepTimeoutMs?: number; log?: (m: string) => void;
};

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'rejected']);
const trim = (s: unknown) => String(s ?? '').slice(0, 300);
const lastSeg = (b: string | null) => (b ? b.split('/').pop() || '' : '');
// What an earlier step's run can hand on: properties of the run, since Azure DevOps has no output contract.
function outputOf(run: Obj, output: string): string {
  if (output === 'buildNumber') return run.buildNumber ?? String(run.id);
  if (output === 'tag') return `${lastSeg(run.branch)}.${run.buildNumber}`;
  if (output === 'branch') return run.branch ?? '';
  return String(run.id);
}

function createRunner({ store, ado, uniqueName, now, emit, authorize, ticket = () => null, pollMs = 5000, stepTimeoutMs = 3600_000, log = console.error }: Deps) {
  const live = new Map<string, { canceled: boolean; wake: () => void }>();

  // The definition a run follows: a sequence's inputs and items, or one step as a sequence of one.
  function definitionOf(run: Obj): { inputs: Obj[]; items: Obj[] } {
    if (run.kind === 'step') return { inputs: [], items: [{ stepId: run.target }] };
    const q = store.sequence(run.target);
    if (!q) throw new Error(`The sequence "${run.target}" was deleted`);
    return { inputs: q.inputs || [], items: q.items || [] };
  }

  // Inputs: what the caller sent, else each input's default; a branch input left at __smart__ becomes the token
  // owner's most recent branch of its source pipeline.
  async function resolveInputs(def: { inputs: Obj[] }, given: Obj, client: Ado): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const x of def.inputs) out[x.id] = given?.[x.id] != null ? String(given[x.id]) : (x.default ?? '');
    for (const x of def.inputs) {
      if (out[x.id] !== SMART) continue;
      out[x.id] = (x.sourcePipelineId && x.sourceProject ? await client.recentBranch(x.sourceProject, x.sourcePipelineId, uniqueName()) : null) || '';
    }
    return out;
  }

  /* What item i sends. completed: the runs of the items before it, by index; null while planning, when what an
     earlier step will hand on isn't known yet: those keys come back in `unknown`. */
  async function resolveItem(def: { items: Obj[] }, i: number, inputs: Record<string, string>, completed: Obj[] | null, overrides: Obj, client: Ado, itemId: string | null = null) {
    const item = def.items[i];
    const s = store.step(item.stepId);
    if (!s) throw new Error(`The step "${item.stepId}" was deleted`);
    const unknown = new Set<string>();
    let branch: string | null = null;
    if (item.branchInputId && inputs[item.branchInputId]) branch = inputs[item.branchInputId];
    branch ||= overrides.branch || item.branch || s.branch || null;
    if (branch === SMART) branch = await client.recentBranch(s.project, s.pipelineId, uniqueName());
    if (branch === TICKET) {
      // never the default instead: building develop for a ticket would look like its build
      const noBranch = (m: string) => Object.assign(new Error(m), { status: 409, code: 'NO_BRANCH', extra: { hint: 'Send { "branch": "…" } with the run' } });
      const hint = itemId ? ticket(itemId) : null;
      if (!hint) throw noBranch(`${s.name} builds the ticket's branch, and the run names no ticket: run it for a ticket, or with a branch`);
      branch = hint.branch || await client.ticketBranch(s.project, s.pipelineId, hint.keys, uniqueName());
      if (!branch) throw noBranch(`No branch of ${s.pipelineName ? `${s.pipelineName}'s` : 'the pipeline\'s'} repository names ${hint.keys.join(' or ')}: push one, or run with a branch`);
    }
    if (!branch || !String(branch).trim()) branch = (await client.defaultBranch(s.project, s.pipelineId)) || 'main';
    const tps: Record<string, string> = { ...(s.templateParameters || {}), ...(overrides.parameters || {}) };
    const vars: Record<string, string> = { ...(s.variables || {}), ...(overrides.variables || {}) };
    const resources: Record<string, string> = {};
    const containers: Record<string, string> = {};
    const bag = (target: string) => (target === 'variable' ? vars : tps);
    const keyOf = (target: string, name: string) => `${target === 'variable' ? 'variables' : 'parameters'}.${name}`;
    // A binding that can't be resolved is skipped, never sent as "": that would look like a deliberate blank.
    for (const b of item.bindings || []) {
      let val: string | null = null;
      if (b.kind === 'literal') val = b.ref;
      else if (b.kind === 'input') val = inputs[b.ref] ?? null;
      else if (b.kind === 'step') {
        const [idx, out] = String(b.ref).split('.');
        const n = Number(idx);
        if (!(n >= 0 && n < i)) continue; // the cycle guard holds at run time too
        if (!completed) { unknown.add(keyOf(b.target, b.name)); delete bag(b.target)[b.name]; continue; }
        val = completed[n] ? outputOf(completed[n], out) : null;
      }
      if (val == null || val === '') continue;
      bag(b.target)[b.name] = val;
    }
    const link = item.link;
    if (link && i > 0) {
      const prev = completed ? completed[i - 1] : null;
      if (!completed) { if (link.mode === 'parameter' || link.mode === 'variable') { unknown.add(keyOf(link.mode, link.key)); delete bag(link.mode)[link.key]; } }
      else if (prev) {
        const value = outputOf(prev, link.source || 'runId');
        if (link.mode === 'resource') resources[link.key] = prev.buildNumber ?? String(prev.id); // resources are versioned by run name
        else if (link.mode === 'container') containers[link.key] = value;
        else bag(link.mode)[link.key] = value;
      }
    }
    return { step: s, branch: String(branch), templateParameters: tps, variables: vars, resources, containers, unknown };
  }

  // Everything that can be known before the run starts, for the grant check and for the run's record.
  async function plan(run: Obj) {
    const client = ado();
    if (!client) throw Object.assign(new Error('Azure DevOps is not connected'), { status: 503 });
    const def = definitionOf(run);
    const inputs = await resolveInputs(def, run.inputs || {}, client);
    const items = [];
    for (let i = 0; i < def.items.length; i++) items.push(await resolveItem(def, i, inputs, null, run.overrides || {}, client, run.item));
    return { inputs, items };
  }

  const save = () => store.saveRuns();
  const valuesOf = (r: Obj, inputs: Record<string, string>) => ({ branch: r.branch, parameters: r.templateParameters, variables: r.variables, inputs });

  function finish(run: Obj, status: string, from: number, message?: string) {
    for (let j = from; j < run.steps.length; j++) if (run.steps[j].state === 'pending') run.steps[j].state = 'skipped';
    run.status = status;
    run.finishedAt = now();
    if (message) run.message = trim(message);
    save();
    emit('deploy.run.finished', run);
  }

  const delay = (ctl: { canceled: boolean; wake: () => void }) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, pollMs);
    ctl.wake = () => { clearTimeout(t); resolve(); };
  });

  async function poll(client: Ado, project: string, buildId: number, run: Obj, i: number, ctl: Obj) {
    const deadline = Date.now() + stepTimeoutMs;
    let last: Obj | null = null; // the last good read, so a timeout still reports the real build number and link
    for (;;) {
      if (ctl.canceled) return null;
      // checked where the loop starts again too: a token that expires mid-run fails every read, and must still time out
      if (Date.now() > deadline) return { ...(last || { id: buildId, buildNumber: null, branch: null, webUrl: run.steps[i].webUrl }), state: 'completed', result: 'failed', timedOut: true };
      let cur: Obj;
      try { cur = await client.getRun(project, buildId); } catch { await delay(ctl); continue; }
      last = cur;
      if (cur.state !== run.steps[i].state || cur.webUrl !== run.steps[i].webUrl) {
        Object.assign(run.steps[i], { state: cur.state, webUrl: cur.webUrl || run.steps[i].webUrl, buildNumber: cur.buildNumber });
        save();
        emit('deploy.run.updated', run);
      }
      if (cur.state === 'completed') return cur;
      await delay(ctl);
    }
  }

  async function execute(run: Obj, ctl: { canceled: boolean; wake: () => void }) {
    try {
      const client = ado();
      if (!client) return finish(run, 'failed', 0, 'Azure DevOps is not connected');
      const def = definitionOf(run);
      const inputs = await resolveInputs(def, run.inputs || {}, client);
      const completed: Obj[] = [];
      for (let i = 0; i < run.steps.length && i < def.items.length; i++) {
        if (ctl.canceled) return finish(run, 'canceled', i);
        const st = run.steps[i];
        Object.assign(st, { state: 'running', startedAt: now() });
        save();
        emit('deploy.run.updated', run);
        let triggered: Obj;
        try {
          const r = await resolveItem(def, i, inputs, completed, run.overrides || {}, client, run.item);
          Object.assign(st, { branch: r.branch, parameters: r.templateParameters, variables: r.variables });
          const refused = authorize(run, i, valuesOf(r, inputs));
          if (refused) {
            Object.assign(st, { state: 'completed', result: 'failed', finishedAt: now(), message: trim(refused) });
            return finish(run, 'failed', i + 1, `Stopped before ${st.name}: ${refused}`);
          }
          if (ctl.canceled) return finish(run, 'canceled', i);
          triggered = await client.runPipeline(r.step.project, r.step.pipelineId, {
            branch: r.branch, templateParameters: r.templateParameters, variables: r.variables, pipelineResources: r.resources, containerResources: r.containers,
          });
        } catch (e: any) {
          Object.assign(st, { state: 'completed', result: 'failed', finishedAt: now(), message: trim(e?.message || e) });
          return finish(run, 'failed', i + 1);
        }
        Object.assign(st, { buildId: triggered.id, buildNumber: triggered.buildNumber, webUrl: triggered.webUrl, state: triggered.state });
        save();
        emit('deploy.run.updated', run);
        const final = await poll(client, st.project, triggered.id, run, i, ctl);
        if (!final) return finish(run, 'canceled', i + 1);
        Object.assign(st, { state: 'completed', result: final.result, webUrl: final.webUrl || st.webUrl, buildNumber: final.buildNumber ?? st.buildNumber, finishedAt: final.finishTime || now(), ...(final.timedOut ? { message: 'Still not finished after the time limit; it may still be running in Azure DevOps' } : {}) });
        if (String(final.result || '').toLowerCase() !== 'succeeded') return finish(run, 'failed', i + 1);
        completed.push(final);
        save();
      }
      finish(run, 'succeeded', run.steps.length);
    } catch (e: any) {
      log(`deploy: run ${run.id} crashed: ${e?.stack || e}`);
      for (const s of run.steps) {
        if (['running', 'inProgress', 'notStarted'].includes(s.state)) Object.assign(s, { state: 'completed', result: 'failed', message: trim(e?.message || e), finishedAt: now() });
      }
      if (!TERMINAL.has(run.status)) finish(run, 'failed', 0, e?.message || String(e));
    } finally {
      live.delete(run.id);
    }
  }

  function start(run: Obj) {
    const ctl = { canceled: false, wake: () => {} };
    live.set(run.id, ctl);
    run.status = 'running';
    run.startedAt = now();
    save();
    emit('deploy.run.started', run);
    execute(run, ctl);
  }

  // Stops the run: no further step starts. A pipeline run already going carries on in Azure DevOps, as in Launchpad.
  function cancel(run: Obj) {
    const ctl = live.get(run.id);
    if (ctl) { ctl.canceled = true; ctl.wake(); return; }
    if (!TERMINAL.has(run.status)) finish(run, 'canceled', 0);
  }

  // shortcut: a run the board was in the middle of when it stopped ends as failed, while its pipeline runs carry
  // on in Azure DevOps; resume polling them (each step keeps its buildId) if restarts mid-run turn out to matter.
  function recover() {
    let n = 0;
    for (const run of store.allRuns()) {
      if (run.status !== 'running') continue;
      for (const s of run.steps) {
        if (['running', 'inProgress', 'notStarted'].includes(s.state)) Object.assign(s, { state: 'completed', result: 'failed', message: 'The board restarted while this ran; follow the link to see how it ended in Azure DevOps' });
        else if (s.state === 'pending') s.state = 'skipped';
      }
      Object.assign(run, { status: 'failed', finishedAt: now(), message: 'The board restarted while this ran' });
      n++;
    }
    if (n) save();
    return n;
  }

  return { plan, start, cancel, recover, isLive: (id: string) => live.has(id), TERMINAL };
}

module.exports = { createRunner, outputOf };
