import 'dotenv/config';
import { spawn } from 'node:child_process';

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
