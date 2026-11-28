import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  DeliveryCountry,
  EditableStoreSettings,
  MetaConversionEventStatus,
  OrderPricingBreakdown,
  PaymentMethodKey,
  PaymentStatus,
  SupabaseHealthDiagnostic,
  SupportedCurrency
} from '../types/order';

export interface SupabaseEnvConfig {
  url: string;
  secretKey: string;
  photosBucket: string;
  receiptsBucket: string;
  issues: string[];
  valid: boolean;
}

export interface StaffAccountRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: 'admin' | 'staff';
  password_salt: string;
  password_hash: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreSettingsRow {
  id: string;
  logo_url: string;
  hero_image_url: string;
  product_images: {
    keychain: string;
    magnet: string;
    bundle: string;
    portrait_frame?: string;
  };
  gallery_items: EditableStoreSettings['galleryItems'];
  delivery_rate_peninsular_sen: number;
  delivery_rate_east_malaysia_sen: number;
  delivery_rate_singapore_cents?: number | null;
  sg_product_prices_cents?: {
    keychain: number;
    magnet: number;
  } | null;
  portrait_frame_price_my_sen?: number | null;
  portrait_frame_price_sg_cents?: number | null;
  portrait_frame_delivery_peninsular_sen?: number | null;
  portrait_frame_delivery_east_malaysia_sen?: number | null;
  portrait_frame_delivery_singapore_cents?: number | null;
  portrait_frame_delivery_days?: number | null;
  whatsapp_support_number: string;
  tng_override_enabled: boolean | null;
  tng_override_recipient_name: string;
  tng_override_qr_image: string;
  duitnow_override_enabled: boolean | null;
  duitnow_override_recipient_name: string;
  duitnow_override_qr_image: string;
  updated_by_staff_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: string;
  reference: string;
  access_token: string;
  delivery_country?: DeliveryCountry | null;
  currency?: SupportedCurrency | null;
  pricing_breakdown?: OrderPricingBreakdown | null;
  product_id: string;
  bundle_id: string | null;
  product_name: string;
  item_quantity: number;
  subtotal_sen: number;
  regular_subtotal_sen: number | null;
  savings_sen: number | null;
  delivery_fee_sen: number;
  total_sen: number;
  personalisation_text?: string | null;
  delivery_days?: number | null;
  photo_storage_bucket: string;
  photo_storage_path: string;
  photo_original_filename: string | null;
  photo_mime_type: 'image/jpeg' | 'image/png' | null;
  photo_size_bytes: number | null;
  customer_full_name: string;
  customer_email: string;
  customer_mobile: string;
  customer_address: string;
  customer_postcode: string;
  customer_city: string;
  customer_state: string;
  payment_status: PaymentStatus;
  payment_method: PaymentMethodKey | null;
  paid_at: string | null;
  verified_by_staff: boolean;
  verified_by_staff_id: string | null;
  verification_note: string | null;
  correction_reason: string | null;
  last_card_attempt_message: string | null;
  meta_fbp?: string | null;
  meta_fbc?: string | null;
  meta_event_source_url?: string | null;
  meta_client_ip?: string | null;
  meta_client_user_agent?: string | null;
  meta_marketing_consent?: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  order_reference: string;
  delivery_country?: DeliveryCountry | null;
  payment_method: PaymentMethodKey;
  status:
    | 'pending'
    | 'pending_verification'
    | 'correction_needed'
    | 'paid'
    | 'failed'
    | 'expired'
    | 'superseded';
  amount_sen: number;
  currency: string;
  transaction_reference: string | null;
  receipt_storage_bucket: string | null;
  receipt_storage_path: string | null;
  receipt_original_filename: string | null;
  receipt_mime_type: 'image/jpeg' | 'image/png' | 'application/pdf' | null;
  receipt_size_bytes: number | null;
  receipt_uploaded_at: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_event_id: string | null;
  verified_by_staff: boolean;
  verified_by_staff_id: string | null;
  verification_note: string | null;
  rejection_reason: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailNotificationRow {
  id: string;
  order_id: string;
  order_reference: string;
  notification_type: 'order_confirmation';
  provider: 'resend' | 'none';
  recipient_email: string;
  sender_email: string | null;
  subject: string;
  status: 'sending' | 'sent' | 'failed' | 'not_configured';
  provider_message_id: string | null;
  error_message: string | null;
  attempt_count: number;
  sent_at: string | null;
  last_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface MetaConversionEventRow {
  id: string;
  order_id: string;
  order_reference: string;
  event_name: string;
  event_id: string;
  event_time: number;
  delivery_country: DeliveryCountry;
  currency: SupportedCurrency;
  value_minor: number;
  content_ids: string[];
  num_items: number;
  status: MetaConversionEventStatus;
  test_mode: boolean;
  fbtrace_id: string | null;
  events_received: number | null;
  error_message: string | null;
  attempt_count: number;
  sent_at: string | null;
  last_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface HydratedOrder {
  order: OrderRow;
  latestPayment: PaymentRow | null;
  latestReceiptPayment: PaymentRow | null;
  confirmationEmail: EmailNotificationRow | null;
  metaPurchaseEvent: MetaConversionEventRow | null;
}

const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes short-lived signed URLs

let cachedClientSignature = '';
let cachedClient: SupabaseClient | null = null;

export function sanitizeSupabaseError(raw: unknown): string {
  const message =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message?: unknown }).message || '')
        : String(raw || 'Supabase request failed');
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export function getSupabaseEnvConfig(): SupabaseEnvConfig {
  const url = (process.env.SUPABASE_URL || '').trim();
  const secretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const photosBucket = (process.env.SUPABASE_PHOTOS_BUCKET || '').trim();
  const receiptsBucket = (process.env.SUPABASE_RECEIPTS_BUCKET || '').trim();
  const issues: string[] = [];

  if (!url) {
    issues.push('SUPABASE_URL is missing on the server.');
  } else {
    try {
      const parsed = new URL(url);
      const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        issues.push('SUPABASE_URL must be a valid https:// Supabase project URL.');
      }
    } catch {
      issues.push('SUPABASE_URL is not a valid URL.');
    }
  }

  if (!secretKey) {
    issues.push('SUPABASE_SECRET_KEY is missing on the server.');
  } else if (secretKey.startsWith('sb_publishable_')) {
    issues.push('SUPABASE_SECRET_KEY must be a server-side secret/service_role key, not a publishable key.');
  }

  if (!photosBucket) {
    issues.push('SUPABASE_PHOTOS_BUCKET is missing on the server (expected e.g. customer-photos).');
  } else if (!BUCKET_NAME_REGEX.test(photosBucket)) {
    issues.push('SUPABASE_PHOTOS_BUCKET has an invalid bucket name.');
  }

  if (!receiptsBucket) {
    issues.push('SUPABASE_RECEIPTS_BUCKET is missing on the server (expected e.g. payment-receipts).');
  } else if (!BUCKET_NAME_REGEX.test(receiptsBucket)) {
    issues.push('SUPABASE_RECEIPTS_BUCKET has an invalid bucket name.');
  }

  return {
    url,
    secretKey,
    photosBucket,
    receiptsBucket,
    issues,
    valid: issues.length === 0
  };
}

