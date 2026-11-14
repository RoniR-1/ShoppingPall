# Aimo approval demo reliability audit

Audit date: 2026-11-14. “Current handling” below describes the behavior before this remediation unless explicitly marked retained. Tests use mocked supplier/model responses and local PostgreSQL; they do not prove live supplier availability or model interpretation accuracy.

The OpenAPI document and `sql/schema.sql` are unchanged. Existing CLI flags and HTTP status conventions are retained. Error objects keep their existing message fields and add machine-readable codes where applicable. No HTTP 429 retry, implicit live-to-mock fallback, or model quantity rounding is permitted.

## Failure mode and effects analysis

| Subsystem | Failure Scenario | Current Handling | Risk / Gap | Proposed Fix & File Location |
|---|---|---|---|---|
| Quote/catalog | Zero or partial stock, missing price, product/schedule block | Quote carries availability; order validates requested amount | Rounded stock could overstate exact availability | Preserve stock and price precision; reject unavailable quantities in `src/app.js`, `src/orders.js` |
| Quote/catalog | Terminal or unknown logistics | Positive schedule amount could be considered orderable | Unknown stock treated as confirmed | Require `Stock` logistics in `src/app.js`; session already treats terminal stock as unknown |
| Quote/catalog | Multiple schedule lines or invalid dates | First matching line chosen | Later date or malformed date could be selected | Validate calendar dates and select earliest eligible schedule in `src/app.js`; procurement conservatively declines ambiguous multiple schedules |
| Quote/catalog | Delivery later than requested date | Delay penalty and mandate question | Scoring discounts could remove review requirement | Always require human review for delayed delivery in `src/orders.js`; procurement/portal leave a shortfall for late-only stock |
| Quote/catalog | Cutoff missing timezone or elapsed after quoting | Local-time parsing; validation only at quote creation | Host timezone or elapsed time changes fulfillment eligibility | Explicit timezone required; recheck recorded cutoff at submission/approval in `src/app.js`, `src/orders.js`, portal layers |
| Units | Wrong sales unit or invalid lot multiple | Core and session validate units/lots | Portal rounded quantities silently | Reject invalid proposal instead of changing it in `src/web-demo/middle.js`; core/session unit and lot checks retained |
| Units | Portion/package conversion cannot be verified | Model proposes sales units; managed price caps use package metadata | Recipe semantics cannot be proven from free text | Generated carts always require review; verified conversion required for managed price caps. No general portion conversion guarantee (`src/agent.js`, `src/cli.js`, `src/web-demo/managed-agent.js`) |
| Procurement | Exact preferred product absent | Broad candidates proposed with mandatory constraints | Existing explicit approval path was safe | Retain mandatory-field filtering and selection validation in `src/procurement/session.js` |
| Procurement | Exact product depleted; direct substitute available | Automatically allocated direct substitutes | Human substitution review bypass | Propose one-hop substitutions and require explicit `approvedProductIds` in `src/procurement/session.js` |
| Procurement | Substitute changes origin or another required field | Hard constraints reapplied to candidates | Required constraints must also hold on approved selection | Retain/retest filtering at approval; never follow substitute-of-substitute in `src/procurement/session.js` |
| Procurement | Partial allocation, no eligible replacement | Pending shortfall retained | No explicit accept/reject operation | Add `resolveShortfall(lineId, 'accept'|'reject')`; accepting zero fulfillment fails, rejection releases local allocation (`src/procurement/session.js`) |
| Procurement | Approved no-match candidate also unavailable | Suggestions could disappear | User loses remaining recovery choices | Retain eligible suggestions in `src/procurement/session.js` |
| Procurement | Upstream exception after earlier batch/allocation | Partial mutable state could survive | Retry sees phantom allocation/cache | Snapshot and restore basket, lines and inventory on error in `src/procurement/session.js` |
| Procurement | Concurrent calls on one session | Busy guard | Interleaved allocations would overspend snapshot | Retain/retest busy guard; shortfall resolution also refuses concurrent mutation |
| Substitutions | Identical mapped replacement | No substitution penalty | Could auto-approve | Every substitution forces human review in `src/orders.js` |
| Substitutions | Unmapped swap, pack, nutrition or ingredient changes | Risk penalties and human questions | Exact equivalence cannot be assumed | Retain distinctions and require original and replacement in the quote (`src/orders.js`) |
| Substitutions | Excluded allergen, blocked category, hard/weekly cap | Some restrictions only raised questions | Human approval could override mandatory substitution limits | Enforce constraints at creation and approval; serialize buyer spending decisions in `src/orders.js` |
| Substitutions | Portal selects unoffered product or different SKU for remainder | Alternative ID could be arbitrary; allocation could spill across SKUs | Unreviewed substitution | Restrict to offered choices; quote a new proposal and require a separate human decision (`src/web-demo/middle.js`) |
| Substitutions | Real portal lacks required-origin constraint contract | Portal requests do not carry mandatory product constraints | Cannot guarantee preservation | Fail closed for real-mode portal substitutions; use the constraint-aware procurement flow and separately quote before ordering |
| Mandate | Increase to usual quantity exceeds quoted stock | Changed quantity without enough validation | Larger quantity may be unavailable | Check quoted available amount and require requote when insufficient (`src/orders.js`) |
| Mandate | Restore original product after policy changes | Original was in quote | Original could now violate category/allergen restrictions | Recheck original policy and lot/stock in `src/orders.js` |
| Mandate | Changed cart reuses prior yes answer by question ID | Consent carried by ID alone | Old answer may concern a different amount | Retain answer only when question content, points and alternatives are unchanged (`src/orders.js`) |
| AI/Luna recipe agent | Connection refused, timeout, provider 4xx/5xx | Stage error; configured inference timeout | No fallback should create a cart | Retain explicit failure and test no extra attempts; `src/agent.js`, `test/agent.test.js` |
| AI/Luna recipe agent | Thinking model exhausts 1,024 tokens | Explicit `finish_reason=length` failure | Truncated cart must never be used | Retain output cap/truncation checks; add explicit empty-message error in `src/agent.js` |
| AI/Luna recipe agent | Invalid JSON/schema, zero/negative quantity, duplicate or unknown product | One correction for invalid cart | Search response could exceed five allowed candidates | Validate search response/window and retain bounded correction in `src/agent.js` |
| AI/Luna recipe agent | All three search alternatives fail | Stops before cart construction | No exact product found | Retain actionable failure before quote/order; bounded alternatives tested |
| AI/Luna | Provider or selection error | Selection errors silently chose top candidate | Model failure creates unintended cart | Remove fallback; validate one selection per line against five offered IDs (`src/web-demo/middle.js`) |
| AI/Luna | Missing configuration, truncated/empty/invalid response | Inconsistent provider error handling | Unusable output could reach planning | Require real-mode configuration; reject bounded-output failures with actionable provider errors (`src/web-demo/middle.js`) |
| Recipe safety | Low-risk generated cart | CLI and portal could auto-approve | Recipe suitability bypasses review | CLI recipe sets `force_flag`; generated portal carts always pending (`src/cli.js`, `src/web-demo/middle.js`) |
| Valio | Network failure, 15-second timeout, HTTP 429/500/502/503 | Single request; no implicit mock; 429 preserved | Behavior must remain fail closed | Retain and test single-attempt/no-fallback behavior in `src/valio.js` |
| Valio | Malformed JSON or OpenAPI-invalid body | Main adapter checked product coverage only | Invalid contract data could enter quote | Shared OpenAPI-derived response validation in `src/valio.js`, `src/procurement/client.js` |
| Valio | Wrong customer/date, missing/duplicate/extra product | Coverage partly validated | Response could belong to another request | Validate request identity and exact distinct product coverage in both clients |
| ProcurementClient | HTTP/network/parse failure | Plain errors without status/code | Callers cannot distinguish rate limit or invalid response | Structured status/code errors in `src/procurement/client.js`; no retries |
| ProcurementClient | Cross-origin redirects and slow redirect chains | GET redirects strip API key; deadline reset per hop | Chain extends deadline | One 15-second signal through redirects/body; HTTPS GET-only redirects; POST does not redirect |
| API selection | Missing/invalid user, expired or foreign selection | Validation plus user-bound 30-minute selection set | Selection bypass would expose unselected queries | Retain gate before upstream call in `src/app.js`; malformed requests fail closed |
| Core auth | Missing/incorrect API key | Local demo default key | Missing production configuration unsafe | Require production `CORE_API_KEY`; reject invalid keys; explicit development demo key retained (`src/web-demo/core.js`) |
| Inter-service | 429 or malformed JSON from core | Middle discarded upstream status | Rate limits looked like ordinary input errors | Preserve upstream status, reject invalid JSON and add codes; bound frontend proxy wait (`src/web-demo/middle.js`, `frontend.js`, `core.js`) |
| Live mode | Missing Valio key or real DB configuration | Implicit mock or fallback database | Wrong data source masquerades as real | Mock only with explicit `VALIO_MOCK=true`; real portal requires `REAL_DATABASE_URL` (`src/web-demo/core.js`, `sources.js`) |
| Mode startup | In-memory demo imports Valio with no database configuration | Valio eagerly imported the default DB module | Demo/live clients with injected storage could fail before starting | Lazily load default inventory DB only when used; subprocess regression without `DATABASE_URL` (`src/valio.js`, `test/valio.test.js`) |
| Live checkout | Attempted supplier purchase | Contract has no supplier checkout | Local approval must not imply supplier fulfillment | Live checkout fails closed; simulation remains explicitly local |
| Order expiry | 15-minute quote expires while pending | Main API returns 409 and permits rejection | Portal lacked expiry | Retain main behavior; add portal quote TTL and requote guidance (`src/web-demo/core.js`, `demo-store.js`) |
| Inventory transaction | Stock disappears between quote and approval | Existing DB trigger raises | Earlier line debit must also roll back | Multi-line integration test proves inventory/status/event rollback and retained pending lock (`test/integration.test.js`) |
| Idempotency | Concurrent identical or conflicting submissions | Advisory lock plus request hash | Duplicate purchase or mismatched replay | Retained identical replay and 409 conflict; buyer lock also serializes spend decisions (`src/orders.js`) |
| Order decision | Concurrent approve/reject | Row lock and terminal decision checks | Double decisions | Retained main API conflict behavior; regression test |
| CLI recovery | Crash after submit before response | Prints key and full payload before sending | Re-running recipe makes a different quote | Preserve exact submission output; replay that same body/key, not regenerated recipe (`src/cli.js`) |
| Portal replacement | Failure between new save and old rejection | Separate service calls | Two active proposals | Prepare without saving; replace atomically in core transaction or synchronous DemoStore operation |
| DB errors | Rollback itself fails | Masks original error; bad client returned | Lost diagnosis and poisoned pool | Preserve original error and discard broken client (`src/db.js`, `src/web-demo/sources.js`) |
| Managed dispatch | Crash/timeout after submission may have succeeded | Episode stuck or uncertain outcome auto-received | Duplicate dispatch or unreviewed receipt | Persist before dispatch, recover to `RECONCILING`, block retries/receipt pending human resolution (`src/web-demo/managed-agent.js`) |
| Managed state | Atomic write fails or multiple processes contend | Shared temp filename and process-local queue | Lost state/duplicate episode | Unique temp file, exclusive directory lock, reload under lock, restore persisted state on failure; no dispatch before save |
| Managed resolution | Human declares no order despite matching order | No complete resolution flow | Duplicate order on next tick | Lookup matching action/order; reject false no-order declaration; explicit attach/no-order UI (`web/managed-agent.js`) |
| Managed recovery | Denied or rejected episode remains held | No explicit rearm path | Monitoring remains stuck after a known failure | Record rejection and require human reset for denied/verified rejected episodes; never reset uncertain dispatch this way |
| Screening | Custom scorer throws or returns unsafe integer/NaN | Service validated scores but order creation did not invoke injected service | Custom screening silently ignored | Evaluate in transaction; errors return 503 and create no order/lock (`src/orders.js`, screening tests) |
| Baseline | `/routine` or `/baseline-exclusion` reclassification | Approved-only changes; baseline filters flags | Weekly spending must not disappear with baseline exclusion | Retain baseline filters; weekly spend counts all approved orders; integration coverage |

