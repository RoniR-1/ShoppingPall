# Railway deployment

Deploy this repository as a Railway service using its Dockerfile. This is a long-running service: keep one replica running and disable sleep, since the managed agent uses an in-process timer and local state. The frontend listens on Railway's `PORT` (or `FRONTEND_PORT`, then 3001) and `HOST` (default `0.0.0.0`); the middle and core services remain on loopback.

1. Add a PostgreSQL service and set the application service's `REAL_DATABASE_URL` to the Postgres service's connection URL using a Railway variable reference. Set a random `CORE_API_KEY`, `VALIO_MOCK=true`, and optionally `LUNA_API_KEY`. Set `HOST=0.0.0.0` if overriding the default. Generate a public domain for the application service.
2. Attach a persistent volume mounted at `/app/.local`, and set `MANAGED_STATE_FILE=/app/.local/managed-agent.json`. Use a single replica to avoid competing timers and writes.
3. On startup, the application initializes the schema and seeds an empty catalog from the included JSON and CSV files. Existing catalogs and inventory are preserved. Set `REAL_DATABASE_URL` to the Railway Postgres connection URL; startup fails if initialization fails. For the standalone API (`npm start`), use `DATABASE_URL` instead.
4. Protect the service with an authenticated access proxy or VPN before sharing its URL. The portal's user identity is a demo identity and does not authenticate buyers or protect purchasing endpoints.

Demo catalog data is in memory and resets on restart. The managed agent currently operates against the demo source; persisting its JSON state does not persist demo orders or inventory. PostgreSQL is needed for the real catalog. Verify the deployment and the intended data source before relying on replenishments.