export function getSupabaseAdminClient(): SupabaseClient {
  const cfg = getSupabaseEnvConfig();
  if (!cfg.valid) {
    throw new Error(`Supabase is not configured: ${cfg.issues.join(' ')}`);
  }

  const signature = `${cfg.url}|${cfg.secretKey}`;
  if (cachedClient && cachedClientSignature === signature) {
    return cachedClient;
  }

  cachedClient = createClient(cfg.url, cfg.secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  cachedClientSignature = signature;
  return cachedClient;
}

const REQUIRED_TABLES = [
  'orders',
  'payments',
  'store_settings',
  'staff_accounts',
  'email_notifications'
] as const;

let cachedHealth: { checkedAt: number; result: SupabaseHealthDiagnostic } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000;

export function clearSupabaseHealthCache(): void {
  cachedHealth = null;
}

export async function checkSupabaseHealth(forceRefresh = false): Promise<SupabaseHealthDiagnostic> {
  const cfg = getSupabaseEnvConfig();
  if (!cfg.valid) {
    return {
      configured: false,
      databaseReady: false,
      photosBucketReady: false,
      receiptsBucketReady: false,
      photosBucket: cfg.photosBucket || null,
      receiptsBucket: cfg.receiptsBucket || null,
      issues: cfg.issues,
      issue: cfg.issues.join(' ')
    };
  }

  if (!forceRefresh && cachedHealth && Date.now() - cachedHealth.checkedAt < HEALTH_CACHE_TTL_MS) {
    return cachedHealth.result;
  }

  const issues: string[] = [];
  let databaseReady = true;
  let photosBucketReady = false;
  let receiptsBucketReady = false;
  let countryPricingSchemaReady = false;
  let metaConversionsSchemaReady = false;
  let portraitFrameSchemaReady = false;

  try {
    const client = getSupabaseAdminClient();

    // 1. Verify all 5 required tables are reachable
    const missingTables: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const { error } = await client.from(table).select('*', { count: 'exact', head: true }).limit(1);
      if (error) {
        databaseReady = false;
        const code = (error as { code?: string }).code || '';
        const msg = sanitizeSupabaseError(error);
        if (code === '42P01' || code === 'PGRST205' || msg.includes('Could not find the table')) {
          missingTables.push(table);
        } else {
          issues.push(`Supabase database check failed on ${table}: ${msg}`);
          break;
        }
      }
    }

    if (missingTables.length > 0) {
      issues.push(
        `Missing Supabase tables (${missingTables.join(', ')}). Execute supabase/migrations/001_initial_schema.sql in the Supabase SQL Editor.`
      );
    }

    // 1b. Non-breaking checks for 002, 003, and 004 schema migrations
    if (databaseReady) {
      const [
        ordersSchemaCheck,
        settingsSchemaCheck,
        metaTableCheck,
        metaOrdersColsCheck,
        portraitSettingsCheck,
        portraitOrdersCheck
      ] = await Promise.all([
        client
          .from('orders')
          .select('delivery_country,currency,pricing_breakdown', { head: true })
          .limit(1),
        client
          .from('store_settings')
          .select('delivery_rate_singapore_cents,sg_product_prices_cents', { head: true })
          .limit(1),
        client.from('meta_conversion_events').select('id', { head: true }).limit(1),
        client
          .from('orders')
          .select('meta_fbp,meta_fbc,meta_marketing_consent', { head: true })
          .limit(1),
        client
          .from('store_settings')
          .select(
            'portrait_frame_price_my_sen,portrait_frame_price_sg_cents,portrait_frame_delivery_peninsular_sen,portrait_frame_delivery_east_malaysia_sen,portrait_frame_delivery_singapore_cents,portrait_frame_delivery_days',
            { head: true }
          )
          .limit(1),
        client
          .from('orders')
          .select('personalisation_text,delivery_days', { head: true })
          .limit(1)
      ]);
      countryPricingSchemaReady = !ordersSchemaCheck.error && !settingsSchemaCheck.error;
      metaConversionsSchemaReady = !metaTableCheck.error && !metaOrdersColsCheck.error;
      portraitFrameSchemaReady = !portraitSettingsCheck.error && !portraitOrdersCheck.error;
    }

    // 2. Verify private storage buckets exist and are NOT public
    const { data: buckets, error: bucketsError } = await client.storage.listBuckets();
    if (bucketsError) {
      issues.push(`Unable to verify Supabase Storage buckets: ${sanitizeSupabaseError(bucketsError)}`);
    } else {
      const bucketMap = new Map((buckets || []).map(b => [b.name, b]));

      const photos = bucketMap.get(cfg.photosBucket);
      if (!photos) {
        issues.push(
          `Private storage bucket "${cfg.photosBucket}" was not found. Create it as a private bucket or run supabase/migrations/001_initial_schema.sql.`
        );
      } else if (photos.public) {
        issues.push(
          `Storage bucket "${cfg.photosBucket}" must be private (public = false) to protect customer photos.`
        );
      } else {
        photosBucketReady = true;
      }

      const receipts = bucketMap.get(cfg.receiptsBucket);
      if (!receipts) {
        issues.push(
          `Private storage bucket "${cfg.receiptsBucket}" was not found. Create it as a private bucket or run supabase/migrations/001_initial_schema.sql.`
        );
      } else if (receipts.public) {
        issues.push(
          `Storage bucket "${cfg.receiptsBucket}" must be private (public = false) to protect payment receipts.`
        );
      } else {
        receiptsBucketReady = true;
      }
    }
  } catch (err) {
    databaseReady = false;
    issues.push(`Supabase connection failed: ${sanitizeSupabaseError(err)}`);
  }

  const configured = databaseReady && photosBucketReady && receiptsBucketReady && issues.length === 0;
  const result: SupabaseHealthDiagnostic = {
    configured,
    databaseReady,
    photosBucketReady,
    receiptsBucketReady,
    countryPricingSchemaReady,
    metaConversionsSchemaReady,
    portraitFrameSchemaReady,
    photosBucket: cfg.photosBucket,
    receiptsBucket: cfg.receiptsBucket,
    issues,
    issue: issues.length > 0 ? issues.join(' ') : undefined
  };

  cachedHealth = { checkedAt: Date.now(), result };
  return result;
}

