'use strict';
// The top-bar Ask box addresses the board's coordinator, or a choice the human saved. With neither, it must address
// nobody: a silent fallback to the first standing agent made the box name whoever happened to be added first.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// askTo lives inside the browser app; evaluate just that one function from public/app.js.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const askToSrc = /^  const askTo = \(\) => \{\n[\s\S]*?\n  \};$/m.exec(src)[0];
const makeAskTo = (state, ask, askStore) => new Function('state', 'ask', 'askStore', `${askToSrc}; return askTo;`)(state, ask, askStore);

describe('Ask box target', () => {
  it('evaluates askTo()', () => {
    assert.equal(makeAskTo({ boardId: 'main', board: {}, standing: {} }, { to: {} }, { to: {} })(), '');
  });

  it('with no coordinator and no saved choice, names nobody, even with standing agents', () => {
    const state = { boardId: 'main', board: { coordinator: null }, standing: { writer: {}, mantis: {} } };
    assert.equal(makeAskTo(state, { to: {} }, { to: {} })(), '');
  });

  it('a coordinator, or a saved choice, is still the target', () => {
    const state = { boardId: 'main', board: { coordinator: 'mantis' }, standing: { writer: {} } };
    assert.equal(makeAskTo(state, { to: {} }, { to: {} })(), 'mantis');
    const choice = makeAskTo({ ...state, board: { coordinator: null } }, { to: { main: 'rocket' } }, { to: {} });
    assert.equal(choice(), 'rocket');
    const remembered = makeAskTo({ ...state, board: { coordinator: null } }, { to: {} }, { to: { main: 'gamora' } });
    assert.equal(remembered(), 'gamora');
  });
});
