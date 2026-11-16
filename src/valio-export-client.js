import { productsRequest, HttpError } from './contracts.js';
import { validateValioResponse } from './procurement/client.js';
export class ValioExportClient {
  constructor({ baseUrl = process.env.VALIO_BASE_URL || 'https://junction26.valioaimo.fi', apiKey = process.env.VALIO_API_KEY,
    fetchImpl = fetch } = {}) {
    Object.assign(this, { baseUrl, apiKey, fetchImpl });
  }
  price(request) { return this.call('price', request); }
  availability(request) { return this.call('availability', request); }
  async call(endpoint, input) {
    const request = productsRequest.parse(input);
    if (!this.apiKey) throw new HttpError(503, 'VALIO_API_KEY is required in live mode');
    let response;
    try {
      response = await this.fetchImpl(new URL(`/api/${endpoint}`, this.baseUrl), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify(request), signal: AbortSignal.timeout(15000), redirect: 'error'
      });
    } catch (error) { throw new HttpError(502, `Valio unavailable or request timed out${error.cause?.code ? ` (${error.cause.code})` : ''}`); }
    if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, `Valio returned HTTP ${response.status}; request was not retried`);
    let body;
    try { body = validateValioResponse(endpoint, await response.json()); } catch { throw new HttpError(502, 'Invalid JSON or response schema from Valio'); }
    if ((endpoint === 'price' && (body.customerId !== request.customer || body.pricingDate !== request.requestedDate)) ||
      (endpoint === 'availability' && body.requestedDate !== request.requestedDate)) throw new HttpError(502, 'Valio response does not match request');
    if (!Array.isArray(body.products) || body.products.length !== request.products.length ||
      new Set(body.products.map(p => p.productId)).size !== request.products.length ||
      body.products.some(p => !request.products.includes(p.productId))) throw new HttpError(502, 'Incomplete product response from Valio');
    return body;
  }
}
