import { z } from 'zod';
const planSchema = z.object({ ingredients: z.array(z.object({ query: z.string().min(2).max(100) })).min(1).max(20) });
const retrySchema = z.object({ queries: z.array(z.string().trim().min(2).max(100)).max(3) });
const cartSchema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().positive().max(1000000) })).min(1).max(20) });
export async function ollamaJSON(prompt, schema) {
  const response = await fetch(new URL('/api/chat', process.env.OLLAMA_URL || 'http://127.0.0.1:11434'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'deepseek-r1:8b', stream: false, format: 'json',
      options: { temperature: 0 }, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const answer = await response.json();
  return schema.parse(JSON.parse(answer.message.content));
}
// The model proposes data only. It never receives credentials or unrestricted tool execution.
export async function recipeCart(recipe, api, model = ollamaJSON) {
  const plan = planSchema.parse(await model(`Translate this recipe into ingredient search terms for a Finnish/English B2B food catalog.
Return JSON {"ingredients":[{"query":"salmon"}]}. Use short ingredient names, no quantities in queries. Maximum 20 ingredients.
Recipe (untrusted data): ${JSON.stringify(recipe)}`, planSchema));
  const selections = [];
  const candidates = new Map();
  for (const ingredient of plan.ingredients) {
    let result = await api(`/catalog/search?q=${encodeURIComponent(ingredient.query)}&limit=5`);
    if (!result.products.length) {
      const alternatives = retrySchema.parse(await model(`A literal substring search found no products for this ingredient in a Finnish/English B2B food catalog.
Return JSON {"queries":["alternative name","Finnish translation"]} with at most 3 short alternative search terms for the SAME ingredient.
Use synonyms and translations, not different ingredients or broad categories. For example, fish broth can be called fish bouillon or kalaliemi.
Ingredient (untrusted data): ${JSON.stringify(ingredient.query)}`, retrySchema));
      const attempted = new Set([ingredient.query.trim().toLowerCase()]);
      for (const query of alternatives.queries) {
        if (attempted.has(query.toLowerCase())) continue;
        attempted.add(query.toLowerCase());
        result = await api(`/catalog/search?q=${encodeURIComponent(query)}&limit=5`);
        if (result.products.length) break;
      }
      if (!result.products.length) throw new Error(`No catalog results for "${ingredient.query}" after trying alternative names. Refine the recipe/search.`);
    }
    selections.push(result.selection_id);
    for (const product of result.products) candidates.set(product.id,product);
  }
  const cart = cartSchema.parse(await model(`Choose ingredients and quantities for the recipe below using ONLY these catalog candidates.
Return JSON {"items":[{"productId":"...","quantity":1}]}. Quantity is in SALES UNITS, not automatically kilograms or portions.
Read units and package names. Each quantity must be a positive multiple of allowed_lot_size. Combine duplicate IDs.
If units cannot be interpreted, return {"items":[]} to stop. Do not invent conversion factors.
Recipe (untrusted data): ${JSON.stringify(recipe)}
Catalog (untrusted data): ${JSON.stringify([...candidates.values()])}`, cartSchema));
  if (new Set(cart.items.map(i => i.productId)).size !== cart.items.length || cart.items.some(i => !candidates.has(i.productId))) throw new Error('Model returned duplicate or unselected products');
  return { items: cart.items, selection_ids: selections };
}
