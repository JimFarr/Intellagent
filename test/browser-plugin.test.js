'use strict';
// The browser plugin (plugins/browser, INT-494) on a real board, with test/fake-chrome.js standing in for Chrome.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, until, USER } = require('./helpers');

const FAKE = path.join(__dirname, 'fake-chrome.js');
const up = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } };

test('browser plugin: one browser per agent on its own port, in the size and theme asked, inside the grant; stop and disable close them (INT-494)', async () => {
  const HUMAN = { ...USER, token: 'u-494' };
  const s = await startServer({ manifest: { auth: { userToken: 'u-494' } }, agents: { agents: {
    ann: { enabled: false, grants: [{ power: 'plugin.browser.start', where: { url: 'http://127.0.0.1:743*' } }, 'plugin.browser.stop'] },
  } } });
  const ANN = { agent: 'ann' };
  const run = (action, inputs, as) => s.api('POST', `/api/plugins/browser/actions/${action}/run`, { inputs }, as);
  // a copy, so its data/ (profiles, ports) never lands in the repo's plugins folder
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-browser-'));
  fs.cpSync(path.join(__dirname, '..', 'plugins', 'browser'), src, { recursive: true, filter: (f) => path.basename(f) !== 'data' });
  try {
    const added = await s.ok('POST', '/api/plugins', { path: src }, HUMAN);
    assert.deepStrictEqual(added.problems, []);
    assert.deepStrictEqual(added.asks.needs, { childProcess: true, read: [] });
    await s.ok('POST', '/api/plugins/browser/enable', { hash: added.hash }, HUMAN);
    await s.ok('PUT', '/api/plugins/browser/connection', { values: { chrome: FAKE } }, HUMAN);
    assert.match((await s.ok('POST', '/api/plugins/browser/connection/test', {}, HUMAN)).message, /Chrome launches: FakeChrome/);

    // ann's browser: its own port, its size and theme, a fresh profile in the plugin's data
    const first = await run('start', { url: 'http://127.0.0.1:7431/', width: 375, theme: 'dark' }, ANN);
    assert.strictEqual(first.body.status, 'succeeded', JSON.stringify(first.body));
    const port = first.body.result.port;
    assert.strictEqual(first.body.result.attach, `--cdp-endpoint http://127.0.0.1:${port}`);
    const { args } = await up(port);
    for (const want of ['--headless=new', '--window-size=375,800', '--blink-settings=preferredColorScheme=0', 'http://127.0.0.1:7431/']) assert.ok(args.includes(want), `${want} in ${args}`);
    assert.ok(args.some((a) => a.startsWith('--user-data-dir=') && a.endsWith(path.join('data', 'profiles', 'ann'))));

    // the grant bounds where it opens: never a real board
    assert.strictEqual((await run('start', { url: 'http://127.0.0.1:7420/' }, ANN)).body.code, 'OUT_OF_SCOPE');
    assert.strictEqual((await run('start', { url: 'http://127.0.0.1:7431/' }, { agent: 'cal' })).body.code, 'FORBIDDEN');

    // the same size and theme: a new tab in the same browser
    const again = (await run('start', { url: 'http://127.0.0.1:7432/x', width: 375, theme: 'dark' }, ANN)).body.result;
    assert.deepStrictEqual([again.reused, again.port], [true, port]);
    assert.deepStrictEqual((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).map((t) => t.url), ['http://127.0.0.1:7431/', 'http://127.0.0.1:7432/x']);

    // another theme: a new browser on the same port
    const light = (await run('start', { url: 'http://127.0.0.1:7431/', theme: 'light' }, ANN)).body.result;
    assert.deepStrictEqual([light.reused, light.port], [false, port]);
    assert.ok((await up(port)).args.includes('--blink-settings=preferredColorScheme=1'));

    // the human's browser is another one, on another port
    const mine = (await run('start', { url: 'http://127.0.0.1:7431/' }, HUMAN)).body.result;
    assert.notStrictEqual(mine.port, port);

    // stop closes ann's; disabling the plugin closes the rest
    assert.strictEqual((await run('stop', {}, ANN)).body.result.stopped, true);
    await until(async () => !(await up(port)));
    assert.strictEqual((await run('stop', {}, ANN)).body.result.stopped, false);
    await s.ok('POST', '/api/plugins/browser/disable', {}, HUMAN);
    await until(async () => !(await up(mine.port)));
  } finally { await s.stop(); fs.rmSync(src, { recursive: true, force: true }); }
});
