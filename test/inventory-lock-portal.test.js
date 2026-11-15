import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(name, env) {
  const child = spawn(process.execPath, [`src/web-demo/${name}.js`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`${name} startup timed out: ${output}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(name === 'middle' ? 'Middle :' : 'Portal http://')) { clearTimeout(timeout); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`${name} exited ${code}: ${output}`)); });
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

test('inventory page survives legacy stale locks and preserves simulated activity on restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'inventory-lock-portal-'));
  const stateFile = join(dir, 'inventory.json');
  await mkdir(`${stateFile}.lock`);
  await mkdir(`${stateFile}.lock.recovery`);
  // This represents a lock created on an earlier container, with a different hostname.
  const owner = JSON.stringify({ host: 'previous-container', pid: 1, token: 'old-token' });
  await writeFile(`${stateFile}.lock/owner.json`, owner);
  const requests = [];
  const core = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || !req.url.startsWith('/internal/inventory-simulation-catalog?')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Unexpected supplier operation' }));
      return;
    }
    res.end(JSON.stringify({ products: [{ id: 'apple', name: 'Database apples', sales_unit: 'ST', base_unit: 'ST',
      allowed_lot_size: 1, quantity: 20, units: [{ unitId: 'ST', sizeInBaseUnits: 1 }], substitutions: [] }] }));
  });
  const corePort = await listen(core);
  const [middlePort, frontendPort] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env, BACKEND_PORT: String(corePort), MIDDLE_LAYER_PORT: String(middlePort),
    PORT: String(frontendPort), HOST: '127.0.0.1', REAL_INVENTORY_STATE_FILE: stateFile,
    MANAGED_STATE_FILE: join(dir, 'demo.json') };
  let middle, frontend;
  t.after(async () => {
    if (frontend) await stop(frontend);
    if (middle) await stop(middle);
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  middle = await start('middle', env);
  frontend = await start('frontend', env);
  const base = `http://127.0.0.1:${frontendPort}`;
  const headers = { 'Content-Type': 'application/json', 'X-Data-Source': 'real' };
  const page = await fetch(`${base}/agent-managed-inventory`);
  assert.equal(page.status, 200);
  async function getState() {
    const res = await fetch(`${base}/portal/agent-managed-inventory?user_id=buyer`, { headers });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }
  async function command(action) {
    const res = await fetch(`${base}/portal/agent-managed-inventory`, { method: 'POST', headers,
      body: JSON.stringify({ user_id: 'buyer', ...action }) });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }
  const initial = await getState();
  assert.equal(initial.inventory[0].on_hand, 20);
  await command({ action: 'simulation', running: true, scenario: 'full' });
  const changed = await command({ action: 'snapshot', id: 'apple', on_hand: 2 });
  assert.equal(changed.inventory[0].on_hand, 2);
  assert.equal(changed.orders.length, 1);
  assert.ok(changed.telemetry.some(entry => entry.category === 'ORDER'));
  await command({ action: 'simulation', running: false });
  await stop(frontend); frontend = null;
  await stop(middle); middle = null;
  middle = await start('middle', env);
  frontend = await start('frontend', env);
  const restored = await getState();
  assert.equal(restored.inventory[0].on_hand, 2);
  assert.equal(restored.orders.length, 1);
  assert.ok(restored.telemetry.some(entry => entry.category === 'ORDER'));
  assert.equal(await readFile(`${stateFile}.lock/owner.json`, 'utf8'), owner);
  assert.ok(requests.every(req => req.method === 'GET' && req.url.startsWith('/internal/inventory-simulation-catalog?')));
});
