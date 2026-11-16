# Aimo Agent Approval Demo

**[Try the live demo](https://shoppingpall.up.railway.app/user-agent-demo)**

A B2B wholesale ordering demo that grounds AI procurement in a product catalog, screens orders for risk, and keeps people in control of consequential decisions.

## The problem

Autonomous procurement agents can hallucinate quantities, incur unauthorized spend, or make unsuitable substitutions. In wholesale ordering, these errors can be costly, especially when decisions lack a clear audit trail.

## How we solve it

- **Catalog grounding and deterministic validation:** Agents search a 17,500+ item catalog from the Valio Aimo dataset. Lot sizes, stock, cutoffs, and unit codes are validated before quoting.
- **Human-in-the-loop risk screening and mandates:** Configurable risk scoring, bulk and anomaly thresholds, substitution evaluation, and interactive mandate questions hold risky carts in `PENDING_APPROVAL` while routine orders are automatically approved.
- **Three-tier architecture and tamper-evident audit trail:** The UI, middle-layer orchestration and screening, and core persistence are separated. A SHA-256 hash-chained audit ledger records decisions, and a managed warehouse replenishment agent supports inventory workflows.

Checkout is simulated; no real order is sent to Valio.

## Quickstart: zero-config demo mode

Requires Node.js 22+. No PostgreSQL or API keys are needed.

```sh
npm install
npm run web
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) and select **Demo**.

### Optional: use an API key locally

To use AI-assisted ordering with a provider that supports the OpenAI-compatible
Chat Completions API, add its API key, endpoint, and model to a local `.env`
file. For a new setup, copy the example file:

```sh
cp .env.example .env
```

If you already have a `.env` file, add or update the settings below instead of
overwriting it. Replace these values with the ones for your provider:

```dotenv
LUNA_BASE_URL=https://your-provider.example/v1
LUNA_API_KEY=your_api_key
LUNA_MODELS=your-model-name
```

`LUNA_BASE_URL` is the provider's OpenAI-compatible API base URL, and
`LUNA_MODELS` lists that provider's supported model names in priority order.
For Gemini, the compatible base URL is
`https://generativelanguage.googleapis.com/v1beta/openai/`. Start or restart
`npm run web` after editing the file.
Without a key, Demo can still process direct product and quantity requests using
its local parser. Keep `.env` private; it is ignored by Git.

The portal's **Real** data source requires `REAL_DATABASE_URL` and a seeded
catalog snapshot. See the offline catalog instructions below and the
[technical reference](TECHNICAL.md#demo-and-real-data-selector).

## Documentation

- [Technical reference](TECHNICAL.md) — architecture, API contract, CLI, database setup, and operational details.
- [Reliability audit and failure modes](FMEA.md) — failure-mode analysis, recovery procedures, and regression results.

### Offline Valio catalog

Price and availability for the Real source are read from PostgreSQL, with no
runtime Valio API calls. The checked-in `data/valio-catalog.json` contains
**synthetic demo prices and stock**, not Valio prices or actual availability.
The deterministic `npm run generate:catalog` recreates it from local product
names, package sizes and stable product IDs. These illustrative amounts are not
supplier quotes or tax calculations. Deleted products are unavailable. The
fixed 2020 baseline makes generation reproducible and avoids expiring demo
cutoffs; it is not a capture timestamp.

Run `npm run seed` to load products and the snapshot transactionally. Repeating
it replaces the same snapshot without replenishing inventory. For the portal's
Real database, run `DATABASE_URL="$REAL_DATABASE_URL" npm run seed`; startup
also imports the snapshot when the product catalog is already populated. A
missing snapshot leaves price and availability unavailable until it is
regenerated and imported. The stored `source` and API `snapshotSource` identify
this data as `synthetic`.

The API response's `snapshotDate` identifies the snapshot baseline; the requested
date is a compatibility field and does not establish real availability.
`VALIO_MOCK=true` enables simulated local checkout
and caps snapshot quantities by remaining local inventory. Demo remains a
separate in-memory simulation.
