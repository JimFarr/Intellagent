'use strict';
// Ties standing-agent runs to the board's life outside Windows (INT-262). The board starts this detached, in its
// own process group, and writes "+<pid>" when a run starts (a run leads its own process group) and "-<pid>"
// when it exits. When stdin closes the board is gone, crashed or stopped: every group still listed gets SIGTERM,
// then SIGKILL after a grace period, and this exits.
const GRACE_MS = 2000;
const groups = new Set();
let buf = '';
const signal = (sig) => { for (const g of groups) try { process.kill(-g, sig); } catch { groups.delete(g); } };

process.on('SIGHUP', () => {}); // a closing terminal is not the board dying
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = /^([+-])(\d+)$/.exec(buf.slice(0, i).trim());
    buf = buf.slice(i + 1);
    if (m) groups[m[1] === '+' ? 'add' : 'delete'](Number(m[2]));
  }
});
process.stdin.on('end', () => {
  if (!groups.size) process.exit(0);
  signal('SIGTERM');
  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, GRACE_MS);
});
process.stdin.on('error', () => {});
