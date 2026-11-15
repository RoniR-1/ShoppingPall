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
