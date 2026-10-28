'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* store: the deployment library and its runs, in the board's data folder (the API is the only writer).

   A step is one pipeline with what to pass it: { id, name, alias?, project, pipelineId, pipelineName?, branch?,
   templateParameters?, variables? }. branch "" is the pipeline's default, "__smart__" the token owner's most
   recent branch and "__ticket__" the branch of the ticket the run is for. A step runs on its own, or as an item of a
   sequence. Its id never changes (grants name it).

   A sequence asks for inputs before it runs and runs its items in order, each one a step plus its wiring, as
   KM.Launchpad's sequences do (MIT):
     input: { id, name, kind: value | branch | environment, default?, sourceProject?, sourcePipelineId?, sourceParameter? }
     item:  { stepId, branch?, branchInputId?, bindings?: [{ target: parameter | variable, name, kind: input | step | literal, ref }],
              link?: { mode: resource | container | parameter | variable, key, source?: runId | buildNumber | tag | branch } }
   A step binding's ref is "<earlier item index>.<output>": only an earlier item, so a cycle can't be written down. */
const jsonfile = require('../jsonfile');

const SMART = '__smart__';
const TICKET = '__ticket__';
const OUTPUTS = ['runId', 'buildNumber', 'tag', 'branch'];
const RUNS_KEPT = 300;
type Obj = Record<string, any>;
type Fail = (status: number, message: string, extra?: Obj) => never;

