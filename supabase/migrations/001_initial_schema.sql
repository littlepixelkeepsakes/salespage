-- Little Pixel Keepsakes — Supabase PostgreSQL & Private Storage Migration
-- Run this complete script in the Supabase SQL Editor.
-- Creates:
--   1. public.staff_accounts
--   2. public.store_settings
--   3. public.orders
--   4. public.payments
--   5. public.email_notifications
-- Enables Row Level Security on all tables, revokes anonymous/authenticated direct access,
-- grants backend service_role access only, and provisions private storage buckets.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared updated_at trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 1. STAFF ACCOUNTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Staff Admin',
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'staff')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_staff_accounts_updated_at ON public.staff_accounts;
CREATE TRIGGER trg_staff_accounts_updated_at
  BEFORE UPDATE ON public.staff_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. STORE SETTINGS (singleton row id = 'default')
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.store_settings (
  id TEXT PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  logo_url TEXT NOT NULL,
  hero_image_url TEXT NOT NULL,
  product_images JSONB NOT NULL DEFAULT '{}'::JSONB,
  gallery_items JSONB NOT NULL DEFAULT '[]'::JSONB,
  delivery_rate_peninsular_sen INTEGER NOT NULL DEFAULT 800 CHECK (delivery_rate_peninsular_sen >= 0),
  delivery_rate_east_malaysia_sen INTEGER NOT NULL DEFAULT 1500 CHECK (delivery_rate_east_malaysia_sen >= 0),
  whatsapp_support_number TEXT NOT NULL DEFAULT '',
  tng_override_enabled BOOLEAN,
  tng_override_recipient_name TEXT NOT NULL DEFAULT '',
  tng_override_qr_image TEXT NOT NULL DEFAULT '',
  duitnow_override_enabled BOOLEAN,
  duitnow_override_recipient_name TEXT NOT NULL DEFAULT '',
  duitnow_override_qr_image TEXT NOT NULL DEFAULT '',
  updated_by_staff_id UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_store_settings_updated_at ON public.store_settings;
CREATE TRIGGER trg_store_settings_updated_at
  BEFORE UPDATE ON public.store_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. ORDERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^LPK-\d{4}-[A-Z0-9]{6,10}$'),
  access_token TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  bundle_id TEXT,
  product_name TEXT NOT NULL,
  item_quantity INTEGER NOT NULL CHECK (item_quantity > 0),
  subtotal_sen INTEGER NOT NULL CHECK (subtotal_sen >= 0),
  regular_subtotal_sen INTEGER CHECK (regular_subtotal_sen IS NULL OR regular_subtotal_sen >= 0),
  savings_sen INTEGER CHECK (savings_sen IS NULL OR savings_sen >= 0),
  delivery_fee_sen INTEGER NOT NULL CHECK (delivery_fee_sen >= 0),
  total_sen INTEGER NOT NULL CHECK (total_sen >= 0),
  photo_storage_bucket TEXT NOT NULL DEFAULT 'customer-photos',
  photo_storage_path TEXT NOT NULL,
  photo_original_filename TEXT,
  photo_mime_type TEXT CHECK (photo_mime_type IS NULL OR photo_mime_type IN ('image/jpeg', 'image/png')),
  photo_size_bytes INTEGER CHECK (photo_size_bytes IS NULL OR photo_size_bytes >= 0),
  customer_full_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_mobile TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  customer_postcode TEXT NOT NULL,
  customer_city TEXT NOT NULL,
  customer_state TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'Awaiting payment'
    CHECK (payment_status IN ('Awaiting payment', 'Pending verification', 'Receipt correction needed', 'Paid')),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('tng', 'duitnow', 'card')),
  paid_at TIMESTAMPTZ,
  verified_by_staff BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by_staff_id UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
  verification_note TEXT,
  correction_reason TEXT,
  last_card_attempt_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders (payment_status);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 4. PAYMENTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL REFERENCES public.orders(reference) ON DELETE CASCADE,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('tng', 'duitnow', 'card')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_verification', 'correction_needed', 'paid', 'failed', 'expired', 'superseded')),
  amount_sen INTEGER NOT NULL CHECK (amount_sen >= 0),
  currency TEXT NOT NULL DEFAULT 'myr',
  transaction_reference TEXT,
  receipt_storage_bucket TEXT,
  receipt_storage_path TEXT,
  receipt_original_filename TEXT,
  receipt_mime_type TEXT CHECK (receipt_mime_type IS NULL OR receipt_mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  receipt_size_bytes INTEGER CHECK (receipt_size_bytes IS NULL OR receipt_size_bytes >= 0),
  receipt_uploaded_at TIMESTAMPTZ,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_event_id TEXT UNIQUE,
  verified_by_staff BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by_staff_id UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
  verification_note TEXT,
  rejection_reason TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id_created ON public.payments (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_order_reference ON public.payments (order_reference);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 5. EMAIL NOTIFICATIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_reference TEXT NOT NULL REFERENCES public.orders(reference) ON DELETE CASCADE,
  notification_type TEXT NOT NULL DEFAULT 'order_confirmation'
    CHECK (notification_type IN ('order_confirmation')),
  provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend', 'smtp', 'none')),
  recipient_email TEXT NOT NULL,
  sender_email TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'not_configured')),
  provider_message_id TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_email_notifications_order_type UNIQUE (order_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_email_notifications_order_reference ON public.email_notifications (order_reference);

DROP TRIGGER IF EXISTS trg_email_notifications_updated_at ON public.email_notifications;
CREATE TRIGGER trg_email_notifications_updated_at
  BEFORE UPDATE ON public.email_notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY & EXPLICIT BACKEND-ONLY PRIVILEGES
-- ============================================================================
-- Lock down all 5 tables so anonymous and authenticated client roles cannot read
-- or modify customer orders, receipts, staff credentials, or notifications directly.
-- Only the backend service_role key is granted access.

ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.email_notifications FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_notifications TO service_role;

DROP POLICY IF EXISTS "staff_accounts_service_role_only" ON public.staff_accounts;
CREATE POLICY "staff_accounts_service_role_only"
  ON public.staff_accounts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS "store_settings_service_role_only" ON public.store_settings;
CREATE POLICY "store_settings_service_role_only"
  ON public.store_settings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS "orders_service_role_only" ON public.orders;
CREATE POLICY "orders_service_role_only"
  ON public.orders
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS "payments_service_role_only" ON public.payments;
CREATE POLICY "payments_service_role_only"
  ON public.payments
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS "email_notifications_service_role_only" ON public.email_notifications;
CREATE POLICY "email_notifications_service_role_only"
  ON public.email_notifications
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ============================================================================
-- PRIVATE STORAGE BUCKETS & STORAGE RLS POLICIES
-- ============================================================================
-- Creates private buckets matching SUPABASE_PHOTOS_BUCKET ('customer-photos')
-- and SUPABASE_RECEIPTS_BUCKET ('payment-receipts').

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('customer-photos', 'customer-photos', FALSE, 10485760, ARRAY['image/jpeg', 'image/png']),
  ('payment-receipts', 'payment-receipts', FALSE, 10485760, ARRAY['image/jpeg', 'image/png', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
SET
  public = FALSE,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Restrict storage.objects access for both private buckets to service_role only.
-- Anonymous and authenticated client roles have no policies on these buckets, so
-- direct client reads/writes are denied by default when RLS is enabled.
DROP POLICY IF EXISTS "customer_photos_service_role_only" ON storage.objects;
CREATE POLICY "customer_photos_service_role_only"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'customer-photos')
  WITH CHECK (bucket_id = 'customer-photos');

DROP POLICY IF EXISTS "payment_receipts_service_role_only" ON storage.objects;
CREATE POLICY "payment_receipts_service_role_only"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'payment-receipts')
  WITH CHECK (bucket_id = 'payment-receipts');
