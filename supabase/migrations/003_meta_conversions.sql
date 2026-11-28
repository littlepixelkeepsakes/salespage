-- Little Pixel Keepsakes — Meta Pixel & Conversions API (CAPI) Tracking Migration
-- Non-destructive, idempotent SQL migration. Preserves all existing orders, payments, and settings.
-- Run this script in the Supabase SQL Editor after 001_initial_schema.sql and 002_country_based_pricing.sql.

-- ============================================================================
-- 1. ORDERS: Optional browser attribution & marketing consent metadata
--    Captured at checkout so server-side CAPI Purchase events still carry high
--    match quality even if the customer closes the browser before confirmation.
--    Never stores photos, receipts, access tokens, or payment credentials.
-- ============================================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_fbp TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_fbc TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_event_source_url TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_client_ip TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_client_user_agent TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_marketing_consent BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================================
-- 2. META CONVERSION EVENTS: Persistent server-side CAPI delivery & dedup ledger
--    Enforces at-most-once Purchase tracking per order across serverless instances,
--    webhook retries, staff verification retries, and refreshes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.meta_conversion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL REFERENCES public.orders(reference) ON DELETE CASCADE,
  event_name TEXT NOT NULL DEFAULT 'Purchase' CHECK (event_name IN ('Purchase')),
  event_id TEXT NOT NULL UNIQUE,
  event_time BIGINT NOT NULL CHECK (event_time > 0),
  delivery_country TEXT NOT NULL DEFAULT 'MY' CHECK (delivery_country IN ('MY', 'SG')),
  currency TEXT NOT NULL DEFAULT 'MYR' CHECK (currency IN ('MYR', 'SGD')),
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  content_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  num_items INTEGER NOT NULL DEFAULT 1 CHECK (num_items > 0),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'not_configured', 'skipped_consent')),
  test_mode BOOLEAN NOT NULL DEFAULT FALSE,
  fbtrace_id TEXT,
  events_received INTEGER,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_conversion_events_order_event UNIQUE (order_id, event_name)
);

CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_order_ref
  ON public.meta_conversion_events (order_reference);

CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_status_updated
  ON public.meta_conversion_events (status, last_attempt_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_sent_at
  ON public.meta_conversion_events (sent_at DESC);

DROP TRIGGER IF EXISTS trg_meta_conversion_events_updated_at ON public.meta_conversion_events;
CREATE TRIGGER trg_meta_conversion_events_updated_at
  BEFORE UPDATE ON public.meta_conversion_events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. ROW LEVEL SECURITY & BACKEND-ONLY PRIVILEGES
-- ============================================================================
ALTER TABLE public.meta_conversion_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.meta_conversion_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.meta_conversion_events TO service_role;

DROP POLICY IF EXISTS "meta_conversion_events_service_role_only" ON public.meta_conversion_events;
CREATE POLICY "meta_conversion_events_service_role_only"
  ON public.meta_conversion_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);
