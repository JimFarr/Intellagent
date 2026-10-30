// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// The rule builder's rows for the expression language (public/js/exprrows.js): text → rows → the same text.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const RULES = require('../lib/rules');

const columns = [{ id: 'in-progress', name: 'In Progress' }];
const schema = RULES.schemaFor('comment', null, columns, [{ key: 'risk', label: 'Risk', type: 'enum', options: ['low', 'high'] }]);
const load = () => import('../public/js/exprrows.js');
const shape = (c) => c.items.map((i) => (i.group ? { [i.mode]: i.rows.map((r) => `${r.k} ${r.op}`) } : `${i.k} ${i.op}`));

describe('rules: the expression builder rows', () => {
  it('reads each kind of term into a row and writes the same text back', async () => {
    const { parseRows, treeText, fieldsOf } = await load();
    const fields = fieldsOf(schema);
    const cases = [
      ['T.priority in ["High", "Critical"]', ['T.priority oneof']],
      ['T.priority != "Low" && T.review.oks >= 2', ['T.priority not', 'T.review.oks >=']],
      ['T.fields.risk == "high" && T.review.allOk && !T.archived', ['T.fields.risk is', 'T.review.allOk yes', 'T.archived no']],
      ['C.text.contains("?") && !T.assignee.isEmpty()', ['C.text has', 'T.assignee set']],
      ['!(T.type in ["spike"])', ['T.type noneof']],
    ];
    for (const [text, rows] of cases) {
      const c = parseRows(text, schema);
      assert.deepEqual(shape(c), rows, text);
      assert.equal(treeText(c, fields), text);
    }
  });
  it('a group of ors inside an and takes brackets, a group of ands inside an or does not', async () => {
    const { parseRows, treeText, fieldsOf } = await load();
    const fields = fieldsOf(schema);
    const a = parseRows('T.priority == "High" && (T.assignee == "drax" || T.columnDays >= 3)', schema);
    assert.deepEqual(shape(a), ['T.priority is', { any: ['T.assignee is', 'T.columnDays >='] }]);
    assert.equal(treeText(a, fields), 'T.priority == "High" && (T.assignee == "drax" || T.columnDays >= 3)');
    const b = parseRows('T.type == "issue" && T.review.allOk || T.assignee.isEmpty()', schema);
    assert.equal(b.mode, 'any');
    assert.deepEqual(shape(b), [{ all: ['T.type is', 'T.review.allOk yes'] }, 'T.assignee empty']);
  });
  it('what the rows cannot hold stays text, and an unfinished row writes nothing', async () => {
    const { parseRows, treeText, fieldsOf } = await load();
    assert.equal(parseRows('T.title.matches("^fix")', schema), null);
    assert.equal(parseRows('T.priority ==', schema), null);
    assert.equal(treeText({ mode: 'all', items: [{ k: 'T.priority', op: 'oneof', value: [] }] }, fieldsOf(schema)), null);
    assert.equal(treeText({ mode: 'all', items: [] }, fieldsOf(schema)), '');
  });
  it('renaming a part rewrites its name only, never a word after a dot or inside a quote', async () => {
    const { renameIn } = await load();
    assert.equal(renameIn('T.title.contains("T") && T.fields.T == 1', 'T', 'ticket'), 'ticket.title.contains("T") && ticket.fields.T == 1');
  });
});