// ============================================================================
// PRIVATE STORAGE OPERATIONS (customer-photos & payment-receipts)
// ============================================================================

export async function uploadPrivateFile(opts: {
  bucket: string;
  storagePath: string;
  buffer: Buffer;
  contentType: string;
  upsert?: boolean;
}): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client.storage.from(opts.bucket).upload(opts.storagePath, opts.buffer, {
    contentType: opts.contentType,
    cacheControl: '3600',
    upsert: Boolean(opts.upsert)
  });
  if (error) {
    throw new Error(`Storage upload failed (${opts.bucket}): ${sanitizeSupabaseError(error)}`);
  }
}

export async function movePrivateFile(opts: {
  bucket: string;
  fromPath: string;
  toPath: string;
}): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client.storage.from(opts.bucket).move(opts.fromPath, opts.toPath);
  if (error) {
    throw new Error(`Storage move failed (${opts.bucket}): ${sanitizeSupabaseError(error)}`);
  }
}

/**
 * Copies a private storage object non-destructively so the pending upload remains intact
 * until the database order insert succeeds. If a stale orphaned destination exists from
 * a prior interrupted attempt (where no order row was persisted), replaces it safely.
 */
export async function copyPrivateFile(opts: {
  bucket: string;
  fromPath: string;
  toPath: string;
}): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client.storage.from(opts.bucket).copy(opts.fromPath, opts.toPath);
  if (!error) return;

  const msg = sanitizeSupabaseError(error);
  const alreadyExists = /already exists|duplicate|409/i.test(msg);
  if (alreadyExists) {
    // Only overwrite stale destination if the source pending object still exists
    await removePrivateFile(opts.bucket, opts.toPath);
    const retry = await client.storage.from(opts.bucket).copy(opts.fromPath, opts.toPath);
    if (!retry.error) return;
    throw new Error(`Storage copy failed (${opts.bucket}): ${sanitizeSupabaseError(retry.error)}`);
  }

  throw new Error(`Storage copy failed (${opts.bucket}): ${msg}`);
}

