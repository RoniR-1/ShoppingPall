import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { recipeCart } from './agent.js';
import { round3 } from './contracts.js';
const help = `Usage:
  npm run cli -- agent --user-id CUSTOMER --preset normal-order
  npm run cli -- agent --user-id CUSTOMER --preset suspicious-order
  npm run cli -- agent --user-id CUSTOMER --recipe "50 portions of creamy salmon soup"
  npm run cli -- approvals --user-id CUSTOMER [--list-only]
  npm run cli -- approve ORDER_UUID --user-id CUSTOMER
  npm run cli -- reject ORDER_UUID --user-id CUSTOMER
Options: --date YYYY-MM-DD (default tomorrow), --force-flag, --idempotency-key KEY
Recipe mode uses local Ollama and is evaluated by the risk-scoring engine (pass --force-flag to force human approval).`;
function showOrder(order) {
  const risk = order.risk_score == null ? '' : `  Risk: ${round3(order.risk_score)}`;
  console.log(`\n${order.id}  ${order.status}  ${order.mocked ? '[MOCK PRICES/STOCK]' : '[LIVE QUOTE]'}${risk}\n${order.flag_reason || 'No demo flag'}\nDelivery: ${String(order.requested_date).slice(0,10)}`);
  console.table(order.items.map(i => ({ product: i.productId, name: i.name, quantity: round3(i.quantity), unit: i.sales_unit,
    price: round3(i.unit_price), lineTotal: round3(i.line_total_cents / 100),
    'CO2 kg/kg': i.carbon_kg_co2_per_kg == null ? 'unknown' : round3(i.carbon_kg_co2_per_kg),
    reliability: i.delivery_reliability == null ? 'unknown' : round3(i.delivery_reliability) })));
  console.log(`Total including tax: ${(Number(order.total_cents) / 100).toFixed(2)} ${order.currency}`);
}
try {
  const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
    'user-id': { type: 'string' }, preset: { type: 'string' }, recipe: { type: 'string' }, date: { type: 'string' },
    'force-flag': { type: 'boolean' }, 'list-only': { type: 'boolean' }, 'idempotency-key': { type: 'string' }, help: { type: 'boolean' }
  } });
  if (flags.help || !positionals.length) { console.log(help); process.exit(0); }
  if (!flags['user-id']) throw new Error('--user-id is required');
  const api = async (path, body, headers = {}) => {
    const response = await fetch(new URL(path, process.env.BACKEND_URL || 'http://127.0.0.1:3000'), {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(40000),
      headers: { 'Content-Type': 'application/json', 'X-User-Id': flags['user-id'], ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${result.error}${result.issues ? ` ${JSON.stringify(result.issues)}` : ''}`);
    return result;
  };
  const command = positionals[0];
  if (command === 'agent') {
    if (Boolean(flags.preset) === Boolean(flags.recipe)) throw new Error('Choose exactly one of --preset or --recipe');
    let cart;
    const requestedDate = flags.date || new Date(Date.now() + 86400000).toISOString().slice(0,10);
    if (flags.preset) {
      if (!['normal-order','suspicious-order'].includes(flags.preset)) throw new Error('Unknown preset');
      cart = { items: [], selection_ids: [] };
      for (const productId of ['460000','460001']) {
        const selection = await api(`/catalog/search?product_id=${productId}`);
        const product = selection.products[0];
        if (!product) throw new Error(`Preset product ${productId} missing; run npm run seed`);
        cart.selection_ids.push(selection.selection_id);
        const lot = Number(product.allowed_lot_size);
        cart.items.push({ productId, quantity: Number((Math.ceil(1 / lot) * lot).toFixed(8)) });
      }
    } else {
      console.log('Planning recipe with local Ollama, then searching the static catalog…');
      cart = await recipeCart(flags.recipe,api,undefined,message => console.log(message),{ requestedDate });
    }
    const quote = await api('/quotes', { requestedDate, products: cart.items.map(i => i.productId), selection_ids: cart.selection_ids });
    const key = flags['idempotency-key'] || randomUUID();
    const payload = { quote_id: quote.id, items: cart.items,
      force_flag: Boolean(flags['force-flag'] || flags.preset === 'suspicious-order') };
    // Print exact submission before sending so a network failure can be retried with the same key/body.
    console.log(`Submission: ${JSON.stringify({ idempotency_key: key, payload })}`);
    const order = await api('/orders',payload,{ 'Idempotency-Key': key });
    showOrder(order);
  } else if (command === 'approvals') {
    const orders = [];
    for (let offset = 0; ; offset += 100) {
      const page = await api(`/orders?status=PENDING_APPROVAL&limit=100&offset=${offset}`);
      orders.push(...page); if (page.length < 100) break;
    }
    if (!orders.length) console.log('No pending orders.');
    const rl = flags['list-only'] ? null : createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const order of orders) {
        showOrder(order);
        if (rl) {
          const choice = (await rl.question('Approve [a], reject [r], or skip [Enter]? ')).trim().toLowerCase();
          if (choice === 'a' || choice === 'r') {
            try { showOrder(await api(`/orders/${order.id}/${choice === 'a' ? 'approve' : 'reject'}`,{})); }
            catch (error) { console.error(error.message); }
          }
        }
      }
    } finally { rl?.close(); }
  } else if (command === 'approve' || command === 'reject') {
    if (!positionals[1]) throw new Error('Order UUID required');
    showOrder(await api(`/orders/${encodeURIComponent(positionals[1])}/${command}`,{}));
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
