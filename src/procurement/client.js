import { readFileSync } from 'node:fs';
import { z } from 'zod';
const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url)));
export function schema(s) {
  if (s.$ref) return schema(spec.components.schemas[s.$ref.split('/').pop()]);
  if (s.anyOf) return z.union(s.anyOf.map(schema));
  if (s.type === 'null') return z.null();
  if (s.type === 'object') return z.object(Object.fromEntries(Object.entries(s.properties || {}).map(([k,v]) => [k, (s.required || []).includes(k) ? schema(v) : schema(v).optional()])));
  if (s.type === 'array') return z.array(schema(s.items)).min(s.minItems || 0).max(s.maxItems || Infinity);
  if (s.type === 'number') return z.number().finite();
  if (s.type === 'integer') return z.number().int();
  if (s.type === 'boolean') return z.boolean();
  if (s.type === 'string') return s.format === 'date' ? z.iso.date() : z.string();
  return z.unknown();
}
export function validateValioResponse(endpoint, value) {
  return schema(spec.paths[`/api/${endpoint}`].post.responses['200'].content['application/json'].schema).parse(value);
}
export class ProcurementError extends Error {
  constructor(status, code, message, cause) { super(message, { cause }); this.status = status; this.code = code; }
}
export class ProcurementClient {
  constructor({ baseUrl = process.env.VALIO_BASE_URL, apiKey = process.env.VALIO_API_KEY, fetchImpl = fetch, snapshotClient } = {}) {
    Object.assign(this, { baseUrl, apiKey, fetchImpl, snapshotClient });
  }
  async request(path, method, body) {
    if (!this.baseUrl || !this.apiKey) throw Error('VALIO_BASE_URL and VALIO_API_KEY required for supplier downloads');
    if (method !== 'GET') throw Error('Supplier POST requests are available only to the offline export');
    const op = spec.paths[path]?.[method.toLowerCase()];
    if (!op) throw Error('Unsupported API operation');
    if (body) body = schema(op.requestBody.content['application/json'].schema).parse(body);
    let url = new URL(path, this.baseUrl);
    const origin = url.origin;
    const signal = AbortSignal.timeout(15000);
    try {
      for (let i = 0; i <= 5; i++) {
        const response = await this.fetchImpl(url, { method, headers: { ...(url.origin === origin ? { 'X-API-Key': this.apiKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal });
        if ([301,302,303,307,308].includes(response.status) && method === 'GET') {
          const location = response.headers.get('location');
          if (!location) throw new ProcurementError(502, 'VALIO_BAD_REDIRECT', 'Valio redirect is missing a location');
          url = new URL(location, url);
          if (url.protocol !== 'https:') throw new ProcurementError(502, 'VALIO_BAD_REDIRECT', 'Valio redirect must use HTTPS');
          continue;
        }
        if (!response.ok) throw new ProcurementError(response.status === 429 ? 429 : 502, response.status === 429 ? 'VALIO_RATE_LIMITED' : 'VALIO_HTTP_ERROR', `Valio HTTP ${response.status}; request was not retried`);
        if (method === 'GET') return await response.text();
        let result;
        try { result = validateValioResponse(path.split('/').pop(), await response.json()); }
        catch (error) {
          if (signal.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
          throw new ProcurementError(502, 'VALIO_INVALID_RESPONSE', 'Invalid Valio response JSON or schema', error);
        }
        if ((path === '/api/price' && (result.customerId !== body.customer || result.pricingDate !== body.requestedDate)) ||
            (path === '/api/availability' && result.requestedDate !== body.requestedDate)) throw new ProcurementError(502, 'VALIO_INVALID_RESPONSE', 'Valio response does not match request');
        if (result.products.length !== body.products.length || new Set(result.products.map(p => p.productId)).size !== body.products.length || result.products.some(p => !body.products.includes(p.productId))) throw new ProcurementError(502, 'VALIO_INVALID_RESPONSE', 'Incomplete Valio response');
        return result;
      }
      throw new ProcurementError(502, 'VALIO_BAD_REDIRECT', 'Too many Valio redirects');
    } catch (error) {
      if (error instanceof ProcurementError) throw error;
      const timeout = signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new ProcurementError(502, timeout ? 'VALIO_TIMEOUT' : 'VALIO_UNAVAILABLE', timeout ? 'Valio request timed out after 15 seconds' : 'Valio unavailable', error);
    }
  }
  async availability(body) { body = schema(spec.paths['/api/availability'].post.requestBody.content['application/json'].schema).parse(body); const { ValioClient } = await import('../valio.js'); return (this.snapshotClient ?? new ValioClient()).availability(body); }
  async price(body) { body = schema(spec.paths['/api/price'].post.requestBody.content['application/json'].schema).parse(body); const { ValioClient } = await import('../valio.js'); return (this.snapshotClient ?? new ValioClient()).price(body); }
}