export async function removePrivateFile(bucket: string, storagePath: string): Promise<void> {
  const client = getSupabaseAdminClient();
  await client.storage.from(bucket).remove([storagePath]).catch(() => {});
}

export async function downloadPrivateFile(
  bucket: string,
  storagePath: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error(`Private file download failed: ${sanitizeSupabaseError(error || 'Not found')}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: data.type || 'application/octet-stream'
  };
}

export async function createShortLivedSignedUrl(
  bucket: string,
  storagePath: string,
  expiresInSeconds = SIGNED_URL_TTL_SECONDS,
  downloadFilename?: string
): Promise<string | null> {
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(storagePath, expiresInSeconds, downloadFilename ? { download: downloadFilename } : undefined);
    if (error || !data?.signedUrl) {
      return null;
    }
    return data.signedUrl;
  } catch {
    return null;
  }
}

export async function createSignedPrivateUploadUrl(
  bucket: string,
  storagePath: string
): Promise<{ signedUrl: string; path: string }> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(storagePath);
  if (error || !data?.signedUrl) {
    throw new Error(`Signed upload URL creation failed (${bucket}): ${sanitizeSupabaseError(error || 'No signed URL returned')}`);
  }
  return {
    signedUrl: data.signedUrl,
    path: data.path || storagePath
  };
}

// ============================================================================
// STORE SETTINGS REPOSITORY
// ============================================================================

export async function fetchStoreSettingsRow(): Promise<StoreSettingsRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('store_settings')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read store_settings: ${sanitizeSupabaseError(error)}`);
  }
  return (data as StoreSettingsRow | null) ?? null;
}

export class SupabaseQueryError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SupabaseQueryError';
    this.code = code;
  }
}

export function isUniqueViolationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = String((err as { code?: unknown }).code || '');
  const msg = String((err as { message?: unknown }).message || '');
  return (
    code === '23505' ||
    /duplicate key value violates unique constraint/i.test(msg)
  );
}

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = String((err as { code?: unknown }).code || '');
  const msg = String((err as { message?: unknown }).message || '');
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /Could not find the '[^']+' column/i.test(msg) ||
    /column "[^"]+" of relation "[^"]+" does not exist/i.test(msg)
  );
}

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = String((err as { code?: unknown }).code || '');
  const msg = String((err as { message?: unknown }).message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /Could not find the table/i.test(msg) ||
    /relation "[^"]+" does not exist/i.test(msg)
  );
}

