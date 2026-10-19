'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
// The one way to read and write a JSON file. Windows editors and PowerShell put a byte-order mark at the
// start of a file, which JSON.parse rejects: every reader goes through here so none forgets to strip it.
const fs = require('fs');
const path = require('path');

const BOM_CODE = 0xfeff; // by number: the bare character is invisible and easy to delete by accident

// Parse JSON text that may start with a byte-order mark.
const parse = (text) => {
  const s = String(text);
  return JSON.parse(s.charCodeAt(0) === BOM_CODE ? s.slice(1) : s);
};

// Read a JSON file. A missing file gives `fallback` when one is passed (and throws ENOENT otherwise); a file
// that exists but is not valid JSON always throws, so a broken file is never mistaken for a missing one.
function read(file, ...fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (fallback.length && e.code === 'ENOENT') return fallback[0];
    throw e;
  }
  return parse(text);
}

// Like read, but any failure (missing, unreadable, broken) gives `fallback`: for files that are only a cache
// or a hint, where carrying on with the default beats stopping.
function readOr(file, fallback) {
  try { return read(file); } catch { return fallback; }
}

// Swap a temp file into place. On Windows an antivirus or indexer can hold the target for a moment and the
// rename fails with EPERM / EBUSY / EACCES: try again a few times, as the board's own writes do. An uncaught
// failure here once took the whole board down from a sweep (agents.state.json).
function renameRetry(tmp, file, tries = 7) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(tmp, file); }
    catch (e) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

// Write through a temp file and a rename, so a reader never sees half a file.
function writeAtomic(file, value, { mode } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  renameRetry(tmp, file);
}

module.exports = { parse, read, readOr, writeAtomic, renameRetry };
