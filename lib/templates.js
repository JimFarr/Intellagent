'use strict';
// Board presets: columns + flags, ticket schema and standing rules.
// Used by `intellagent init --template <name>` and `POST /api/boards { template }`.

const DONE = { releaseLeaseOnEnter: true, humanOnlyIn: true };
// Ticket templates shared by several presets.
const BUG = { key: 'bug', label: 'Bug', icon: 'issue', type: 'issue', priority: 'High', help: 'Something is broken',
  description: '**Steps to reproduce**\n1. \n\n**Expected**\n\n**Actual**\n\n- [ ] Reproduced\n- [ ] Fixed\n- [ ] Test added' };
const RISK = { key: 'risk', label: 'Risk', type: 'enum', icon: 'flag', stub: 'top', options: [{ value: 'low', color: '#4cc38a' }, { value: 'medium', color: '#f2a541' }, { value: 'high', color: '#ff5d73' }] };

module.exports = {
  default: {
    label: 'General',
    description: 'Backlog → Ready → In Progress → Review → Done (human-approved).',
    columns: [
      { name: 'Backlog', icon: 'inbox', color: '#8b8fa3', flags: { allowCreate: true } },
      { name: 'Ready', icon: 'target', color: '#5aa9e6', flags: { pickup: true, allowCreate: true } },
      { name: 'In Progress', icon: 'play', color: '#f2a541', flags: { working: true } },
      { name: 'Review', icon: 'eye', color: '#b07cf2', flags: { review: true } },
      { name: 'Done', icon: 'check', color: '#4cc38a', flags: DONE },
    ],
    ticketTemplates: [
      BUG,
      { key: 'feature', label: 'Feature', icon: 'sparkle', type: 'task', help: 'Something new', description: '**Why**\n\n**Done when**\n- [ ] ' },
      { key: 'question', label: 'Question', icon: 'ask', type: 'spike', help: 'Something to find out', description: '**Question**\n\n**What would answer it**\n' },
    ],
  },

  simple: {
    label: 'Simple',
    description: 'To Do → Doing → Done. No gates.',
    columns: [
      { name: 'To Do', icon: 'inbox', color: '#5aa9e6', flags: { pickup: true, allowCreate: true } },
      { name: 'Doing', icon: 'play', color: '#f2a541', flags: { working: true } },
      { name: 'Done', icon: 'check', color: '#4cc38a', flags: { releaseLeaseOnEnter: true } },
    ],
  },

  empty: { label: 'Empty', description: 'No columns — define everything through the API.', columns: [] },

  software: {
    label: 'Software project',
    description: 'Triage → Ready → In Progress (WIP 4) → Review → Done. Fields for area, estimate, PR, CI and risk.',
    columns: [
      { name: 'Triage', icon: 'inbox', color: '#8b8fa3', flags: { allowCreate: true } },
      { name: 'Ready', icon: 'target', color: '#5aa9e6', flags: { pickup: true, allowCreate: true } },
      { name: 'In Progress', icon: 'play', color: '#f2a541', flags: { working: true, wipLimit: 4 } },
      { name: 'Review', icon: 'eye', color: '#b07cf2', flags: { review: true } },
      { name: 'Done', icon: 'check', color: '#4cc38a', flags: { ...DONE, autoArchiveAfterDays: 14 } },
    ],
    schema: {
      fields: [
        { key: 'area', label: 'Area', type: 'tags', icon: 'tag', stub: 'meta', help: 'Part of the codebase this touches' },
        { key: 'estimate', label: 'Estimate', type: 'number', icon: 'clock', stub: 'meta', min: 0, help: 'Hours' },
        RISK,
        { key: 'pr', label: 'Pull request', type: 'url', icon: 'link' },
        { key: 'ci', label: 'CI', type: 'enum', icon: 'activity', stub: 'top', ui: 'read', options: [{ value: 'pending', color: '#f2a541' }, { value: 'passing', color: '#4cc38a' }, { value: 'failing', color: '#ff5d73' }, { value: 'merged', color: '#b07cf2' }], help: 'Filled by `intellagent hook sync-ci`' },
        { key: 'acceptance', label: 'Acceptance criteria', type: 'markdown', icon: 'check', help: 'How we know it is done' },
      ],
    },
    ticketTemplates: [
      { ...BUG, column: 'Triage', fields: { risk: 'medium' } },
      { key: 'feature', label: 'Feature', icon: 'sparkle', type: 'task', column: 'Triage', help: 'Something new', description: '**Why**\n\n**Approach**\n', fields: { acceptance: '- [ ] ' } },
      { key: 'chore', label: 'Chore', icon: 'task', type: 'task', priority: 'Low', column: 'Ready', help: 'Upkeep: deps, cleanup, docs', fields: { risk: 'low' } },
      { key: 'spike', label: 'Spike', icon: 'spike', type: 'spike', column: 'Triage', help: 'Timeboxed investigation', description: '**Question**\n\n**Timebox**: \n\n**Findings**\n' },
    ],
    directives: [
      '- Project conventions (tests, style, what needs approval) live in **CLAUDE.md** — follow them; these rules only cover how we use this board.',
      '- Pick work from **Ready**; new ideas go to **Triage**.',
      '- Working alone? Hold the whole board (master lease) instead of leasing each ticket. Release it before spawning helper agents.',
      '- Decisions go on the card (*needs you*), not only in chat. Finish with **request review** and how to verify.',
      '- End each session with a short digest entry.',
    ].join('\n'),
  },

  research: {
    label: 'Research',
    description: 'Questions → Investigating → Parked → Findings → Decided. Fields for confidence, timebox and sources.',
    columns: [
      { name: 'Questions', icon: 'inbox', color: '#5aa9e6', flags: { pickup: true, allowCreate: true } },
      { name: 'Investigating', icon: 'play', color: '#f2a541', flags: { working: true, wipLimit: 3 } },
      { name: 'Parked', icon: '⏸', color: '#8b8fa3', flags: { allowCreate: true } },
      { name: 'Findings', icon: 'eye', color: '#b07cf2', flags: { review: true } },
      { name: 'Decided', icon: 'check', color: '#4cc38a', flags: DONE },
    ],
    schema: {
      builtins: { type: { label: 'Kind' } },
      fields: [
        { key: 'confidence', label: 'Confidence', type: 'enum', icon: 'flag', stub: 'top', options: [{ value: 'low', color: '#ff5d73' }, { value: 'medium', color: '#f2a541' }, { value: 'high', color: '#4cc38a' }] },
        { key: 'timebox', label: 'Timebox', type: 'number', icon: 'clock', stub: 'meta', min: 0, help: 'Hours before stopping to report' },
        { key: 'sources', label: 'Sources', type: 'markdown', icon: 'link', help: 'Links and citations backing the finding' },
        { key: 'recommendation', label: 'Recommendation', type: 'markdown', icon: 'sparkle' },
      ],
    },
    ticketTemplates: [
      { key: 'question', label: 'Question', icon: 'ask', type: 'spike', help: 'Something to find out', description: '**Question**\n\n**Why it matters**\n\n**What would answer it**\n', fields: { timebox: 4 } },
      { key: 'comparison', label: 'Comparison', icon: 'layers', type: 'spike', help: 'Weigh options against each other', description: '| Option | Pros | Cons |\n|---|---|---|\n|  |  |  |\n' },
    ],
    directives: [
      '- Project conventions live in **CLAUDE.md**; these rules only cover how we use this board.',
      '- Respect the timebox: when it runs out, write up what you have and request review.',
      '- Cite sources for every claim; mark confidence honestly.',
      '- Findings end with a recommendation and the main alternative you rejected.',
      '- Park questions you cannot answer yet, with the blocker in a comment.',
    ].join('\n'),
  },

  ops: {
    label: 'Operations',
    description: 'Incoming → Triaged → Mitigating (WIP 2) → Monitoring → Resolved. Severity, service, runbook fields.',
    columns: [
      { name: 'Incoming', icon: 'inbox', color: '#ff5d73', flags: { allowCreate: true } },
      { name: 'Triaged', icon: 'target', color: '#f2a541', flags: { pickup: true, allowCreate: true } },
      { name: 'Mitigating', icon: 'play', color: '#ff8a00', flags: { working: true, wipLimit: 2 } },
      { name: 'Monitoring', icon: 'eye', color: '#5aa9e6', flags: { review: true } },
      { name: 'Resolved', icon: 'check', color: '#4cc38a', flags: { ...DONE, autoArchiveAfterDays: 30 } },
    ],
    schema: {
      fields: [
        { key: 'severity', label: 'Severity', type: 'enum', icon: 'flag', stub: 'top', options: [{ value: 'sev1', color: '#ff2e2e' }, { value: 'sev2', color: '#ff8a00' }, { value: 'sev3', color: '#f2c94c' }, { value: 'sev4', color: '#8b8fa3' }] },
        { key: 'service', label: 'Service', type: 'tags', icon: 'tag', stub: 'meta' },
        { key: 'impact', label: 'Impact', type: 'text', icon: 'activity', help: 'Who is affected and how' },
        { key: 'runbook', label: 'Runbook', type: 'url', icon: 'link' },
        { key: 'started', label: 'Started', type: 'date', icon: 'cal' },
      ],
    },
    ticketTemplates: [
      { key: 'incident', label: 'Incident', icon: 'issue', type: 'issue', priority: 'Critical', column: 'Incoming', help: 'Something is down or degraded', fields: { severity: 'sev2' }, description: '**What is happening**\n\n**Since**\n\n- [ ] Mitigated\n- [ ] Root cause found\n- [ ] Follow-ups filed' },
      { key: 'request', label: 'Request', icon: 'inbox', type: 'task', column: 'Incoming', help: 'Access, config or capacity change', fields: { severity: 'sev4' } },
    ],
    directives: [
      '- Project conventions live in **CLAUDE.md**; these rules only cover how we use this board.',
      '- sev1/sev2: raise *needs you* immediately, then keep a live status updated at least every 15 minutes.',
      '- Never run destructive or irreversible commands (deletes, restarts of shared systems, data migrations) without explicit approval on the ticket.',
      '- Follow the runbook when one is linked; note any deviation in a comment.',
      '- Move to **Monitoring** with a summary when mitigated; a human resolves.',
    ].join('\n'),
  },
};