export async function upsertStoreSettingsRow(
  settings: EditableStoreSettings,
  updatedByStaffId?: string | null
): Promise<StoreSettingsRow> {
  const client = getSupabaseAdminClient();
  const basePayload = {
    id: 'default',
    logo_url: settings.logoUrl,
    hero_image_url: settings.heroImageUrl,
    product_images: settings.productImages,
    gallery_items: settings.galleryItems,
    delivery_rate_peninsular_sen: settings.deliveryRatesSen.peninsular,
    delivery_rate_east_malaysia_sen: settings.deliveryRatesSen.eastMalaysia,
    whatsapp_support_number: settings.whatsappSupportNumber,
    tng_override_enabled: settings.qrOverrides.tng.enabled,
    tng_override_recipient_name: settings.qrOverrides.tng.recipientName,
    tng_override_qr_image: settings.qrOverrides.tng.qrImage,
    duitnow_override_enabled: settings.qrOverrides.duitnow.enabled,
    duitnow_override_recipient_name: settings.qrOverrides.duitnow.recipientName,
    duitnow_override_qr_image: settings.qrOverrides.duitnow.qrImage,
    updated_by_staff_id: updatedByStaffId ?? null
  };
  const countryPayload = {
    ...basePayload,
    delivery_rate_singapore_cents: settings.deliveryRateSingaporeCents,
    sg_product_prices_cents: settings.sgProductPricesCents
  };
  const fullPayload = {
    ...countryPayload,
    portrait_frame_price_my_sen: settings.portraitFrameConfig.priceMySen,
    portrait_frame_price_sg_cents: settings.portraitFrameConfig.priceSgCents,
    portrait_frame_delivery_peninsular_sen: settings.portraitFrameConfig.deliveryPeninsularSen,
    portrait_frame_delivery_east_malaysia_sen: settings.portraitFrameConfig.deliveryEastMalaysiaSen,
    portrait_frame_delivery_singapore_cents: settings.portraitFrameConfig.deliverySingaporeCents,
    portrait_frame_delivery_days: settings.portraitFrameConfig.deliveryDays
  };

  const { data, error } = await client
    .from('store_settings')
    .upsert(fullPayload, { onConflict: 'id' })
    .select('*')
    .single();
  if (error && isMissingColumnError(error)) {
    const hasCustomPortraitFrameSettings =
      settings.portraitFrameConfig.priceMySen !== 19990 ||
      settings.portraitFrameConfig.priceSgCents !== 7990 ||
      settings.portraitFrameConfig.deliveryPeninsularSen !== 1200 ||
      settings.portraitFrameConfig.deliveryEastMalaysiaSen !== 2000 ||
      settings.portraitFrameConfig.deliverySingaporeCents !== 1200 ||
      settings.portraitFrameConfig.deliveryDays !== 14;

    const retryCountry = await client
      .from('store_settings')
      .upsert(countryPayload, { onConflict: 'id' })
      .select('*')
      .single();
    if (!retryCountry.error && retryCountry.data) {
      if (hasCustomPortraitFrameSettings) {
        throw new Error(
          'SCHEMA_MIGRATION_REQUIRED: Run supabase/migrations/004_portrait_frame.sql in the Supabase SQL Editor before saving custom Portrait Frame pricing, delivery charges, or delivery timeframe.'
        );
      }
      return retryCountry.data as StoreSettingsRow;
    }

    if (retryCountry.error && isMissingColumnError(retryCountry.error)) {
      if (settings.deliveryRateSingaporeCents !== null) {
        throw new Error(
          'SCHEMA_MIGRATION_REQUIRED: Run supabase/migrations/002_country_based_pricing.sql in the Supabase SQL Editor before saving Singapore delivery rates.'
        );
      }
      const fallback = await client
        .from('store_settings')
        .upsert(basePayload, { onConflict: 'id' })
        .select('*')
        .single();
      if (fallback.error || !fallback.data) {
        throw new Error(`Failed to save store_settings: ${sanitizeSupabaseError(fallback.error)}`);
      }
      return fallback.data as StoreSettingsRow;
    }

    throw new Error(`Failed to save store_settings: ${sanitizeSupabaseError(retryCountry.error)}`);
  }
  if (error || !data) {
    throw new Error(`Failed to save store_settings: ${sanitizeSupabaseError(error)}`);
  }
  return data as StoreSettingsRow;
}

// ============================================================================
// STAFF ACCOUNTS REPOSITORY
// ============================================================================

export async function listActiveStaffAccounts(): Promise<StaffAccountRow[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('staff_accounts')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`Failed to read staff_accounts: ${sanitizeSupabaseError(error)}`);
  }
  return (data as StaffAccountRow[]) || [];
}

export async function createBootstrapStaffAccount(opts: {
  username: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
}): Promise<StaffAccountRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('staff_accounts')
    .insert({
      username: opts.username,
      display_name: opts.displayName,
      role: 'admin',
      password_salt: opts.passwordSalt,
      password_hash: opts.passwordHash,
      is_active: true,
      last_login_at: new Date().toISOString()
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create staff account: ${sanitizeSupabaseError(error)}`);
  }
  return data as StaffAccountRow;
}

export async function touchStaffLastLogin(staffId: string): Promise<void> {
  const client = getSupabaseAdminClient();
  await client
    .from('staff_accounts')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', staffId);
}

export async function fetchStaffAccountById(staffId: string): Promise<StaffAccountRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('staff_accounts')
    .select('*')
    .eq('id', staffId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to verify staff account: ${sanitizeSupabaseError(error)}`);
  }
  return (data as StaffAccountRow | null) ?? null;
}

// ============================================================================
// ORDERS, PAYMENTS & EMAIL NOTIFICATIONS REPOSITORY
// ============================================================================

