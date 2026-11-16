import { spawnSync } from 'node:child_process';
import { createApp } from './app.js';
import { pool } from './db.js';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const seed = spawnSync(process.execPath, ['scripts/seed.js', '--if-empty'], { stdio: 'inherit', env: process.env });
if (seed.error || seed.status !== 0) { await pool.end(); throw seed.error || new Error(`Database initialization failed (${seed.status})`); }
const server = createApp().listen(port,host,() => console.log(`Aimo demo: http://${host}:${port}; Valio ${process.env.VALIO_MOCK === 'true' ? 'MOCK' : 'LIVE'}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(async () => { await pool.end(); process.exit(0); }));
