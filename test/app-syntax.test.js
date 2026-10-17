'use strict';
// The browser app must parse: one duplicate top-level const or let stops the whole file from loading, and no other test
// runs it. vm.Script compiles the source without running it, so nothing in the page executes here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('browser app', () => {
  it('public/app.js parses as a script (a duplicate top-level const fails here, by name)', () => {
    const file = path.join(__dirname, '..', 'public', 'app.js');
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }), 'public/app.js must parse');
  });
});
