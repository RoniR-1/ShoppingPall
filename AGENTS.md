# Aimo Agent Gateway — Junction 2026, Valio Aimo challenge

## Goal
An interface that lets an external purchasing agent search Valio Aimo's catalog, get price and
availability, receive a quote, and place an order — autonomously within a mandate, otherwise via
human approval. Example request: "1,000 litres of lactose-free milk by Monday."
Judging: end-to-end demo 30%, matching the buyer's request 20%, guardrails/audit 20%,
exception handling (partial availability, substitution, delivery) 15%, open standards and
documented assumptions 15%.

## Stack
- Python 3.11+, FastAPI, Pydantic, httpx, SQLite, pytest
- MCP server: official `mcp` Python SDK
- approval-ui: React + Vite + TypeScript
- buyer-agent: LLM with tool use; model and key configured via .env

## Structure
data/raw/ (input, never modify) · data/processed/catalog.db (built by pipeline/)
pipeline/build_catalog_db.py — already written and tested, do not rewrite it
gateway/{catalog,aimo_client,quotes,orders,policy,approvals,substitution,audit}
gateway/interfaces/{openapi.yaml,rest,mcp}
buyer-agent/ · approval-ui/ · docs/{architecture.md,assumptions.md,aimo_openapi.json}

## Architecture rules
- All business logic lives in gateway/ service modules. REST and MCP are thin adapters over the
  same service functions; never duplicate logic between them.
- buyer-agent must only talk to the gateway over HTTP or MCP. It must never import from gateway/.
- Only aimo_client/ talks to the Valio Aimo mock API. Everything else depends on an interface,
  so a fake client can be swapped in for tests.
- The mock API contract is docs/aimo_openapi.json (OpenAPI). It is the single source of truth for
  endpoints, parameters and response shapes: never guess an endpoint that isn't in it.
- Base URL from AIMO_BASE_URL; every request under /api sends the header X-API-Key: AIMO_API_KEY.
- Prices and availability come from the mock API; static product data comes from catalog.db.
- Every decision (search, quote, policy verdict, substitution, order, approval) writes an audit
  entry with: timestamp, actor, action, inputs, outcome, and a one-sentence human-readable reason.
- Policies are declarative in gateway/policy/policies.yaml (per-buyer mandate: max order value,
  allowed categories, required claims/excluded allergens, substitution tolerance). The engine
  returns ALLOW | NEEDS_APPROVAL | DENY plus the reason.
- An order always references a quote id; quotes have an expiry.
- Secrets only from .env. Never commit data/raw, data/processed or .env.
- Any assumption about data or business rules goes into docs/assumptions.md.

## Data facts (verified)
- Product ids are strings in the JSON but ints in the CSVs; catalog.db normalises them to strings.
- Lactose-free = classifications row grp='nutritionalClaim', code='FREE_FROM_LACTOSE'.
  Allergens: grp='allergen' (qualifier CONTAINS / MAY_CONTAIN); certification labels:
  grp='packagingMarkedLabel'.
- products.content_per_sales_unit + content_unit ('l' or 'kg') give the amount per orderable unit;
  content_source says whether it came from structured data or name parsing (less reliable).
- Order quantities must be multiples of allowed_lot_size (sales units). Its value of 0.01 is
  suspicious: verify against the mock API.
- Carbon covers ~11k of 17.5k products, delivery reliability ~4.4k: always handle NULL.
- Only 250 explicit substitution pairs exist; ranking needs category + claim/allergen matching too.

## Working rules
- Write pytest tests for each module; run them before finishing a task.
- Keep functions small and typed. Don't add dependencies beyond the stack without saying why.
