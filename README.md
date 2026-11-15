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

## Documentation

- [Technical reference](TECHNICAL.md) — architecture, API contract, CLI, database setup, and operational details.
- [Reliability audit and failure modes](FMEA.md) — failure-mode analysis, recovery procedures, and regression results.
