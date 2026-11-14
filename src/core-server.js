// Contract-compatible core API. Checkout is local and remains outside OpenAPI.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ValioClient } from './valio.js';
import { pool } from './db.js';
const app = express();
const client = new ValioClient();
const key = process.env.CORE_API_KEY;
if (!key) throw new Error('CORE_API_KEY is required');
app.use(express.json());
app.use((req,res,next) => req.get('X-API-Key') === key ? next() : res.status(401).json({detail:'Invalid API key'}));
app.get('/api/ping', (_req,res) => res.json({ok:true}));
for (const endpoint of ['price','availability']) app.post(`/api/${endpoint}`, async (req,res) => res.json(await client[endpoint](req.body)));
for (const [route,file] of Object.entries({products:'product_data.json','carbon-footprint':'valio_aimo_junction26_carbon_footprint.csv','delivery-reliability':'valio_aimo_junction26_delivery_reliability.csv'})) {
  app.get(`/api/${route}/download`, (_req,res) => res.sendFile(fileURLToPath(new URL(`../${file}`,import.meta.url))));
}
app.use((error,_req,res,_next) => res.status(error.status || 422).json({detail:error.issues || [{loc:['body'],msg:error.message,type:'value_error'}]}));
const server = app.listen(Number(process.env.CORE_PORT || 3001),'127.0.0.1',() => console.log('Core API listening'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(async () => {await pool.end(); process.exit(0);}));
