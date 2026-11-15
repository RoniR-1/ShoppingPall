import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const ownerFile = lock => `${lock}/owner.json`;
const lockedError = () => Object.assign(Error('Managed state is locked by another process or its lock owner cannot be verified. Retry shortly. If the lock remains, stop all app processes, inspect pending dispatches, then remove the lock directory before retrying.'), { code:'MANAGED_STATE_LOCKED' });

async function readOwner(lock) {
  try { return JSON.parse(await readFile(ownerFile(lock), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

// Reclaim only a local PID that the kernel confirms no longer exists. A live or
// reused PID, foreign host, ownerless legacy directory, or EPERM is inconclusive.
function isProvenDead(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function recoverDeadOwner(lock) {
  // The separate gate serializes competing recoveries. It is deliberately not
  // stolen based on age; an abandoned gate needs the same manual inspection.
  const gate = `${lock}.recovery`;
  try { await mkdir(gate); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    const owner = await readOwner(lock);
    if (!isProvenDead(owner)) return false;
    await unlink(ownerFile(lock));
    await rmdir(lock);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  } finally { await rmdir(gate); }
}

export async function acquireStateLock(lock, { waitMs = 1000, retryMs = 40 } = {}) {
  const deadline = Date.now() + waitMs;
  const owner = { pid:process.pid, host:hostname(), token:randomUUID(), acquired_at:new Date().toISOString() };
  for (;;) {
    try {
      await mkdir(lock);
      try { await writeFile(ownerFile(lock), JSON.stringify(owner), { flag:'wx', mode:0o600 }); }
      catch (error) { await rmdir(lock).catch(() => {}); throw error; }
      return async () => {
        const current = await readOwner(lock);
        if (current?.token !== owner.token) return;
        await unlink(ownerFile(lock));
        await rmdir(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await recoverDeadOwner(lock)) continue;
      if (Date.now() >= deadline) throw lockedError();
      await delay(Math.min(retryMs, Math.max(1, deadline-Date.now())));
    }
  }
}
