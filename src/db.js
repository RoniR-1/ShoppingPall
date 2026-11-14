import pg from 'pg';
// PostgreSQL DATE has no time zone; preserve it as YYYY-MM-DD in API responses.
pg.types.setTypeParser(1082, value => value);
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('DATABASE_URL is empty or missing. Set it in .env (see .env.example), then start PostgreSQL with docker compose up -d --wait db before running npm run seed or npm start.');
}
export const pool = new pg.Pool({ connectionString });
export async function transaction(fn) {
  const client = await pool.connect();
  let rollbackError;
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) {
    try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
    throw error;
  }
  finally { client.release(rollbackError); }
}
