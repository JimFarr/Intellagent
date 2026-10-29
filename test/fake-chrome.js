'use strict';
// A stand-in for Chrome (the browser plugin's tests, INT-494): takes Chrome's flags and answers the DevTools HTTP
// endpoints the plugin uses. /json/version also says which flags it was started with.
const http = require('node:http');
const args = process.argv.slice(2);
const flag = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tabs = [{ type: 'page', url: args.at(-1), title: 'first' }];
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/json/new' && req.method === 'PUT') tabs.push({ type: 'page', url: decodeURIComponent(u.search.slice(1)), title: 'new' });
  const body = u.pathname === '/json/version' ? { Browser: 'FakeChrome/1.0', args } : tabs;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(Number(flag('remote-debugging-port')), '127.0.0.1');