export async function insertOrderRow(
  input: Omit<OrderRow, 'id' | 'created_at' | 'updated_at'>
): Promise<OrderRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.from('orders').insert(input).select('*').single();
  if (error && isMissingColumnError(error)) {
    // Stage 1 fallback: strip optional 004_portrait_frame columns first so databases
    // before migration 004 continue persisting orders cleanly (pricing_breakdown still captures deliveryDays).
    const {
      personalisation_text: _pt,
      delivery_days: _dd,
      ...withoutPortraitCols
    } = input;

    const retryWithoutPortrait = await client
      .from('orders')
      .insert(withoutPortraitCols)
      .select('*')
      .single();
    if (!retryWithoutPortrait.error && retryWithoutPortrait.data) {
      return retryWithoutPortrait.data as OrderRow;
    }

    if (retryWithoutPortrait.error && isMissingColumnError(retryWithoutPortrait.error)) {
      // Stage 2 fallback: strip optional 003_meta_conversions attribution columns.
      const {
        meta_fbp: _mfbp,
        meta_fbc: _mfbc,
        meta_event_source_url: _murl,
        meta_client_ip: _mip,
        meta_client_user_agent: _mua,
        meta_marketing_consent: _mc,
        ...withoutMetaCols
      } = withoutPortraitCols;

      const retryWithoutMeta = await client
        .from('orders')
        .insert(withoutMetaCols)
        .select('*')
        .single();
      if (!retryWithoutMeta.error && retryWithoutMeta.data) {
        return retryWithoutMeta.data as OrderRow;
      }

      if (retryWithoutMeta.error && isMissingColumnError(retryWithoutMeta.error)) {
        if (input.delivery_country && input.delivery_country !== 'MY') {
          throw new Error(
            'SCHEMA_MIGRATION_REQUIRED: Run supabase/migrations/002_country_based_pricing.sql in the Supabase SQL Editor to persist Singapore (SGD) orders.'
          );
        }
        const {
          delivery_country: _dc,
          currency: _cur,
          pricing_breakdown: _pb,
          ...legacyInput
        } = withoutMetaCols;
        const fallback = await client.from('orders').insert(legacyInput).select('*').single();
        if (fallback.error || !fallback.data) {
          throw new SupabaseQueryError(
            `Failed to insert order: ${sanitizeSupabaseError(fallback.error)}`,
            (fallback.error as { code?: string } | null)?.code
          );
        }
        return fallback.data as OrderRow;
      }

      throw new SupabaseQueryError(
        `Failed to insert order: ${sanitizeSupabaseError(retryWithoutMeta.error)}`,
        (retryWithoutMeta.error as { code?: string } | null)?.code
      );
    }

    throw new SupabaseQueryError(
      `Failed to insert order: ${sanitizeSupabaseError(retryWithoutPortrait.error)}`,
      (retryWithoutPortrait.error as { code?: string } | null)?.code
    );
  }
  if (error || !data) {
    throw new SupabaseQueryError(
      `Failed to insert order: ${sanitizeSupabaseError(error)}`,
      (error as { code?: string } | null)?.code
    );
  }
  return data as OrderRow;
}

export async function fetchOrderByReference(reference: string): Promise<OrderRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('orders')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load order ${reference}: ${sanitizeSupabaseError(error)}`);
  }
  return (data as OrderRow | null) ?? null;
}

export async function updateOrderByReference(
  reference: string,
  patch: Partial<Omit<OrderRow, 'id' | 'reference' | 'created_at' | 'updated_at'>>
): Promise<OrderRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('orders')
    .update(patch)
    .eq('reference', reference)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to update order ${reference}: ${sanitizeSupabaseError(error)}`);
  }
  return data as OrderRow;
}

/**
 * Atomic conditional update that only mutates an order if payment_status != 'Paid'.
 * Returns null if the order was already marked Paid concurrently (e.g., via Stripe webhook).
 */
export async function updateOrderIfUnpaid(
  reference: string,
  patch: Partial<Omit<OrderRow, 'id' | 'reference' | 'created_at' | 'updated_at'>>
): Promise<OrderRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('orders')
    .update(patch)
    .eq('reference', reference)
    .neq('payment_status', 'Paid')
    .select('*')
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    const {
      personalisation_text: _pt,
      delivery_days: _dd,
      ...withoutPortraitPatch
    } = patch;

    const retryWithoutPortrait = await client
      .from('orders')
      .update(withoutPortraitPatch)
      .eq('reference', reference)
      .neq('payment_status', 'Paid')
      .select('*')
      .maybeSingle();

    if (!retryWithoutPortrait.error) {
      return (retryWithoutPortrait.data as OrderRow | null) ?? null;
    }

    if (isMissingColumnError(retryWithoutPortrait.error)) {
      const {
        meta_fbp: _mfbp,
        meta_fbc: _mfbc,
        meta_event_source_url: _murl,
        meta_client_ip: _mip,
        meta_client_user_agent: _mua,
        meta_marketing_consent: _mc,
        ...withoutMetaPatch
      } = withoutPortraitPatch;

      const retryWithoutMeta = await client
        .from('orders')
        .update(withoutMetaPatch)
        .eq('reference', reference)
        .neq('payment_status', 'Paid')
        .select('*')
        .maybeSingle();

      if (!retryWithoutMeta.error) {
        return (retryWithoutMeta.data as OrderRow | null) ?? null;
      }

      if (isMissingColumnError(retryWithoutMeta.error)) {
        if (patch.delivery_country && patch.delivery_country !== 'MY') {
          throw new Error(
            'SCHEMA_MIGRATION_REQUIRED: Run supabase/migrations/002_country_based_pricing.sql in the Supabase SQL Editor to update delivery country to Singapore (SGD).'
          );
        }
        const {
          delivery_country: _dc,
          currency: _cur,
          pricing_breakdown: _pb,
          ...legacyPatch
        } = withoutMetaPatch;
        const fallback = await client
          .from('orders')
          .update(legacyPatch)
          .eq('reference', reference)
          .neq('payment_status', 'Paid')
          .select('*')
          .maybeSingle();
        if (fallback.error) {
          throw new Error(`Failed to update order ${reference}: ${sanitizeSupabaseError(fallback.error)}`);
        }
        return (fallback.data as OrderRow | null) ?? null;
      }

      throw new Error(
        `Failed to update order ${reference}: ${sanitizeSupabaseError(retryWithoutMeta.error)}`
      );
    }

    throw new Error(
      `Failed to update order ${reference}: ${sanitizeSupabaseError(retryWithoutPortrait.error)}`
    );
  }
  if (error) {
    throw new Error(`Failed to update order ${reference}: ${sanitizeSupabaseError(error)}`);
  }
  return (data as OrderRow | null) ?? null;
}

