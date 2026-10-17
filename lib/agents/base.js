'use strict';
/* The base context (INT-251): what every agent is taught before its board rules, role and own context. It ships
   as base.md; the human's own copy lives in base-context.md beside agents.json, so an Intellagent update changes
   only the shipped text and never their edits. */
const fs = require('fs');
const path = require('path');

// The parts a review explains itself in. Role briefs, the base and AGENTS.md name these and no others
// (test/agents.test.js checks it), so what agents are taught can't drift from what the board asks for.
const REVIEW_PARTS = ['changed', 'why', 'evidence', 'verify', 'risks'];
const SHIPPED_FILE = path.join(__dirname, 'base.md');
const BASE_MAX = 8000;

const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
const shipped = () => norm(fs.readFileSync(SHIPPED_FILE, 'utf8'));

function createBase(dir) {
  const file = path.join(dir, 'base-context.md');
  const own = () => { try { return norm(fs.readFileSync(file, 'utf8')); } catch { return ''; } };
  return {
    file,
    // { text: what agents get, shipped: the text Intellagent ships, edited: the human has their own copy }
    read() {
      const ship = shipped();
      const mine = own();
      // write refuses more; a copy edited by hand past the cap says where it was cut, as context pages do
      const text = mine.length > BASE_MAX ? `${mine.slice(0, BASE_MAX)}\n…(base context cut at ${BASE_MAX} characters)` : mine || ship;
      return { text, shipped: ship, edited: !!mine && mine !== ship };
    },
    // Save the human's copy. Empty, or the shipped text again, removes it, so later updates reach them. Returns
    // the text agents got before, for the audit trail.
    write(text) {
      const before = this.read().text;
      const t = norm(text);
      if (!t || t === shipped()) fs.rmSync(file, { force: true });
      else {
        if (t.length > BASE_MAX) { const e = new Error(`The base context is at most ${BASE_MAX} characters`); e.status = 400; e.code = 'TOO_LARGE'; throw e; }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${t}\n`);
      }
      return before;
    },
  };
}

module.exports = { REVIEW_PARTS, BASE_MAX, createBase, shipped };
