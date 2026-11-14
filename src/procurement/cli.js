import { readFile } from 'node:fs/promises';
import { ProcurementClient } from './client.js';
import { Catalog } from './catalog.js';
import { ProcurementSession } from './session.js';
try {
  if (!process.argv[2]) throw Error('Usage: node src/procurement/cli.js order.json');
  const order = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const client = new ProcurementClient();
  const session = new ProcurementSession({ ...order, client, catalog: new Catalog(client) });
  console.log(JSON.stringify(await session.run(order.lines), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
