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
  items jsonb NOT NULL,
  currency text NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  mocked boolean NOT NULL,
  requested_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders(user_id, created_at) WHERE status = 'PENDING_APPROVAL';
CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
