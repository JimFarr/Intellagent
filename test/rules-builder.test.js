// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The Rules page's condition builder (public/js/rules.js): text → rows and groups joined by AND / OR → the same text,
// and what it can't show as rows stays text. The browser module's pure part is loaded on its own, as the page has it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rules.js'), 'utf8');
const { parseCond, condText, condFields } = new Function(`${src.slice(src.indexOf('const OPS'), src.indexOf('export function createRules'))};return { parseCond, condText, condFields };`)();
const fields = condFields({ columns: [{ id: 'in-progress', name: 'In Progress' }], schema: { fields: [{ key: 'risk', label: 'Risk', type: 'enum', options: ['low', 'high'] }] } }, [], ['full approval']);
const shape = (c) => c.items.map((i) => (i.group ? { [i.mode]: i.rows.map((r) => `${r.k} ${r.op}`) } : `${i.k} ${i.op}`));

describe('rules: the condition builder', () => {
  it('reads each kind of term into a row, and writes the same text back', () => {
    const cases = [
      ['priority:High|Critical', ['priority oneof']],
      ['!priority:Low columnId:in-progress review.oks>=2', ['priority not', 'columnId is', 'review.oks >=']],
      ['fields.risk:high !assignee review.allOk !review.concerns', ['fields.risk is', 'assignee empty', 'review.allOk yes', 'review.concerns no']],
      ['@drax is:rule:"full approval"', ['@ is', 'is:rule is']],
    ];
    for (const [text, rows] of cases) {
      const c = parseCond(text, fields);
      assert.deepEqual(shape(c), rows, text);
      assert.equal(condText(c, fields), text);
    }
  });
  it('AND and OR: a group of ors inside an and takes brackets, a group of ands inside an or does not', () => {
    const a = parseCond('priority:High (@drax or columnDays>=3)', fields);
    assert.deepEqual(shape(a), ['priority is', { any: ['@ is', 'columnDays >='] }]);
    assert.equal(condText(a, fields), 'priority:High (@drax or columnDays>=3)');
    const b = parseCond('type:issue review.allOk or !assignee', fields);
    assert.equal(b.mode, 'any');
    assert.deepEqual(shape(b), [{ all: ['type is', 'review.allOk yes'] }, 'assignee empty']);
    assert.equal(condText(b, fields), 'type:issue review.allOk or !assignee');
  });
  it('what the rows cannot hold stays text: a group in a group, or a term the builder does not know', () => {
    assert.equal(parseCond('a (b or (c))', fields), null);
    const odd = parseCond('reviewers.nebula:ok', fields);
    assert.deepEqual(shape(odd), ['raw raw']);
    assert.equal(condText(odd, fields), 'reviewers.nebula:ok');
  });
  it('an unfinished row (no value yet) gives no text, so nothing half-made is saved', () => {
    assert.equal(condText({ mode: 'all', items: [{ k: 'priority', op: 'oneof', value: [] }] }, fields), null);
    assert.equal(condText({ mode: 'all', items: [] }, fields), '');
  });
});
