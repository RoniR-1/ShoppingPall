import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
export const sourceContext=new AsyncLocalStorage();
export const databaseUrls={real:process.env.REAL_DATABASE_URL};
const pools=new Map();
export function sourceName(){return sourceContext.getStore()||'demo';}
export function sourcePool(){const source=sourceName();if(source==='demo')throw Error('Demo uses the in-memory store, not PostgreSQL');if(!databaseUrls[source])throw Error(`Configure ${source==='real'?'REAL_DATABASE_URL':'DEMO_DATABASE_URL'} first`);if(!pools.has(source))pools.set(source,new pg.Pool({connectionString:databaseUrls[source]}));return pools.get(source);}
export const pool={query:(...args)=>sourcePool().query(...args)};
export async function transaction(fn){const db=await sourcePool().connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
