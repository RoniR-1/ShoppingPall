import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

// Linux flock locks the shared open file description, so it survives the helper
// process and remains held until the parent closes its descriptor or exits.
export async function acquireStateLock(lock, {waitMs = 1000} = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('Invalid lock wait time');
  // This stable inode is separate from legacy directory locks. Never remove it
  // while any process may be using it, as that would split the lock domain.
  const handle = await open(`${lock}.flock`, 'a', 0o600);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--timeout', String(waitMs / 1000), '--conflict-exit-code', '75', '3'], {
        stdio:['ignore','ignore','pipe',handle.fd], windowsHide:true
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 2048); });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal, stderr}));
    });
    if (result.code === 75) throw Object.assign(Error('Managed state is locked by another process. Retry shortly.'), {code:'MANAGED_STATE_LOCKED'});
    if (result.code !== 0) throw Error(`State lock service failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  } catch (error) {
    await handle.close();
    if (!error.code || error.code !== 'MANAGED_STATE_LOCKED') error.code = 'MANAGED_LOCK_UNAVAILABLE';
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) { released = true; await handle.close(); }
  };
}
