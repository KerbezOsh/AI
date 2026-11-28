'use strict';

const { spawn } = require('child_process');
const assert = require('assert');
const test = require('node:test');

test('server serves shell and search/export endpoints', async (t) => {
  const port = 7445 + Math.floor(Math.random() * 100);
  const proc = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => proc.kill());
  let ok = false;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const home = await fetch(`http://127.0.0.1:${port}/`);
      const ht = await home.text();
      const search = await (await fetch(`http://127.0.0.1:${port}/api/search?q=photonn`)).json();
      const exp = await (await fetch(`http://127.0.0.1:${port}/api/chats/export`)).json();
      assert.equal(home.ok, true);
      assert.ok(ht.includes('style.css?v=36'));
      assert.ok(ht.includes('app.js?v=36'));
      assert.ok(Array.isArray(search.results));
      assert.ok(Array.isArray(exp.chats));
      ok = true;
      break;
    } catch (e) {}
  }
  assert.equal(ok, true, 'server did not start in time');
});