export async function insertPaymentRow(
  input: Omit<PaymentRow, 'id' | 'created_at' | 'updated_at'>
): Promise<PaymentRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.from('payments').insert(input).select('*').single();
  if (error && isMissingColumnError(error)) {
    const { delivery_country: _dc, ...legacyInput } = input;
    const fallback = await client.from('payments').insert(legacyInput).select('*').single();
    if (fallback.error || !fallback.data) {
      throw new Error(`Failed to record payment: ${sanitizeSupabaseError(fallback.error)}`);
    }
    return fallback.data as PaymentRow;
  }
  if (error || !data) {
    throw new Error(`Failed to record payment: ${sanitizeSupabaseError(error)}`);
  }
  return data as PaymentRow;
}

export async function updatePaymentById(
  paymentId: string,
  patch: Partial<Omit<PaymentRow, 'id' | 'order_id' | 'order_reference' | 'created_at' | 'updated_at'>>
): Promise<PaymentRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('payments')
    .update(patch)
    .eq('id', paymentId)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to update payment: ${sanitizeSupabaseError(error)}`);
  }
  return data as PaymentRow;
}

export async function fetchPaymentsForOrder(orderId: string): Promise<PaymentRow[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('payments')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to fetch payments: ${sanitizeSupabaseError(error)}`);
  }
  return (data as PaymentRow[]) || [];
}

export async function fetchPaymentByStripeSessionId(sessionId: string): Promise<PaymentRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('payments')
    .select('*')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to look up Stripe payment session: ${sanitizeSupabaseError(error)}`);
  }
  return (data as PaymentRow | null) ?? null;
}

export async function hasProcessedStripeEvent(eventId: string): Promise<boolean> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('payments')
    .select('id')
    .eq('stripe_event_id', eventId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to check Stripe webhook idempotency: ${sanitizeSupabaseError(error)}`);
  }
  return Boolean(data);
}

export async function fetchOrderConfirmationEmail(orderId: string): Promise<EmailNotificationRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('email_notifications')
    .select('*')
    .eq('order_id', orderId)
    .eq('notification_type', 'order_confirmation')
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read email notification record: ${sanitizeSupabaseError(error)}`);
  }
  return (data as EmailNotificationRow | null) ?? null;
}

export async function upsertOrderConfirmationEmail(opts: {
  orderId: string;
  orderReference: string;
  provider: 'resend' | 'none';
  recipientEmail: string;
  senderEmail: string | null;
  subject: string;
  status: 'sending' | 'sent' | 'failed' | 'not_configured';
  providerMessageId?: string | null;
  errorMessage?: string | null;
  attemptCount: number;
  sentAt?: string | null;
  lastAttemptAt: string;
}): Promise<EmailNotificationRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('email_notifications')
    .upsert(
      {
        order_id: opts.orderId,
        order_reference: opts.orderReference,
        notification_type: 'order_confirmation',
        provider: opts.provider,
        recipient_email: opts.recipientEmail,
        sender_email: opts.senderEmail,
        subject: opts.subject,
        status: opts.status,
        provider_message_id: opts.providerMessageId ?? null,
        error_message: opts.errorMessage ?? null,
        attempt_count: opts.attemptCount,
        sent_at: opts.sentAt ?? null,
        last_attempt_at: opts.lastAttemptAt
      },
      { onConflict: 'order_id,notification_type' }
    )
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to save email notification record: ${sanitizeSupabaseError(error)}`);
  }
  return data as EmailNotificationRow;
}

