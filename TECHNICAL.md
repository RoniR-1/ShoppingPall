[Back to the overview and quickstart](README.md)

# Aimo agent approval demo: engineering reference

The reliability audit, failure-mode table, recovery procedures, and regression results are in [FMEA.md](FMEA.md).

## Contents

- [Architecture and entry points](#architecture-and-entry-points)
- [Setup and configuration](#setup-and-configuration)
- [Portal workflows](#portal-workflows)
- [Data, inventory, and persistence](#data-inventory-and-persistence)
- [API contracts and order lifecycle](#api-contracts-and-order-lifecycle)
- [Legacy CLI and recipe agent](#legacy-cli-and-recipe-agent)
- [Standalone procurement workflow](#standalone-procurement-workflow)
- [Security and deployment limitations](#security-and-deployment-limitations)
- [Verification](#verification)

## Architecture and entry points

### Three-tier portal

The portal is served on FRONTEND_PORT (3001), proxies only to MIDDLE_LAYER_PORT
(4002), and never calls the core. The middle process owns parsing, allocation,
scoring and review orchestration and has no database imports. The core on
BACKEND_PORT (4003) owns PostgreSQL, authenticated Valio-compatible paths,
private persistence endpoints and transactional inventory checkout. Private
`/internal/*` endpoints are extensions outside the unchanged OpenAPI contract.
The legacy monolith/CLI remains available separately via `npm start`.

### Legacy monolith and CLI

Node 22+ / Express monolith, PostgreSQL catalog and approval queue, and a Node CLI using the Luna OpenAI-compatible endpoint. Checkout is simulated locally: no real order is sent to Valio because the supplied OpenAPI contract has no checkout endpoint.

Source layout: `src/app.js` routes/search/quotes, `src/orders.js` checkout/state transitions, `src/valio.js` upstream adapter, `src/agent.js` local model adapter, `src/cli.js` agent and human interface, `scripts/seed.js` import.

### Additional core API

`node --env-file=.env src/core-server.js` starts an additional contract-shaped
core API on loopback port 3001, requiring `CORE_API_KEY`. It serves all six
OpenAPI paths without modifying the source contract. The existing application
remains a monolith; this entry point alone does not establish strict service
separation or move database ownership out of the orchestration process.

## Setup and configuration

### Demo and real-data selector

Run `npm run web` and choose Demo: no PostgreSQL, database URL, API key, or seed
command is needed for direct-text demo orders. Seven mock products, stock,
substitutions and approval records live in process memory. Prices are synthetic;
carbon/reliability are unknown rather than invented. Stock reset preserves orders
until the core process restarts; restarting restores stock and clears demo orders.
Agent mode separately requires the configured model credentials.

Real requires `REAL_DATABASE_URL` with the seeded catalog and static snapshot.
The checked-in snapshot contains synthetic demo prices and availability, not
supplier prices or actual stock. `snapshotSource` identifies its provenance.
Prices and availability come from PostgreSQL. `VALIO_MOCK=true` enables simulated
local checkout and caps captured availability by remaining local inventory;
otherwise checkout remains preview-only. The selector validates the real
connection before switching and retains Demo on failure. Demo resets cannot touch
PostgreSQL. `DEMO_DATABASE_URL` is no longer used.

### Environment and model configuration

For a new setup, copy `.env.example` to `.env`; for an existing setup, merge its settings into your `.env` and preserve your credentials. Set `LUNA_BASE_URL` and `LUNA_API_KEY` for your provider. `LUNA_MODELS` lists models in priority order; it takes precedence over the legacy single-model `LUNA_MODEL`. If neither is set, the four models in the example are used. `LUNA_TIMEOUT_MS` sets the per-attempt timeout (default 10000 ms), and `LUNA_COOLDOWN_MS` sets how long a failed model is skipped before a later request probes it again (default 60000 ms). The CLI and portal use the same Luna configuration.

For a Google Gemini API key, the OpenAI-compatible base URL is `https://generativelanguage.googleapis.com/v1beta/openai/`; the AI Studio API keys page is not an API endpoint. Use a key issued for the configured provider.

### PostgreSQL database

The workspace used during implementation has an ignored `.env` pointing to a temporary PostgreSQL instance at `127.0.0.1:55432`, database `aimo`, role `roni`. For a durable installation use the Compose volume and set `DATABASE_URL=postgresql://aimo:aimo@127.0.0.1:5432/aimo` in `.env`. Source datasets are challenge-only, as stated in the supplied schema.

### Database migrations

Existing databases must apply the additive audit migration before starting the updated core or portal. With `DATABASE_URL` configured, run:

```sh
node --env-file-if-exists=.env --input-type=module -e 'import {pool} from "./src/db.js"; import {readFile} from "node:fs/promises"; try { await pool.query(await readFile("sql/audit-migration.sql","utf8")); } finally { await pool.end(); }'
```

The portal's real-data source can use a different database. Apply the migration to `REAL_DATABASE_URL` as well, before starting that source:

```sh
node --env-file-if-exists=.env --input-type=module -e 'import pg from "pg"; import {readFile} from "node:fs/promises"; const pool = new pg.Pool({connectionString: process.env.REAL_DATABASE_URL}); try { if (!process.env.REAL_DATABASE_URL) throw Error("REAL_DATABASE_URL is required"); await pool.query(await readFile("sql/audit-migration.sql", "utf8")); } finally { await pool.end(); }'
```

### PostgreSQL-backed portal

Run `npm install`, configure `.env` using the settings above, then `npm run seed`
and `npm run web`. Open http://127.0.0.1:3001. Keep `VALIO_MOCK=true` for
local simulated checkout. The existing `.env` is preserved, including credentials.

### Offline catalog snapshot

The committed snapshot can be recreated without a network using
`npm run generate:catalog`; run `npm run seed` to import it. Generated amounts
are illustrative and use a fixed baseline date, not a supplier capture date.
For the portal database use `DATABASE_URL="$REAL_DATABASE_URL" npm run seed`.
See the README offline catalog section for date, customer, validity and recovery
limitations. Runtime reads the snapshot from PostgreSQL and never calls the
supplier's price or availability endpoints. The in-memory Demo is independent.

### Legacy monolith startup

```sh
npm ci
docker compose up -d db
npm run seed
npm start
```

## Portal workflows

### Orders and review

Use the setup panel to seed/reset inventory (normal or low stock), or change
only the suspicion threshold. Stock reset preserves order history. Normal and
suspicious presets use product 460000; low stock limits it to 0.5 sales units.
The substitution preset deliberately requests an absent potato salad description.
Suggestions always derive from the original request. Selecting a suggestion
creates a new reviewed proposal; approve that proposal to purchase. Shortfalls
require explicit acceptance of available quantities or rejection.

Direct text supports `2 potato salad; 1 milk` (sales units). Recipe prompts use
Agent mode with an OpenAI-compatible LUNA_BASE_URL, LUNA_API_KEY and provider's
actual LUNA_MODEL identifier. No provider credentials/model endpoint were
supplied, so real Luna inference is not verified. Unknown unit conversions and
recipe portions must be reviewed by the buyer. Live Valio checkout is unavailable
in the supplied API and therefore fails closed; mock checkout debits local stock.

### Managed inventory agent (local simulated MVP)

Open `/managed-agent` on the portal after `npm run web`. Connect the Demo
warehouse, enter a product and minimum/target/on-hand quantities, review the
preview, and enable monitoring. The middle process checks every 30 seconds.
Chat supports `keep at least 10 milk` and fills a proposed rule for explicit
review/save. Customer warehouse quantities are independent of supplier stock.

Managed orders call the same `plan` function, `route` screening, core save and
approval commands used by custom portal requests. Structured trigger data,
source evidence, provenance and purpose are attached before screening. Activity
also records resulting items and risk constraints. The dedicated page supports
approval/rejection of complete proposals; substitutions use the existing portal.

## Data, inventory, and persistence

### Catalog and money

The actual supplied filenames are:

- `product_data.json`: 17,546 products; primary key is string `id`.
- `valio_aimo_junction26_product_data_schema.json`: source schema; quantities must be multiples of `allowedLotSize` in `salesUnit`.
- `valio_aimo_junction26_carbon_footprint.csv`: join `productId`, value `AVG kg CO2-eq/kg`; 11,033 catalog matches.
- `valio_aimo_junction26_delivery_reliability.csv`: join `productId`, value `deliveryReliability` (0–1); 4,425 matches.

`sql/schema.sql` defines catalog, selections, quotes, orders, buyer risk policies, and audit events. Seed uses one transaction with a database lock, batches upserts by product ID, and retains raw JSON for package/unit information. It can be rerun without duplicate products or affecting orders. Missing supplementary data remains null. Static searches use multilingual names and parameterized SQL; a simple substring scan is sufficient for this dataset. The seed updates/inserts supplied products; it does not delete records absent from later input files.

CO2 is **kg CO2-eq per kg of product**, not an order footprint. No total footprint is fabricated without reliable mass conversion. Reliability is a historical ratio, not guaranteed availability. Prices shown are per sales unit including tax. Line totals are rounded to cents and summed as integers. Blocked products, missing prices, insufficient quantities, passed cutoffs, wrong units, and delivery later than requested cannot be ordered.

### PostgreSQL inventory

Mock availability now reads persistent PostgreSQL inventory (initially 1,000
sales units per product). A database trigger debits stock atomically on every
transition to APPROVED, including mandate approvals; insufficient stock rolls
back the transaction. Pending/rejected orders consume nothing. Reseeding does
not replenish inventory. Live supplier checkout is still unsupported by the
supplied contract.

### Managed-agent state and locking

State is persisted atomically in `.local/managed-agent.json` (override with
`MANAGED_STATE_FILE`). Only one middle process may own this file. An episode is
persisted before dispatch: uncertain results are held as RECONCILING and are
never automatically retried. An episode remains suppressed until a later check
observes warehouse stock above the minimum. Pausing/disconnecting stops future
checks; it does not cancel already-created orders. Demo orders and supplier
stock remain in the core's process memory and reset when core restarts.

On Linux, state operations use the kernel's `flock` lock on the persistent
`<state-file>.lock.flock` sidecar. The lock is released when its process exits,
including crashes; a live holder is never displaced by age. The Docker image
installs `flock`; local Linux installations require the util-linux package.
Do not remove the sidecar while processes are running. To upgrade from the older
directory lock, stop **all** old app processes sharing the state file before
starting the new version; the two versions cannot coordinate with each other.
Old `.lock` and `.lock.recovery` directories are left untouched and ignored by
the new version. Preserve the state and reconcile uncertain dispatches against
orders after a crash. The real inventory simulation uses the same locking
behavior for its separate state file. Keep one application replica per volume.

## API contracts and order lifecycle

### Legacy monolith API

All endpoints except `/health` require `X-User-Id: CUSTOMER`. See [Security and deployment limitations](#security-and-deployment-limitations) for the identity and access caveats.

| Method and path | Input / behavior |
| --- | --- |
| `GET /catalog/search` | Require `q`, `product_id`, or `category`. Optional `country`, `min_reliability`, `max_carbon`, `limit` (1–50). Returns products and a user-bound selection ID valid for 30 minutes. |
| `POST /api/price` | `{requestedDate, products, selection_ids}`; selected products only. Returns upstream fields plus `mocked`. |
| `POST /api/availability` | Same request shape and selection gate. |
| `POST /quotes` | Same request shape; fetches price and stock once each and persists a quote valid for 15 minutes. |
| `POST /orders` | Header `Idempotency-Key`; body `{quote_id, items:[{productId,quantity,substitutedFrom?}], force_flag?:boolean}`. To request a substitute, quote both original and substitute products and identify the original with `substitutedFrom`; the server validates catalog mappings and scores mapped pack/nutrition shifts, ingredient changes, and unmapped swaps. |
| `GET /orders` | Defaults to pending orders for this user. Supports `status`, `limit` (1–100), and `offset`. |
| `GET /orders/:id` | Retrieve this user's order. |
| `GET /risk-policy` | Read buyer limits, category blocks, and allergen exclusions (returns defaults if unset). |
| `PUT /risk-policy` | Update any supplied buyer policy fields. |
| `POST /orders/:id/approve` | Atomically approve a pending order with an unexpired quote. |
| `POST /orders/:id/reject` | Atomically reject a pending order. |
| `POST /orders/:id/mandate` | Answer `{ "question_id": "...", "answer": "yes" }`; for `no`, first returns the question's fixed alternatives, then accept the selected `alternative`. The order commits when the score falls below 30 or all remaining questions are answered yes. |
| `POST /orders/:id/routine` | Set `{ "routine": true|false }` on an approved order to include it in, or remove it from, routine baselines. |

Example quote request after a catalog search:

```json
{
  "requestedDate": "2026-11-16",
  "products": ["460000"],
  "selection_ids": ["UUID-returned-by-catalog-search"]
}
```

Selections are persisted so an agent must narrow the catalog before a live call. Multiple searches can contribute to one quote. This gate does not prevent a malicious caller from repeatedly searching or querying; there is no production rate limiter in this demo.

`POST /orders` flags `force_flag=true`, header `X-Force-Flag: true`, more than 20 distinct order lines, or more than 20 total sales units. The latter is an intentionally simple demo threshold across heterogeneous units. Otherwise the order is approved immediately. Live queries themselves are not put into the order approval queue.

Automatically approved and human-approved orders are marked routine and feed the last-10-order spend and SKU baselines. `POST /orders/:id/routine` can reclassify an approved order. To exclude or restore an approved order in those baselines, call `POST /orders/:id/baseline-exclusion` with `{ "exclude": true }` or `{ "exclude": false }`. Weekly spend continues to count all approved orders.

```mermaid
stateDiagram-v2
    [*] --> APPROVED: valid normal checkout
    [*] --> PENDING_APPROVAL: demo flag
    PENDING_APPROVAL --> APPROVED: human approval and fresh quote
    PENDING_APPROVAL --> REJECTED: human rejection
```

Pending means no simulated checkout completion. Approved means the monolith accepted the simulated order, not that Valio received or reserved it. Price/availability are quote snapshots rather than reservations. Approval checks quote freshness; expired pending orders can be rejected and a new quote submitted. Approval never reprices silently.

Idempotency is scoped by user and key. Concurrent retries of the same body return one order; different bodies with the same key return 409. CLI prints the exact body/key before submission for recovery. Re-running `agent` creates a new quote, so to retry a failed HTTP submission use that printed body and key directly. Concurrent opposite decisions allow only one transition. Repeating the same decision is idempotent. Order creation and decision events commit in the same transaction.

### Audit ledger and exports

For a portal order, `GET /portal/orders/:id/audit?user_id=<buyer>&perspective=buyer|wholesaler` returns its events and the server's verification result for the complete buyer chain. Add `format=json` or `format=csv` to download an export. The `X-Data-Source` header selects `demo` or `real`, as with other portal endpoints. The wholesaler projection omits buyer policy snapshots. The portal trace reference is the existing order ID; the ledger does not copy reasoning into its events. Demo audit records are process-memory only and are lost on restart; resetting demo stock does not clear them.

`GET /audit` returns the current buyer's hash chain, verification result and JSON events; `?format=csv` downloads CSV, and `?perspective=wholesaler` removes buyer policy details.

See [Security and deployment limitations](#security-and-deployment-limitations) for verification and trust limits.

## Legacy CLI and recipe agent

### Preset orders and approval console

Start the monolith as described in [Legacy monolith startup](#legacy-monolith-startup).

In another terminal:

```sh
npm run cli -- agent --user-id customer-123 --preset normal-order
npm run cli -- agent --user-id customer-123 --preset suspicious-order
npm run cli -- approvals --user-id customer-123
```

The first preset is automatically `APPROVED`; the second is `PENDING_APPROVAL`. Enter `a` or `r` in the approval console, or use `approve ORDER_UUID` / `reject ORDER_UUID` with `--user-id`. `approvals --list-only` prints without prompting. Both presets select products `460000` and `460001` from the local catalog, with at least one sales unit rounded up to a valid lot size. Availability depends on the imported snapshot and may be unavailable.

### Recipe agent

Configure the provider as described in [Environment and model configuration](#environment-and-model-configuration).

Then run:

```sh
npm run cli -- agent --user-id customer-123 --recipe "50 portions of creamy salmon soup" --date 2026-11-16
```

The Luna adapter first asks for ingredient search terms and alternative names/Finnish translations together, searches the static catalog with five candidates per ingredient, then asks the model to select IDs and quantities using the returned package/unit information. If an ingredient has no results, it tries up to three alternatives; an additional model call is needed only if the plan omitted alternatives. Only selected IDs are accepted. Missing search results after these retries, invalid model JSON, invalid quantities, or unavailable stock stop submission. Generated recipe carts always require approval; quantity conversion and ingredient suitability are not guaranteed by the model. Technical unit codes are not fully documented in the source data.

The CLI prints each stage and model-call durations. Requests use the OpenAI-compatible JSON object format, include the expected schema in the prompt, and cap generation at `LUNA_MAX_TOKENS` (default 8192); truncated responses fail explicitly. On rate limits, server errors, transport failures, or timeouts, the adapter tries the next available model; after the cooldown it probes higher-priority models on subsequent requests. Cooldowns are local to each running process; with four unavailable models, one request may take up to four per-attempt timeouts. Invalid configuration, authentication failures, and invalid responses stop the request. If all models are unavailable, the request fails and can be retried later.

Repeated ingredient names are merged and catalog searches are cached within a recipe run. Before requesting a quote, the agent checks quantity limits, selected product IDs, duplicate product IDs, and lot sizes. An invalid cart gets one model correction attempt with validation feedback; a second failure stops with a readable error and no quote or order request. Quantities are never silently clamped or rounded. These checks do not establish recipe suitability or accurate portion-to-package conversion; human review is still required.

### Order screening extension

`OrderScreeningService` in `src/order-screening.js` accepts an injected scorer
with a synchronous `score(order)` method returning a safe integer. The supplied
placeholder always returns zero; it is not a fraud detector. The default
threshold is zero. Scores strictly greater than the threshold go to the existing
`PENDING_APPROVAL` human review queue; other scores pass screening. Existing
demo force and bulk flags can still independently require review. Invalid
scores throw and prevent order creation.

For a custom policy, construct `new OrderScreeningService({ scorer, threshold })`
and pass it as `screening` to `createApp`. Call `setThreshold(integer)` to
change the threshold for future evaluations. Existing orders and idempotent
retries retain their original decision. The scorer receives validated order
items, customer ID, quote ID, total in cents, currency and requested date.

`SUSPICION_THRESHOLD` supplies the screening constructor default; explicit
constructor configuration and `setThreshold` override it.

## Standalone procurement workflow

The repository's ES-module Node stack is also used by the standalone procurement
module in `src/procurement/`. It reads availability from PostgreSQL and uses the
configured catalog download endpoint. Configure `DATABASE_URL`, `VALIO_BASE_URL`
and `VALIO_API_KEY`, then run:

```sh
node --env-file-if-exists=.env src/procurement/cli.js order.json
```

Example order.json:

```json
{
  "customer": "customer-123",
  "requestedDate": "2026-11-16",
  "lines": [
    {
      "id": "milk",
      "quantity": 4,
      "salesUnit": "ST",
      "required": { "countryOfOrigin": "fi" },
      "preferred": { "id": "YOUR_PRODUCT_CODE" }
    }
  ]
}
```

Use actual catalog sales-unit codes and quantities in those units. Constraints
are exact catalog field equality checks (dotted paths supported); an array means
one of the listed values. Put every mandatory requirement in `required`.
Only `preferred` constraints may be relaxed. No package conversions or dietary
inferences are performed. Catalog substitution rules are followed one hop from
the original candidates and must retain all required constraints.

`ProcurementClient` validates live requests and responses against root
`openapi.json`. `Catalog` caches each downloaded dataset once per instance,
including optional reference CSV downloads through `download(kind)`. Reference
metrics are available to callers; they are not automatically joined as product
constraints. Redirected downloads do not forward credentials across origins.

`ProcurementSession.run(lines)` stops at the first intervention. Inspect
`pendingIntervention`; for a no-match case, explicitly approve suggested IDs
with `process(originalLine, { approvedProductIds: [...] })` on the same session.
Repeat calls for completed line IDs are idempotent; changed line contents are
rejected. Partial allocations remain in the basket when a shortfall occurs.
Direct catalog substitutes also require explicit selection from the proposed
IDs. Resolve a pending partial allocation with
`session.resolveShortfall(lineId, 'accept')` or `'reject'`; rejection releases
the session-local stock. These operations do not quote or purchase products.
The host must retain the session while awaiting approval. CLI state is printed
as JSON, is not durable, and is not automatically resumed across processes.

Allocations are internal only: they neither submit nor reserve a Valio order.
Remaining quantities are session-local deductions from availability snapshots.
Terminal stock is unknown and cannot be allocated under the confirmed-stock
policy. Blocked, delayed, unit-mismatched, and expired-cutoff products are
excluded. A cutoff without an explicit timezone is rejected conservatively.
No automatic stock refresh is performed within a session. Selection follows
catalog order and lot-size increments; it does not claim global cost or packing
optimality. Availability snapshots cannot guarantee supplier stock at checkout.

## Security and deployment limitations

### Identity and access

All endpoints except `/health` require `X-User-Id: CUSTOMER`. This is a **trusted localhost demo identity, not authentication**. The default listener is loopback. Before exposing this service, replace the header with authenticated identity and a separate human approver role; currently a caller who knows an ID can impersonate that user or approve their orders. The mock flagging rule is intentionally not a fraud detector or a rate-limit protection system.

The CLI never receives the Valio API key or database credentials through the API. Its HTTP interface needs only `BACKEND_URL` and a customer ID. The model proposes structured data and cannot execute arbitrary tools. API identity comes from `X-User-Id` and is forwarded as Valio's `customer`.

All services bind to localhost; user IDs are demo identity,
not production authentication. The default internal key is for local demos only.

### Managed-agent production limitations

The following limitations apply to the managed inventory agent and portal:

This is not the production architecture described in the design: no real
inventory connector, OAuth/credential vault, authenticated tenant identities,
agent scopes, shared transactional spending reservations, database-backed jobs,
fraud-service outbox, or supplier checkout has been added. Existing portal risk
scoring is a demo and is separate from legacy monolith buyer policies. Do not
expose this localhost demo as a production autonomous purchasing service.
Real-data mode rejects managed-agent endpoints. All purchase outcomes are
explicitly simulated. Warehouse snapshots are manually entered demo inputs.

### Audit verification and trust limits

Verification covers the complete unredacted per-buyer chain; redacted exports cannot independently reconstruct event hashes. A retained independently trusted chain head is needed to detect removal of a suffix. Database triggers reject ordinary update, delete and truncate operations; database owners can bypass triggers and rewrite history. Protect the database and externally anchor or sign chain heads before relying on this ledger for compliance.

The demo's `X-User-Id` is a user-supplied identifier, not authenticated identity, and the perspective option is not an authorization boundary. Replace it with authenticated sessions, separate buyer/supplier access control and independently verifiable signatures before deployment. SHA-256 linking establishes tamper evidence against a trusted head; it does not establish legal non-repudiation, trusted timestamps, supplier acceptance or a signed authorization. Core mock commitments record a local inventory transaction, not transmission to Valio Aimo; live core approval records authorization only. Historical orders are not backfilled, and failed checks outside recorded order attempts may not appear.

## Verification

### PostgreSQL-backed suite

With PostgreSQL running and seeded:

```sh
npm test
```

Tests use real PostgreSQL and a temporary HTTP listener with mocked Valio responses. They cover joined data, selection enforcement, user scoping, quote expiry, lot sizes, payload tampering, idempotent concurrent submission, conflicting decisions, rejection, demo bulk flags, model adapter sequencing, upstream authentication, response failures, and API limits. Tests remove only their own generated data. Live Valio and actual Luna inference require the external services and are not part of the automated suite.

### Portal tests

`npm run test:portal` runs Vitest threshold/routing tests. `npm test` retains the
existing Node suite.

### Focused tests

For adapter checks without live inference or PostgreSQL, run `node --test test/agent.test.js`.

Run `node test/order-screening.test.js` to see the screening test cases, their
inputs, and their results.

Focused checks: `node --test test/managed-agent.test.js`.

Standalone procurement tests:

```sh
node --test test/procurement.test.js
```
