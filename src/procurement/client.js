import { readFileSync } from 'node:fs';
import { z } from 'zod';
const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url)));
function schema(s) {
  if (s.$ref) return schema(spec.components.schemas[s.$ref.split('/').pop()]);
  if (s.anyOf) return z.union(s.anyOf.map(schema));
  if (s.type === 'null') return z.null();
  if (s.type === 'object') return z.object(Object.fromEntries(Object.entries(s.properties || {}).map(([k,v]) => [k, (s.required || []).includes(k) ? schema(v) : schema(v).optional()])));
  if (s.type === 'array') return z.array(schema(s.items)).min(s.minItems || 0).max(s.maxItems || Infinity);
  if (s.type === 'number') return z.number();
  if (s.type === 'boolean') return z.boolean();
  if (s.type === 'string') return s.format === 'date' ? z.iso.date() : z.string();
  return z.unknown();
}
export class ProcurementClient {
  constructor({ baseUrl = process.env.VALIO_BASE_URL, apiKey = process.env.VALIO_API_KEY, fetchImpl = fetch } = {}) {
    if (!baseUrl || !apiKey) throw Error('VALIO_BASE_URL and VALIO_API_KEY required');
    Object.assign(this, { baseUrl, apiKey, fetchImpl });
  }
  async request(path, method, body) {
    const op = spec.paths[path]?.[method.toLowerCase()];
    if (!op) throw Error('Unsupported API operation');
    if (body) body = schema(op.requestBody.content['application/json'].schema).parse(body);
    let url = new URL(path, this.baseUrl);
    const origin = url.origin;
    for (let i = 0; i <= 5; i++) {
      const response = await this.fetchImpl(url, { method, headers: { ...(url.origin === origin ? { 'X-API-Key': this.apiKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if ([301,302,303,307,308].includes(response.status) && method === 'GET') {
        const location = response.headers.get('location');
        if (!location) throw Error('Missing redirect location');
        url = new URL(location, url);
        if (url.protocol !== 'https:') throw Error('Unsafe redirect');
        continue;
      }
      if (!response.ok) throw Error('Valio HTTP ' + response.status);
      if (method === 'GET') return response.text();
      const result = schema(op.responses['200'].content['application/json'].schema).parse(await response.json());
      if (result.products.length !== body.products.length || new Set(result.products.map(p => p.productId)).size !== body.products.length || result.products.some(p => !body.products.includes(p.productId))) throw Error('Incomplete response');
      return result;
    }
    throw Error('Too many redirects');
  }
  availability(body) { return this.request('/api/availability', 'POST', body); }
  price(body) { return this.request('/api/price', 'POST', body); }
}
