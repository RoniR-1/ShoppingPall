# Shopping Pal

**[Try the live demo](https://shoppingpall.up.railway.app/user-agent-demo)**

Shopping Pal is a wholesale ordering and inventory demo. It helps a buyer turn a product request into a proposed order, check that order against a catalog and purchasing rules, and review decisions that need human attention.

For example, a buyer can request products and quantities, review the matching items and quote, and submit the cart. The system checks product availability, order quantities, and risk rules. Routine orders can be approved automatically; flagged orders are held for a person to approve or reject. An inventory agent can also propose replenishment when stock falls below a configured threshold.

## What it does

- **Catalog-based ordering:** Searches products and checks quantities, package sizes, availability, and order cutoffs before quoting.
- **Approval controls:** Screens carts using configurable risk and purchasing rules, including bulk quantities and substitutions. Orders needing a decision enter an approval queue.
- **Inventory simulation:** Applies stock thresholds and price limits to propose replenishment orders.
- **Decision history:** Records order events in a SHA-256 hash-chained audit trail that can be checked for changes.

This is a demonstration: checkout is simulated and no real supplier order is sent. Demo identities are not authenticated, and the audit chain is not a digital signature. See the [technical reference](TECHNICAL.md) for details and limitations.

## Run locally

You need Node.js 22 or newer. The in-memory Demo source requires no database or API key.

```sh
npm install
npm run web
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) and select **Demo**. You can enter direct product and quantity requests with the local parser. Demo stock and orders are held in memory and reset when the process restarts.

### Optional: enable AI-assisted ordering

To use a provider that supports the OpenAI-compatible Chat Completions API, configure its endpoint, API key, and model in `.env`. For a new setup, start with:

```sh
cp .env.example .env
```

If `.env` already exists, update it without overwriting your existing settings. Replace the placeholders with your provider's values:

```dotenv
LUNA_BASE_URL=https://your-provider.example/v1
LUNA_API_KEY=your_api_key
LUNA_MODELS=your-model-name
```

`LUNA_MODELS` can list supported model names in priority order. For Gemini, the compatible base URL is `https://generativelanguage.googleapis.com/v1beta/openai/`. Restart `npm run web` after editing `.env`. Keep the file private; Git ignores it.

### Optional: use the PostgreSQL catalog

The portal's **Real** source uses a larger catalog stored in PostgreSQL. Despite the selector's name, the checked-in snapshot contains **synthetic demo prices and stock**, not supplier quotes or actual availability. The source reads prices and availability from the database, without runtime supplier API calls.

Set `REAL_DATABASE_URL` in your shell to point to your PostgreSQL database, then seed that database and start the portal:

```sh
export REAL_DATABASE_URL='postgresql://user:password@localhost:5432/database'
DATABASE_URL="$REAL_DATABASE_URL" npm run seed
npm run web
```

The seed command loads products and the snapshot transactionally. Repeating it replaces the same snapshot without replenishing inventory. Set `VALIO_MOCK=true` in `.env` to enable simulated local checkout; otherwise checkout is preview-only. Existing databases may also need the audit migration described in the [technical reference](TECHNICAL.md#database-migrations).

The snapshot in `data/valio-catalog.json` can be recreated offline with `npm run generate:catalog`, then imported with the seed command above. Its fixed 2020 baseline is for reproducibility, not a capture date. A missing snapshot leaves price and availability unavailable until it is regenerated and imported. Deleted products are unavailable. The stored `source` and API `snapshotSource` identify the data as `synthetic`; `snapshotDate` is the baseline and does not establish actual availability.

## Documentation

- [Technical reference](TECHNICAL.md) — architecture, API, CLI, database setup, and operational details.
- [Reliability audit and failure modes](FMEA.md) — failure-mode analysis, recovery procedures, and regression results.