## User recovery paths

* **Unavailable exact item:** inspect the shortfall and proposed alternatives. Procurement suggestions must satisfy every `required` field and the sales unit. Selecting an ID only updates a simulation; create a valid quote before any separate order submission.
* **Partial fulfillment:** in the portal explicitly accept available quantities or reject the proposal. In a retained procurement session call `resolveShortfall(id, 'accept')` or `resolveShortfall(id, 'reject')`, then resume `run(lines)` to continue past the resolved line. Neither action is supplier checkout.
* **Substitution or quantity edit:** the portal produces a fresh pending proposal and atomically supersedes the original. Review the new quantities, products and prices, then approve separately. Real-mode portal swaps are disabled because their mandatory constraints cannot be represented.
* **Expired quote/cutoff or depleted stock:** reject the pending order and submit a fresh request. Do not reuse its stale quote. An approval failure leaves the original pending transaction intact.
* **429, inference or contract failure:** correct configuration/request or wait before a deliberate retry. There is no automatic rate-limit retry and no fallback to mock. For an ambiguous order submission replay the printed exact idempotency key and payload.
* **`RECONCILING`:** inspect the matching order and use the managed UI to attach it, or confirm no order exists. The agent cannot dispatch that episode again while uncertain. Known denied/rejected episodes have a separate human reset action. A stale state-file lock after a process crash requires an operator to stop competing writers, inspect the dispatch, and remove only that stale lock directory.

