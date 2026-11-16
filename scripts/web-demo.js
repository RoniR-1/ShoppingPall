import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';

if (process.env.REAL_DATABASE_URL?.trim()) {
  const seed = spawnSync(process.execPath, ['scripts/seed.js', '--if-empty'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: process.env.REAL_DATABASE_URL } });
  if (seed.error || seed.status !== 0) {
    console.error('Database initialization failed:', seed.error || seed.status);
    process.exit(1);
  }
}

const children = ['core', 'middle', 'frontend'].map(name =>
  spawn(process.execPath, [`src/web-demo/${name}.js`], { stdio: 'inherit', env: process.env })
);
let shuttingDown = false;
function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal, 0));
for (const child of children) {
  child.on('error', error => {
    console.error('Unable to start web service:', error);
    shutdown('SIGTERM', 1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`Web service exited unexpectedly (${signal || code})`);
      shutdown('SIGTERM', 1);
    }
  });
}