export async function fetchMetaPurchaseEvent(
  orderId: string
): Promise<MetaConversionEventRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('meta_conversion_events')
    .select('*')
    .eq('order_id', orderId)
    .eq('event_name', 'Purchase')
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to read Meta conversion record: ${sanitizeSupabaseError(error)}`);
  }
  return (data as MetaConversionEventRow | null) ?? null;
}

export async function upsertMetaPurchaseEvent(opts: {
  orderId: string;
  orderReference: string;
  eventId: string;
  eventTime: number;
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  valueMinor: number;
  contentIds: string[];
  numItems: number;
  status: MetaConversionEventStatus;
  testMode: boolean;
  fbtraceId?: string | null;
  eventsReceived?: number | null;
  errorMessage?: string | null;
  attemptCount: number;
  sentAt?: string | null;
  lastAttemptAt: string;
}): Promise<MetaConversionEventRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('meta_conversion_events')
    .upsert(
      {
        order_id: opts.orderId,
        order_reference: opts.orderReference,
        event_name: 'Purchase',
        event_id: opts.eventId,
        event_time: opts.eventTime,
        delivery_country: opts.deliveryCountry,
        currency: opts.currency,
        value_minor: opts.valueMinor,
        content_ids: opts.contentIds,
        num_items: opts.numItems,
        status: opts.status,
        test_mode: opts.testMode,
        fbtrace_id: opts.fbtraceId ?? null,
        events_received: opts.eventsReceived ?? null,
        error_message: opts.errorMessage ?? null,
        attempt_count: opts.attemptCount,
        sent_at: opts.sentAt ?? null,
        last_attempt_at: opts.lastAttemptAt
      },
      { onConflict: 'order_id,event_name' }
    )
    .select('*')
    .single();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to save Meta conversion record: ${sanitizeSupabaseError(error)}`);
  }
  return (data as MetaConversionEventRow | null) ?? null;
}

export async function listRecentMetaConversionEvents(
  limit = 25
): Promise<MetaConversionEventRow[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from('meta_conversion_events')
    .select('*')
    .order('last_attempt_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to load Meta conversion events: ${sanitizeSupabaseError(error)}`);
  }
  return (data as MetaConversionEventRow[]) || [];
}

export async function fetchHydratedOrderByReference(reference: string): Promise<HydratedOrder | null> {
  const order = await fetchOrderByReference(reference);
  if (!order) return null;

  const [payments, confirmationEmail, metaPurchaseEvent] = await Promise.all([
    fetchPaymentsForOrder(order.id),
    fetchOrderConfirmationEmail(order.id),
    fetchMetaPurchaseEvent(order.id).catch(() => null)
  ]);

  const latestPayment = payments[0] ?? null;
  const latestReceiptPayment = payments.find(p => Boolean(p.receipt_storage_path)) ?? null;

  return {
    order,
    latestPayment,
    latestReceiptPayment,
    confirmationEmail,
    metaPurchaseEvent
  };
}

export async function listHydratedOrders(): Promise<HydratedOrder[]> {
  const client = getSupabaseAdminClient();
  const [
    { data: orderRows, error: ordersErr },
    { data: paymentRows, error: paymentsErr },
    { data: emailRows, error: emailsErr },
    metaResult
  ] = await Promise.all([
    client.from('orders').select('*').order('created_at', { ascending: false }),
    client.from('payments').select('*').order('created_at', { ascending: false }),
    client
      .from('email_notifications')
      .select('*')
      .eq('notification_type', 'order_confirmation'),
    client
      .from('meta_conversion_events')
      .select('*')
      .eq('event_name', 'Purchase')
  ]);

  if (ordersErr) {
    throw new Error(`Failed to load orders: ${sanitizeSupabaseError(ordersErr)}`);
  }
  if (paymentsErr) {
    throw new Error(`Failed to load payments: ${sanitizeSupabaseError(paymentsErr)}`);
  }
  if (emailsErr) {
    throw new Error(`Failed to load email notifications: ${sanitizeSupabaseError(emailsErr)}`);
  }
  if (metaResult.error && !isMissingTableError(metaResult.error)) {
    throw new Error(
      `Failed to load Meta conversion events: ${sanitizeSupabaseError(metaResult.error)}`
    );
  }

  const paymentsByOrder = new Map<string, PaymentRow[]>();
  for (const row of (paymentRows as PaymentRow[]) || []) {
    const existing = paymentsByOrder.get(row.order_id);
    if (existing) existing.push(row);
    else paymentsByOrder.set(row.order_id, [row]);
  }

  const emailByOrder = new Map<string, EmailNotificationRow>();
  for (const row of (emailRows as EmailNotificationRow[]) || []) {
    emailByOrder.set(row.order_id, row);
  }

  const metaByOrder = new Map<string, MetaConversionEventRow>();
  if (!metaResult.error) {
    for (const row of (metaResult.data as MetaConversionEventRow[]) || []) {
      metaByOrder.set(row.order_id, row);
    }
  }

  return ((orderRows as OrderRow[]) || []).map(order => {
    const orderPayments = paymentsByOrder.get(order.id) || [];
    return {
      order,
      latestPayment: orderPayments[0] ?? null,
      latestReceiptPayment: orderPayments.find(p => Boolean(p.receipt_storage_path)) ?? null,
      confirmationEmail: emailByOrder.get(order.id) ?? null,
      metaPurchaseEvent: metaByOrder.get(order.id) ?? null
    };
  });
}