function createDeployStore({ file, runsFile, fail, now }: { file: string; runsFile: string; fail: Fail; now: () => string }) {
  const lib: { steps: Obj[]; sequences: Obj[] } = { steps: [], sequences: [], ...jsonfile.readOr(file, {}) };
  delete (lib as Obj).agentsOff; // an early build's switch: each deployment is its own permission now
  const runsData: { runs: Obj[] } = { runs: [], ...jsonfile.readOr(runsFile, {}) };
  const save = () => jsonfile.writeAtomic(file, lib);
  const saveRuns = () => jsonfile.writeAtomic(runsFile, runsData);

  /* ─── checks: everything that comes in is cleaned here or refused with what to change ─── */
  const text = (v: unknown, what: string, max = 200, { required = false } = {}): string => {
    if (v == null || v === '') { if (required) fail(400, `${what} is required`); return ''; }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') fail(400, `${what} must be text`);
    const s = String(v).trim();
    if (s.length > max) fail(400, `${what} is longer than ${max} characters`);
    if (required && !s) fail(400, `${what} is required`);
    return s;
  };
  const values = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v == null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) fail(400, `${what} must be an object of name: value`);
    const out: Record<string, string> = {};
    const entries = Object.entries(v as Obj);
    if (entries.length > 100) fail(400, `${what}: at most 100`);
    for (const [k, x] of entries) {
      const key = text(k, `${what} name`, 200, { required: true });
      if (x == null) continue; // null clears it
      out[key] = text(x, `${what}.${key}`, 2000);
    }
    return Object.keys(out).length ? out : undefined;
  };
  const pipelineId = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(400, 'pipelineId must be the pipeline\'s number in Azure DevOps');
    return n;
  };
  // ids are what a deployment's power is named after (deploy.step.<id>): lower-case letters, digits and inner dashes
  const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'step';
  const freeId = (name: string, taken: (id: string) => boolean) => {
    const base = slug(name);
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    return id;
  };

  function cleanStep(b: Obj): Obj {
    if (!b || typeof b !== 'object') fail(400, 'Send the step as an object');
    const branch = text(b.branch, 'branch', 250);
    return {
      name: text(b.name, 'name', 80, { required: true }),
      ...(text(b.alias, 'alias', 40) ? { alias: text(b.alias, 'alias', 40) } : {}),
      project: text(b.project, 'project', 200, { required: true }),
      pipelineId: pipelineId(b.pipelineId),
      ...(text(b.pipelineName, 'pipelineName', 200) ? { pipelineName: text(b.pipelineName, 'pipelineName', 200) } : {}),
      ...(branch ? { branch } : {}),
      ...(values(b.templateParameters, 'templateParameters') ? { templateParameters: values(b.templateParameters, 'templateParameters') } : {}),
      ...(values(b.variables, 'variables') ? { variables: values(b.variables, 'variables') } : {}),
    };
  }

  function cleanSequence(b: Obj): Obj {
    if (!b || typeof b !== 'object') fail(400, 'Send the sequence as an object');
    const inputsIn = b.inputs ?? [];
    if (!Array.isArray(inputsIn) || inputsIn.length > 20) fail(400, 'inputs must be a list of at most 20');
    const inputs = inputsIn.map((x: Obj, i: number) => {
      if (!x || typeof x !== 'object') fail(400, `inputs[${i}] must be an object`);
      const name = text(x.name, `inputs[${i}].name`, 80, { required: true });
      const kind = text(x.kind || 'value', `inputs[${i}].kind`, 20);
      if (!['value', 'branch', 'environment'].includes(kind)) fail(400, `inputs[${i}].kind must be value, branch or environment`);
      const sp = x.sourcePipelineId == null || x.sourcePipelineId === '' ? null : pipelineId(x.sourcePipelineId);
      return {
        id: text(x.id, `inputs[${i}].id`, 48) || '', name, kind,
        ...(x.default != null && x.default !== '' ? { default: text(x.default, `inputs[${i}].default`, 250) } : {}),
        ...(kind !== 'value' && text(x.sourceProject, `inputs[${i}].sourceProject`, 200) ? { sourceProject: text(x.sourceProject, '', 200) } : {}),
        ...(kind !== 'value' && sp ? { sourcePipelineId: sp } : {}),
        ...(kind === 'environment' && text(x.sourceParameter, `inputs[${i}].sourceParameter`, 200) ? { sourceParameter: text(x.sourceParameter, '', 200) } : {}),
      };
    });
    // input ids: kept when given (bindings name them), made from the name otherwise
    const seen = new Set<string>();
    for (const x of inputs) {
      if (x.id && !/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(x.id)) fail(400, `Input id "${x.id}" may hold letters, digits, - and _ only`);
      if (!x.id) x.id = freeId(x.name, (id) => seen.has(id) || inputs.some((y: Obj) => y !== x && y.id === id));
      if (seen.has(x.id)) fail(400, `Two inputs share the id "${x.id}"`);
      seen.add(x.id);
    }
    const itemsIn = b.items ?? [];
    if (!Array.isArray(itemsIn) || !itemsIn.length) fail(400, 'A sequence needs at least one step in items');
    if (itemsIn.length > 30) fail(400, 'A sequence holds at most 30 steps');
    const items = itemsIn.map((x: Obj, i: number) => {
      if (!x || typeof x !== 'object') fail(400, `items[${i}] must be an object`);
      const stepId = text(x.stepId, `items[${i}].stepId`, 60, { required: true });
      if (!step(stepId)) fail(400, `items[${i}]: there is no step "${stepId}"`, { code: 'NOT_FOUND', hint: 'GET /api/deploy/steps lists them' });
      const branchInputId = text(x.branchInputId, `items[${i}].branchInputId`, 48);
      if (branchInputId && !seen.has(branchInputId)) fail(400, `items[${i}].branchInputId: there is no input "${branchInputId}"`);
      const bindingsIn = x.bindings ?? [];
      if (!Array.isArray(bindingsIn) || bindingsIn.length > 100) fail(400, `items[${i}].bindings must be a list of at most 100`);
      const bindings = bindingsIn.map((g: Obj, j: number) => {
        const at = `items[${i}].bindings[${j}]`;
        if (!g || typeof g !== 'object') fail(400, `${at} must be an object`);
        const target = text(g.target || 'parameter', `${at}.target`, 20);
        if (!['parameter', 'variable'].includes(target)) fail(400, `${at}.target must be parameter or variable`);
        const kind = text(g.kind, `${at}.kind`, 20, { required: true });
        const ref = text(g.ref, `${at}.ref`, 2000, { required: kind !== 'literal' });
        if (kind === 'input' && !seen.has(ref)) fail(400, `${at}: there is no input "${ref}"`);
        else if (kind === 'step') {
          const m = /^(\d+)\.(\w+)$/.exec(ref);
          if (!m || !OUTPUTS.includes(m[2])) fail(400, `${at}.ref must be "<step index>.<output>", output one of ${OUTPUTS.join(', ')}`);
          if (Number(m![1]) >= i) fail(400, `${at}: a step can only take values from a step before it (item ${m![1]} is not before item ${i})`);
        } else if (kind !== 'input' && kind !== 'literal') fail(400, `${at}.kind must be input, step or literal`);
        return { target, name: text(g.name, `${at}.name`, 200, { required: true }), kind, ref };
      });
      let link = null;
      if (x.link && x.link.mode && x.link.mode !== 'none') {
        const mode = text(x.link.mode, `items[${i}].link.mode`, 20);
        if (!['resource', 'container', 'parameter', 'variable'].includes(mode)) fail(400, `items[${i}].link.mode must be resource, container, parameter or variable`);
        const source = text(x.link.source || 'runId', `items[${i}].link.source`, 20);
        if (!OUTPUTS.includes(source)) fail(400, `items[${i}].link.source must be one of ${OUTPUTS.join(', ')}`);
        link = { mode, key: text(x.link.key, `items[${i}].link.key`, 200, { required: true }), source };
      }
      const branch = text(x.branch, `items[${i}].branch`, 250);
      return { stepId, ...(branch ? { branch } : {}), ...(branchInputId ? { branchInputId } : {}), ...(bindings.length ? { bindings } : {}), ...(link ? { link } : {}) };
    });
    return { name: text(b.name, 'name', 80, { required: true }), inputs, items };
  }

  /* ─── the library ─── */
  const step = (id: string) => lib.steps.find((s) => s.id === id) || null;
  const sequence = (id: string) => lib.sequences.find((s) => s.id === id) || null;
  const usedBy = (stepId: string) => lib.sequences.filter((q) => q.items.some((x: Obj) => x.stepId === stepId)).map((q) => q.id);

  function saveStep(body: Obj, by: string, id?: string): Obj {
    const clean = cleanStep(body);
    const at = now();
    if (id) {
      const cur = step(id) || fail(404, `No step "${id}"`, { code: 'NOT_FOUND' });
      Object.keys(cur).forEach((k) => { if (!['id', 'createdAt', 'createdBy'].includes(k)) delete cur[k]; });
      Object.assign(cur, clean, { updatedAt: at, updatedBy: by });
      save();
      return cur;
    }
    const s = { id: freeId(clean.name, (x) => !!step(x)), ...clean, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by };
    lib.steps.push(s);
    save();
    return s;
  }
  function deleteStep(id: string) {
    if (!step(id)) fail(404, `No step "${id}"`, { code: 'NOT_FOUND' });
    const used = usedBy(id);
    if (used.length) fail(409, `Step "${id}" is used by ${used.join(', ')}`, { code: 'CONFLICT', hint: 'Take it out of those sequences first', sequences: used });
    lib.steps = lib.steps.filter((s) => s.id !== id);
    save();
  }
  function saveSequence(body: Obj, by: string, id?: string): Obj {
    const clean = cleanSequence(body);
    const at = now();
    if (id) {
      const cur = sequence(id) || fail(404, `No sequence "${id}"`, { code: 'NOT_FOUND' });
      Object.assign(cur, clean, { updatedAt: at, updatedBy: by });
      save();
      return cur;
    }
    const q = { id: freeId(clean.name, (x) => !!sequence(x)), ...clean, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by };
    lib.sequences.push(q);
    save();
    return q;
  }
  function deleteSequence(id: string) {
    if (!sequence(id)) fail(404, `No sequence "${id}"`, { code: 'NOT_FOUND' });
    lib.sequences = lib.sequences.filter((s) => s.id !== id);
    save();
  }

  /* ─── runs, newest first ─── */
  const run = (id: string) => runsData.runs.find((r) => r.id === id) || null;
  function addRun(r: Obj) {
    runsData.runs.unshift(r);
    // never drop a run that is still going; the oldest finished ones go first
    while (runsData.runs.length > RUNS_KEPT) {
      const i = runsData.runs.map((x) => ['waiting', 'running'].includes(x.status)).lastIndexOf(false);
      if (i < 0) break;
      runsData.runs.splice(i, 1);
    }
    saveRuns();
    return r;
  }
  function listRuns({ kind, target, top = 20 }: { kind?: string; target?: string; top?: number } = {}) {
    return runsData.runs.filter((r) => (!kind || r.kind === kind) && (!target || r.target === target)).slice(0, Math.min(100, Math.max(1, top)));
  }

  return {
    steps: () => lib.steps, step, saveStep, deleteStep, usedBy,
    sequences: () => lib.sequences, sequence, saveSequence, deleteSequence,
    run, addRun, listRuns, saveRuns, allRuns: () => runsData.runs,
  };
}

module.exports = { createDeployStore, SMART, TICKET, OUTPUTS };
