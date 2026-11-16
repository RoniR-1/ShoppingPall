import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { pool, transaction } from '../src/db.js';
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
function indexCSV(text, column) {
  const result = new Map();
  for (const row of parse(text, { columns: true, bom: true, skip_empty_lines: true })) {
    const value = row[column]?.trim();
    if (!row.productId || value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error(`Invalid CSV row for ${column}`);
    if (result.has(row.productId)) throw new Error(`Duplicate CSV product ${row.productId}`);
    result.set(row.productId, Number(value));
  }
  return result;
}
try {
  const [schema, productsText, carbonText, reliabilityText] = await Promise.all([
    read('sql/schema.sql'), read('product_data.json'), read('valio_aimo_junction26_carbon_footprint.csv'), read('valio_aimo_junction26_delivery_reliability.csv')
  ]);
  const products = JSON.parse(productsText);
  const carbon = indexCSV(carbonText, 'AVG kg CO2-eq/kg');
  const reliability = indexCSV(reliabilityText, 'deliveryReliability');
  const ids = new Set();
  await transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(2026, 1)");
    await db.query(schema);
    if (process.argv.includes('--if-empty')) {
      const existing = await db.query('SELECT 1 FROM products LIMIT 1');
      if (existing.rowCount) { console.log('Catalog already populated; skipping seed'); return; }
    }
    for (let i = 0; i < products.length; i += 200) {
      const rows = products.slice(i, i + 200).map(p => {
        if (typeof p.id !== 'string' || ids.has(p.id)) throw new Error('Missing or duplicate product id');
        ids.add(p.id);
        const names = p.synkkaData.names ?? [];
        const name = names.find(n => n.language === 'en')?.value ?? names.find(n => n.language === 'fi')?.value ?? p.id;
        return { id: p.id, name, search_text: names.map(n => n.value).join(' ').toLowerCase(), category: p.category,
          country_of_origin: p.countryOfOrigin ?? null, sales_unit: p.salesUnit, allowed_lot_size: p.allowedLotSize,
          deleted: p.deleted, carbon_kg_co2_per_kg: carbon.get(p.id) ?? null, delivery_reliability: reliability.get(p.id) ?? null, raw: p };
      });
      await db.query(`INSERT INTO products SELECT * FROM jsonb_populate_recordset(NULL::products, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, search_text=EXCLUDED.search_text, category=EXCLUDED.category,
        country_of_origin=EXCLUDED.country_of_origin, sales_unit=EXCLUDED.sales_unit, allowed_lot_size=EXCLUDED.allowed_lot_size,
        deleted=EXCLUDED.deleted, carbon_kg_co2_per_kg=EXCLUDED.carbon_kg_co2_per_kg,
        delivery_reliability=EXCLUDED.delivery_reliability, raw=EXCLUDED.raw`, [JSON.stringify(rows)]);
    }
    await db.query('INSERT INTO inventory(product_id) SELECT id FROM products ON CONFLICT DO NOTHING');
  });
  console.log(JSON.stringify({ products: ids.size, carbonMatches: [...ids].filter(id => carbon.has(id)).length,
    reliabilityMatches: [...ids].filter(id => reliability.has(id)).length }));
} finally { await pool.end(); }
