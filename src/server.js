import { createApp } from './app.js';
import { pool } from './db.js';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
await pool.query('SELECT 1 FROM products LIMIT 1');
const server = createApp().listen(port,host,() => console.log(`Aimo demo: http://${host}:${port}; Valio ${process.env.VALIO_MOCK === 'true' ? 'MOCK' : 'LIVE'}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(async () => { await pool.end(); process.exit(0); }));
