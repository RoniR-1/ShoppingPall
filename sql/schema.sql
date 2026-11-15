CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  search_text text NOT NULL,
  category text NOT NULL,
  country_of_origin text,
  sales_unit text NOT NULL,
  allowed_lot_size numeric NOT NULL CHECK (allowed_lot_size > 0),
  deleted boolean NOT NULL DEFAULT false,
  carbon_kg_co2_per_kg numeric CHECK (carbon_kg_co2_per_kg >= 0),
  delivery_reliability numeric CHECK (delivery_reliability BETWEEN 0 AND 1),
  raw jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
CREATE TABLE IF NOT EXISTS buyer_risk_policies (
  user_id text PRIMARY KEY,
  hard_spend_limit numeric NOT NULL CHECK (hard_spend_limit > 0),
  weekly_spend_limit numeric NOT NULL CHECK (weekly_spend_limit > 0),
  blocked_categories text[] NOT NULL DEFAULT '{}',
  excluded_allergens text[] NOT NULL DEFAULT '{}'
);
ALTER TABLE buyer_risk_policies DROP COLUMN IF EXISTS deposit_rates;
CREATE TABLE IF NOT EXISTS selections (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  product_ids text[] NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  requested_date date NOT NULL,
  currency text NOT NULL,
  items jsonb NOT NULL,
  mocked boolean NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  flag_reason text,
  risk_score numeric NOT NULL DEFAULT 0,
  risk_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  routine boolean NOT NULL DEFAULT false,
  exclude_from_baseline boolean NOT NULL DEFAULT false,
  items jsonb NOT NULL,
  currency text NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  mocked boolean NOT NULL,
  requested_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS quote_locks (
  quote_id uuid PRIMARY KEY REFERENCES quotes(id) ON DELETE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  locked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS risk_score numeric NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS risk_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS routine boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exclude_from_baseline boolean NOT NULL DEFAULT false;
UPDATE orders SET routine=true WHERE status='APPROVED' AND risk_details='{}'::jsonb AND routine=false;
CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders(user_id, created_at) WHERE status = 'PENDING_APPROVAL';
CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Local demo stock; seeding never replenishes purchased inventory.
CREATE TABLE IF NOT EXISTS inventory (
  product_id text PRIMARY KEY REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 1000 CHECK (quantity >= 0)
);
INSERT INTO inventory(product_id) SELECT id FROM products ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION debit_demo_inventory() RETURNS trigger AS $$
DECLARE line jsonb;
BEGIN
  IF NEW.status = 'APPROVED' AND NEW.mocked AND
     (TG_OP = 'INSERT' OR OLD.status <> 'APPROVED') THEN
    FOR line IN SELECT value FROM jsonb_array_elements(NEW.items) ORDER BY value->>'productId' LOOP
      UPDATE inventory SET quantity = quantity - (line->>'quantity')::numeric
      WHERE product_id = line->>'productId' AND quantity >= (line->>'quantity')::numeric;
      IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient local inventory for %', line->>'productId'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER orders_inventory BEFORE INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION debit_demo_inventory();

-- Registry links an existing trace identifier without copying reasoning into the ledger.
CREATE TABLE IF NOT EXISTS audit_trace_refs (
  trace_id text PRIMARY KEY, user_id text NOT NULL
);
-- A per-buyer chain is appended in the transaction containing the state change.
CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigserial PRIMARY KEY,
  user_id text NOT NULL,
  event jsonb NOT NULL,
  trace_id text GENERATED ALWAYS AS (event->>'trace_id') STORED REFERENCES audit_trace_refs(trace_id),
  CHECK (jsonb_typeof(event) = 'object' AND event ?& ARRAY['audit_id','timestamp','actor','event_type','previous_hash','integrity_hash']),
  CHECK (COALESCE(event->'actor'->>'type' IN ('autonomous_agent','human_approver','wholesaler_system'),false)),
  CHECK (COALESCE(event->'actor' ?& ARRAY['id','role','organization'],false)),
  CHECK (COALESCE(event->>'integrity_hash' ~ '^[0-9a-f]{64}$',false))
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_id_idx ON audit_events ((event->>'audit_id'));
CREATE INDEX IF NOT EXISTS audit_events_user_sequence_idx ON audit_events(user_id,sequence);
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
