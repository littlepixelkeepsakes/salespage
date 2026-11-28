-- Little Pixel Keepsakes — Custom Perler Bead Portrait Frame Migration
-- Non-destructive, idempotent SQL migration. Preserves all existing orders, payments, and settings.
-- Run this script in the Supabase SQL Editor after 001_initial_schema.sql, 002_country_based_pricing.sql,
-- and 003_meta_conversions.sql.

-- ============================================================================
-- 1. STORE SETTINGS: Separately configurable Portrait Frame prices, delivery
--    charges (MY Peninsular, East Malaysia, Singapore), and delivery timeframe
-- ============================================================================
ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_price_my_sen INTEGER NOT NULL DEFAULT 19990;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_price_sg_cents INTEGER NOT NULL DEFAULT 7990;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_delivery_peninsular_sen INTEGER NOT NULL DEFAULT 1200;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_delivery_east_malaysia_sen INTEGER NOT NULL DEFAULT 2000;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_delivery_singapore_cents INTEGER DEFAULT 1200;

ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS portrait_frame_delivery_days INTEGER NOT NULL DEFAULT 14;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_price_my_sen_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_price_my_sen_check
      CHECK (portrait_frame_price_my_sen >= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_price_sg_cents_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_price_sg_cents_check
      CHECK (portrait_frame_price_sg_cents >= 50);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_delivery_peninsular_sen_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_delivery_peninsular_sen_check
      CHECK (portrait_frame_delivery_peninsular_sen >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_delivery_east_malaysia_sen_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_delivery_east_malaysia_sen_check
      CHECK (portrait_frame_delivery_east_malaysia_sen >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_delivery_singapore_cents_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_delivery_singapore_cents_check
      CHECK (portrait_frame_delivery_singapore_cents IS NULL OR portrait_frame_delivery_singapore_cents >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_portrait_frame_delivery_days_check'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_portrait_frame_delivery_days_check
      CHECK (portrait_frame_delivery_days >= 1 AND portrait_frame_delivery_days <= 90);
  END IF;
END $$;

-- Preserve existing custom product images while ensuring portrait_frame has its default image key
UPDATE public.store_settings
SET product_images = COALESCE(product_images, '{}'::JSONB) || jsonb_build_object(
  'portrait_frame',
  '/assets/aistudio/Our_Family_Perler_Bead_Portrait_ee465ba0.png'
)
WHERE NOT (COALESCE(product_images, '{}'::JSONB) ? 'portrait_frame');

-- ============================================================================
-- 2. ORDERS: Optional frame personalisation text & authoritative delivery_days
--    All existing customer orders are fully preserved without modification.
-- ============================================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS personalisation_text TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_personalisation_text_length_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_personalisation_text_length_check
      CHECK (personalisation_text IS NULL OR char_length(personalisation_text) <= 80);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_delivery_days_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_delivery_days_check
      CHECK (delivery_days IS NULL OR (delivery_days >= 1 AND delivery_days <= 90));
  END IF;
END $$;

-- Extend database-level immutability guard for Paid orders to also protect personalisation_text and delivery_days
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
      OR NEW.personalisation_text IS DISTINCT FROM OLD.personalisation_text
      OR NEW.delivery_days IS DISTINCT FROM OLD.delivery_days
    THEN
      RAISE EXCEPTION 'Delivery country, currency, pricing, and customisation cannot be modified after payment confirmation (order %).', OLD.reference;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