## Operational boundaries

This is a local approval demo, not production authentication: `X-User-Id` and portal user IDs identify a demo buyer, not a verified person. Do not expose it to untrusted callers without authenticated identity and authorization. Selection IDs are enforced by the main API; portal internal calls use their separate core-key boundary.

Quotes are snapshots, not supplier reservations. Human-reviewed recipe conversion remains an estimate unless verified package data supports it. Procurement baskets are in-memory simulations. The managed state lock intentionally favors refusing work over guessing whether a crashed writer is gone; atomic rename protects process-crash consistency but does not guarantee storage durability after power loss. Live supplier and model services require separate integration validation.

## Verification

Final validation on Node 24.22.1:

| Command | Result |
|---|---|
| `npm test` | 107 tests passed after Luna migration; includes real PostgreSQL integration and the three-process managed portal |
| `npm run test:portal` | 26 tests passed |
| `node --test test/agent.test.js` | Passed |
| `node --test test/procurement.test.js` | Passed |
| `node test/order-screening.test.js` | 6 tests passed |
| `node --test test/managed-agent.test.js` | Passed |
| `git diff --check` | Passed |
| `git diff --exit-code -- openapi.json sql/schema.sql` | Passed; protected files unchanged |

The complete suite ran outside the filesystem/network sandbox with authorized local HTTP/PostgreSQL access. The initial sandbox attempt could not support the integration listeners. A subsequent real failure exposed inherited `PORT` configuration and premature startup detection in the process test; the test now uses isolated ports and waits for actual listening messages.

Coverage includes injected provider errors and malformed output, mandatory substitution constraints, session rollback, concurrent state ownership, manual reconciliation, PostgreSQL inventory rollback, selection expiry, idempotency and human approval routing. External Valio/Luna endpoints and power-loss durability were not exercised.
