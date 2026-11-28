-- Little Pixel Keepsakes — Country-Based Pricing & Currency Enforcement Migration
-- Non-destructive, idempotent SQL migration. Preserves all existing orders, payments, and settings.
-- Run this script in the Supabase SQL Editor after 001_initial_schema.sql.

-- ============================================================================
-- 1. STORE SETTINGS: Singapore shipping rate (nullable = disabled/unconfigured)
--    and Singapore market product prices (fixed SGD cents, no auto FX)
-- ============================================================================
ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS delivery_rate_singapore_cents INTEGER DEFAULT 600;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_delivery_rate_singapore_cents_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_delivery_rate_singapore_cents_check
      CHECK (delivery_rate_singapore_cents IS NULL OR delivery_rate_singapore_cents >= 0);
  END IF;
END $$;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS sg_product_prices_cents JSONB NOT NULL DEFAULT '{"keychain":1290,"magnet":1390}'::JSONB;

-- ============================================================================
-- 2. ORDERS: Persist delivery_country, currency, and authoritative pricing_breakdown
--    Existing orders safely default to MY / MYR without losing any data.
-- ============================================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_country TEXT NOT NULL DEFAULT 'MY';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'MYR';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pricing_breakdown JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_delivery_country_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_delivery_country_check
      CHECK (delivery_country IN ('MY', 'SG'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_currency_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_currency_check
      CHECK (currency IN ('MYR', 'SGD'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_country_currency_match_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_country_currency_match_check
      CHECK (
        (delivery_country = 'MY' AND currency = 'MYR')
        OR (delivery_country = 'SG' AND currency = 'SGD')
      );
  END IF;
END $$;

-- Backfill pricing_breakdown on existing orders without altering saved amounts or statuses
UPDATE public.orders
SET pricing_breakdown = jsonb_build_object(
  'deliveryCountry', delivery_country,
  'currency', currency,
  'productKey', COALESCE(bundle_id, product_id),
  'productName', product_name,
  'itemQuantity', item_quantity,
  'unitSubtotalMinor', subtotal_sen,
  'regularSubtotalMinor', regular_subtotal_sen,
  'bundleDiscountPercent', CASE WHEN savings_sen IS NOT NULL AND savings_sen > 0 THEN 20 ELSE 0 END,
  'bundleSavingsMinor', savings_sen,
  'deliveryZone', customer_state,
  'deliveryFeeMinor', delivery_fee_sen,
  'totalMinor', total_sen
)
WHERE pricing_breakdown IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_delivery_country ON public.orders (delivery_country);
CREATE INDEX IF NOT EXISTS idx_orders_currency ON public.orders (currency);

-- Database-level immutability guard: prevent delivery_country, currency, or pricing mutations after Paid
CREATE OR REPLACE FUNCTION public.prevent_paid_order_pricing_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.payment_status = 'Paid' THEN
    IF NEW.delivery_country IS DISTINCT FROM OLD.delivery_country
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.product_id IS DISTINCT FROM OLD.product_id
      OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id
      OR NEW.subtotal_sen IS DISTINCT FROM OLD.subtotal_sen
      OR NEW.regular_subtotal_sen IS DISTINCT FROM OLD.regular_subtotal_sen
      OR NEW.savings_sen IS DISTINCT FROM OLD.savings_sen
      OR NEW.delivery_fee_sen IS DISTINCT FROM OLD.delivery_fee_sen
      OR NEW.total_sen IS DISTINCT FROM OLD.total_sen
      OR NEW.pricing_breakdown IS DISTINCT FROM OLD.pricing_breakdown
    THEN
      RAISE EXCEPTION 'Delivery country, currency, and pricing cannot be modified after payment confirmation (order %).', OLD.reference;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_prevent_paid_pricing_mutation ON public.orders;
CREATE TRIGGER trg_orders_prevent_paid_pricing_mutation
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_paid_order_pricing_mutation();

-- ============================================================================
-- 3. PAYMENTS: Track delivery_country and enforce supported currencies (myr/sgd)
-- ============================================================================
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS delivery_country TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_delivery_country_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_delivery_country_check
      CHECK (delivery_country IS NULL OR delivery_country IN ('MY', 'SG'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_supported_currency_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_supported_currency_check
      CHECK (LOWER(currency) IN ('myr', 'sgd'));
  END IF;
END $$;

UPDATE public.payments p
SET delivery_country = o.delivery_country
FROM public.orders o
WHERE p.order_id = o.id
  AND p.delivery_country IS NULL;
