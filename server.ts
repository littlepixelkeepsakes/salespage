import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import type {
  EditableStoreSettings,
  PaymentMethodKey,
  StoreGalleryImage,
  SupabaseHealthDiagnostic
} from './src/types/order';
import {
  checkSupabaseHealth,
  clearSupabaseHealthCache,
  createBootstrapStaffAccount,
  createShortLivedSignedUrl,
  downloadPrivateFile,
  fetchHydratedOrderByReference,
  fetchOrderByReference,
  fetchOrderConfirmationEmail,
  fetchPaymentByStripeSessionId,
  fetchPaymentsForOrder,
  fetchStoreSettingsRow,
  getSupabaseEnvConfig,
  hasProcessedStripeEvent,
  insertOrderRow,
  insertPaymentRow,
  listActiveStaffAccounts,
  listHydratedOrders,
  movePrivateFile,
  removePrivateFile,
  sanitizeSupabaseError,
  touchStaffLastLogin,
  updateOrderByReference,
  updatePaymentById,
  uploadPrivateFile,
  upsertOrderConfirmationEmail,
  upsertStoreSettingsRow,
  type HydratedOrder,
  type OrderRow,
  type StoreSettingsRow
} from './src/server/supabase';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DELIVERY_PROMISE_TEXT =
  'Your order will be delivered within 14 days after your payment is confirmed and we receive a usable photo.';
const PAID_CONFIRMATION_HEADING = 'Thank you! Your order is confirmed.';

// Public storefront static directories (NEVER used for customer photos or payment receipts)
const publicDir = path.resolve(__dirname, 'public');
const distDir = path.resolve(__dirname, 'dist');
const publicPaymentsDir = path.resolve(publicDir, 'payments');
const publicStorefrontAssetsDir = path.resolve(publicDir, 'assets', 'storefront');

for (const dir of [publicPaymentsDir, publicStorefrontAssetsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Shared product & bundle pricing configuration in integer sen (RM)
const PRODUCT_CONFIG: Record<string, { name: string; priceSen: number; regularSen?: number }> = {
  keychain: { name: 'Keychain', priceSen: 2990 },
  magnet: { name: 'Fridge Magnet', priceSen: 3190 },
  bundle_2_keychains: { name: '2-Piece Bundle (2 Keychains)', priceSen: 4784, regularSen: 5980 },
  bundle_kc_magnet: { name: '2-Piece Bundle (1 Keychain + 1 Fridge Magnet)', priceSen: 4944, regularSen: 6180 },
  bundle_2_magnets: { name: '2-Piece Bundle (2 Fridge Magnets)', priceSen: 5104, regularSen: 6380 }
};

const PENINSULAR_STATES = new Set([
  'johor',
  'kedah',
  'kelantan',
  'melaka',
  'negeri sembilan',
  'pahang',
  'perak',
  'perlis',
  'penang',
  'pulau pinang',
  'selangor',
  'terengganu',
  'kuala lumpur',
  'putrajaya'
]);

const EAST_MALAYSIA_STATES = new Set(['sabah', 'sarawak', 'labuan']);

const ORDER_REF_REGEX = /^LPK-\d{4}-[A-Z0-9]{6,10}$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_LOGIN_ATTEMPTS = 10;
const PHOTO_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_UPLOAD_SESSIONS_PER_WINDOW = 30;

function getDefaultStoreSettings(): EditableStoreSettings {
  return {
    logoUrl: '/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png',
    heroImageUrl: '/src/assets/images/hero_bead_art_showcase_1795515646405.jpg',
    productImages: {
      keychain: '/src/assets/images/pet_bead_art_1795515646980.jpg',
      magnet: '/src/assets/images/couple_bead_art_1795515653017.jpg',
      bundle: '/src/assets/images/family_bead_art_1795515653155.jpg'
    },
    galleryItems: [
      {
        id: 'pet',
        category: 'Pet Portrait',
        title: 'Golden Retriever Buddy',
        description: 'Turned from a smartphone portrait into a vibrant beaded keychain.',
        image: '/src/assets/images/pet_bead_art_1795515646980.jpg',
        tag: 'Popular'
      },
      {
        id: 'couple',
        category: 'Couple Keepsake',
        title: 'Anniversary Memory',
        description: 'Crafted into a charming fridge magnet with pastel cloud and heart details.',
        image: '/src/assets/images/couple_bead_art_1795515653017.jpg',
        tag: 'Best Seller'
      },
      {
        id: 'family',
        category: 'Family Portrait',
        title: 'Weekend Family Outing',
        description: 'Detailed multi-person pixel bead art keepsake mounted in a wooden frame.',
        image: '/src/assets/images/family_bead_art_1795515653155.jpg',
        tag: 'Special Gift'
      }
    ],
    deliveryRatesSen: {
      peninsular: 800,
      eastMalaysia: 1500
    },
    whatsappSupportNumber: (process.env.WHATSAPP_SUPPORT_NUMBER || '').replace(/\D/g, ''),
    qrOverrides: {
      tng: { enabled: null, recipientName: '', qrImage: '' },
      duitnow: { enabled: null, recipientName: '', qrImage: '' }
    }
  };
}

function mapStoreSettingsRow(row?: StoreSettingsRow | null): EditableStoreSettings {
  const defaults = getDefaultStoreSettings();
  if (!row) return defaults;
  return {
    logoUrl: row.logo_url?.trim() || defaults.logoUrl,
    heroImageUrl: row.hero_image_url?.trim() || defaults.heroImageUrl,
    productImages: {
      keychain: row.product_images?.keychain?.trim() || defaults.productImages.keychain,
      magnet: row.product_images?.magnet?.trim() || defaults.productImages.magnet,
      bundle: row.product_images?.bundle?.trim() || defaults.productImages.bundle
    },
    galleryItems:
      Array.isArray(row.gallery_items) && row.gallery_items.length > 0
        ? row.gallery_items.slice(0, 6).map((item, idx) => {
            const fallback = defaults.galleryItems[idx] || defaults.galleryItems[0];
            return {
              id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : fallback.id,
              category:
                typeof item?.category === 'string' && item.category.trim()
                  ? item.category.trim().slice(0, 60)
                  : fallback.category,
              title:
                typeof item?.title === 'string' && item.title.trim()
                  ? item.title.trim().slice(0, 80)
                  : fallback.title,
              description:
                typeof item?.description === 'string' && item.description.trim()
                  ? item.description.trim().slice(0, 240)
                  : fallback.description,
              image:
                typeof item?.image === 'string' && item.image.trim()
                  ? item.image.trim()
                  : fallback.image,
              tag:
                typeof item?.tag === 'string' && item.tag.trim()
                  ? item.tag.trim().slice(0, 40)
                  : fallback.tag
            };
          })
        : defaults.galleryItems,
    deliveryRatesSen: {
      peninsular:
        Number.isInteger(row.delivery_rate_peninsular_sen) && row.delivery_rate_peninsular_sen >= 0
          ? row.delivery_rate_peninsular_sen
          : defaults.deliveryRatesSen.peninsular,
      eastMalaysia:
        Number.isInteger(row.delivery_rate_east_malaysia_sen) && row.delivery_rate_east_malaysia_sen >= 0
          ? row.delivery_rate_east_malaysia_sen
          : defaults.deliveryRatesSen.eastMalaysia
    },
    whatsappSupportNumber: (row.whatsapp_support_number || '').replace(/\D/g, '').slice(0, 20),
    qrOverrides: {
      tng: {
        enabled: typeof row.tng_override_enabled === 'boolean' ? row.tng_override_enabled : null,
        recipientName: (row.tng_override_recipient_name || '').trim().slice(0, 140),
        qrImage: (row.tng_override_qr_image || '').trim()
      },
      duitnow: {
        enabled: typeof row.duitnow_override_enabled === 'boolean' ? row.duitnow_override_enabled : null,
        recipientName: (row.duitnow_override_recipient_name || '').trim().slice(0, 140),
        qrImage: (row.duitnow_override_qr_image || '').trim()
      }
    }
  };
}

// Transient in-memory locks & short-lived session caches (all persistent records live in Supabase)
const inFlightConfirmationEmails: Set<string> = new Set();

interface AdminSessionRecord {
  staffId: string | null;
  username: string;
  expiresAt: number;
}
const adminSessions: Map<string, AdminSessionRecord> = new Map();
const failedLoginTracker: Map<string, { count: number; resetAt: number }> = new Map();

interface PhotoUploadSessionRecord {
  sessionId: string;
  token: string;
  expiresAt: number;
  photoStoragePath: string | null;
  photoOriginalFilename: string | null;
  photoMimeType: 'image/jpeg' | 'image/png' | null;
  photoSizeBytes: number | null;
}
const photoUploadSessions: Map<string, PhotoUploadSessionRecord> = new Map();
const uploadSessionRateTracker: Map<string, { count: number; resetAt: number }> = new Map();

function pruneExpiredUploadSessions(): void {
  const now = Date.now();
  for (const [token, session] of photoUploadSessions.entries()) {
    if (session.expiresAt < now) {
      photoUploadSessions.delete(token);
      if (session.photoStoragePath) {
        const cfg = getSupabaseEnvConfig();
        if (cfg.valid) {
          void removePrivateFile(cfg.photosBucket, session.photoStoragePath);
        }
      }
    }
  }
}

function hashPasscode(passcode: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return { salt, hash: derived };
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRM(sen: number): string {
  return `RM ${(sen / 100).toFixed(2)}`;
}

function getDeliveryConfigForState(
  state: string,
  settings: EditableStoreSettings
): { zone: string; rateSen: number } | null {
  const normalized = state.trim().toLowerCase();
  if (PENINSULAR_STATES.has(normalized)) {
    return { zone: 'Peninsular Malaysia', rateSen: settings.deliveryRatesSen.peninsular };
  }
  if (EAST_MALAYSIA_STATES.has(normalized)) {
    return { zone: 'Sabah & Sarawak', rateSen: settings.deliveryRatesSen.eastMalaysia };
  }
  return null;
}

function createAdminSession(staffId: string | null, username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    staffId,
    username,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
  return token;
}

function getPaymentMethodDisplayLabel(method?: PaymentMethodKey | null): string | null {
  if (method === 'tng') return 'Touch ’n Go eWallet QR';
  if (method === 'duitnow') return 'Public Bank QR Pay';
  if (method === 'card') return 'Credit or Debit Card (Stripe)';
  return null;
}

function toPublicOrder(hydrated: HydratedOrder, photoUrl: string) {
  const { order, latestPayment, latestReceiptPayment, confirmationEmail } = hydrated;
  const activeManualPayment = latestReceiptPayment || latestPayment;
  return {
    reference: order.reference,
    accessToken: order.access_token,
    productId: order.product_id,
    bundleId: order.bundle_id ?? undefined,
    productName: order.product_name,
    itemQuantity: order.item_quantity,
    subtotalSen: order.subtotal_sen,
    regularSubtotalSen: order.regular_subtotal_sen ?? undefined,
    savingsSen: order.savings_sen ?? undefined,
    deliveryFeeSen: order.delivery_fee_sen,
    totalSen: order.total_sen,
    photoUrl,
    photoFileName: order.photo_original_filename ?? undefined,
    customer: {
      fullName: order.customer_full_name,
      email: order.customer_email,
      mobile: order.customer_mobile,
      address: order.customer_address,
      postcode: order.customer_postcode,
      city: order.customer_city,
      state: order.customer_state
    },
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method ?? null,
    paymentMethodLabel: getPaymentMethodDisplayLabel(order.payment_method),
    transactionReference: activeManualPayment?.transaction_reference ?? undefined,
    receiptSubmitted: Boolean(latestReceiptPayment?.receipt_storage_path),
    receiptFileName: latestReceiptPayment?.receipt_original_filename ?? undefined,
    receiptMimeType: latestReceiptPayment?.receipt_mime_type ?? undefined,
    receiptUploadedAt: latestReceiptPayment?.receipt_uploaded_at ?? undefined,
    paidAt: order.paid_at ?? undefined,
    verifiedByStaff: Boolean(order.verified_by_staff),
    verificationNote: order.verification_note ?? undefined,
    correctionReason: order.correction_reason ?? undefined,
    lastCardAttemptMessage: order.last_card_attempt_message ?? undefined,
    confirmationEmailStatus:
      confirmationEmail?.status === 'sending' ? null : (confirmationEmail?.status ?? null),
    confirmationEmailSentAt: confirmationEmail?.sent_at ?? undefined,
    createdAt: order.created_at
  };
}

// Admin order serializer: includes sanitized email delivery error details for authorised staff only
function toAdminOrder(hydrated: HydratedOrder, signedPhotoUrl: string) {
  const { confirmationEmail } = hydrated;
  return {
    ...toPublicOrder(hydrated, signedPhotoUrl),
    confirmationEmailError: confirmationEmail?.error_message ?? undefined,
    confirmationEmailLastAttemptAt: confirmationEmail?.last_attempt_at ?? undefined
  };
}

function buildCustomerAuthorizedPhotoUrl(order: OrderRow): string {
  return `/api/orders/${encodeURIComponent(order.reference)}/photo?token=${encodeURIComponent(order.access_token)}`;
}

async function resolveAdminOrderPhotoUrl(order: OrderRow): Promise<string> {
  if (!order.photo_storage_path) return '';
  const signed = await createShortLivedSignedUrl(
    order.photo_storage_bucket,
    order.photo_storage_path,
    300
  );
  return signed || '';
}

function extractOrderToken(req: express.Request): string {
  const headerToken = typeof req.headers['x-order-token'] === 'string' ? req.headers['x-order-token'] : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const bodyToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken : '';
  return (headerToken || queryToken || bodyToken).trim();
}

function isOrderAuthorized(req: express.Request, order: OrderRow): boolean {
  const token = extractOrderToken(req);
  if (!token || !order.access_token) return false;
  return safeEqualStrings(token, order.access_token);
}

// Validate that a storefront/QR image path is a local public asset or https:// URL
function validateImageSource(
  rawUrl: string,
  allowedPrefixes: Array<'/payments/' | '/assets/' | '/src/assets/'>
): { valid: boolean; normalizedUrl?: string; reason?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Image path is empty.' };
  }
  if (trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') {
        return { valid: true, normalizedUrl: trimmed };
      }
      return { valid: false, reason: 'Image URL must use https://.' };
    } catch {
      return { valid: false, reason: 'Image URL is not a valid URL.' };
    }
  }

  let normalized = trimmed;
  if (normalized.startsWith('/public/payments/')) normalized = normalized.slice('/public'.length);
  else if (normalized.startsWith('public/payments/')) normalized = '/' + normalized.slice('public/'.length);
  else if (normalized.startsWith('payments/')) normalized = '/' + normalized;
  else if (normalized.startsWith('/public/assets/')) normalized = normalized.slice('/public'.length);
  else if (normalized.startsWith('public/assets/')) normalized = '/' + normalized.slice('public/'.length);
  else if (normalized.startsWith('assets/')) normalized = '/' + normalized;
  else if (normalized.startsWith('src/assets/')) normalized = '/' + normalized;

  const prefixToDir: Record<string, string> = {
    '/payments/': publicPaymentsDir,
    '/assets/': path.resolve(publicDir, 'assets'),
    '/src/assets/': path.resolve(__dirname, 'src/assets')
  };

  for (const prefix of allowedPrefixes) {
    if (normalized.startsWith(prefix)) {
      const baseDir = prefixToDir[prefix];
      const resolved =
        prefix === '/src/assets/'
          ? path.resolve(__dirname, normalized.slice(1))
          : path.resolve(publicDir, normalized.slice(1));
      if (!resolved.startsWith(baseDir + path.sep)) {
        return { valid: false, reason: `Image path escapes ${prefix}.` };
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { valid: false, reason: `Image file not found at ${normalized}.` };
      }
      return { valid: true, normalizedUrl: normalized };
    }
  }

  return {
    valid: false,
    reason: `Image must be a local path under ${allowedPrefixes.join(', ')} or an https:// URL.`
  };
}

function validateQrImageSource(qrImage: string) {
  return validateImageSource(qrImage, ['/payments/', '/assets/', '/src/assets/']);
}

function validateStorefrontAssetSource(imagePath: string) {
  return validateImageSource(imagePath, ['/assets/', '/src/assets/', '/payments/']);
}

interface ConfiguredQrMethod {
  configured: true;
  key: 'tng' | 'duitnow';
  label: string;
  shortAccountName: string;
  recipientName: string;
  qrImage: string;
}

interface QrMethodEvaluation {
  config: ConfiguredQrMethod | null;
  diagnostic: {
    key: 'tng' | 'duitnow';
    label: string;
    configured: boolean;
    enabled: boolean;
    issues: string[];
    recipientName: string | null;
    qrImage: string | null;
  };
}

function evaluateQrMethod(opts: {
  key: 'tng' | 'duitnow';
  label: string;
  shortAccountName: string;
  enabledVarName: string;
  recipientVarName: string;
  imageVarName: string;
  enabledEnv?: string;
  recipientEnv?: string;
  imageEnv?: string;
  override: { enabled: boolean | null; recipientName: string; qrImage: string };
  supabaseReady: boolean;
  supabaseIssue?: string;
}): QrMethodEvaluation {
  const issues: string[] = [];

  let enabled = false;
  if (typeof opts.override.enabled === 'boolean') {
    enabled = opts.override.enabled;
    if (!enabled) {
      issues.push(`${opts.label} is disabled in Admin Settings.`);
    }
  } else {
    const rawEnabled = (opts.enabledEnv ?? '').trim().toLowerCase();
    if (!rawEnabled) {
      issues.push(`${opts.enabledVarName} is missing or empty. Set to true to enable.`);
    } else if (rawEnabled === 'true' || rawEnabled === '1' || rawEnabled === 'yes') {
      enabled = true;
    } else if (rawEnabled === 'false' || rawEnabled === '0' || rawEnabled === 'no') {
      issues.push(`${opts.enabledVarName} is disabled (${opts.enabledEnv?.trim()}).`);
    } else {
      issues.push(
        `${opts.enabledVarName} has invalid boolean value "${opts.enabledEnv?.trim()}". Use true or false.`
      );
    }
  }

  const recipientName = (opts.override.recipientName || opts.recipientEnv || '').trim();
  const rawQrImage = (opts.override.qrImage || opts.imageEnv || '').trim();
  let resolvedQrImage = rawQrImage;

  if (!recipientName) {
    issues.push(`${opts.recipientVarName} is missing or empty.`);
  }

  if (!rawQrImage) {
    issues.push(`${opts.imageVarName} is missing or empty.`);
  } else {
    const imgCheck = validateQrImageSource(rawQrImage);
    if (!imgCheck.valid) {
      issues.push(`${opts.imageVarName} is invalid: ${imgCheck.reason}`);
    } else if (imgCheck.normalizedUrl) {
      resolvedQrImage = imgCheck.normalizedUrl;
    }
  }

  if (!opts.supabaseReady) {
    issues.push(opts.supabaseIssue || 'Supabase database and private receipts bucket must be configured.');
  }

  const configured = enabled && issues.length === 0;

  return {
    config: configured
      ? {
          configured: true,
          key: opts.key,
          label: opts.label,
          shortAccountName: opts.shortAccountName,
          recipientName,
          qrImage: resolvedQrImage
        }
      : null,
    diagnostic: {
      key: opts.key,
      label: opts.label,
      configured,
      enabled,
      issues,
      recipientName: recipientName || null,
      qrImage: resolvedQrImage || null
    }
  };
}

function getStripeConfig(supabaseHealth: SupabaseHealthDiagnostic): {
  client: Stripe | null;
  mode: 'test' | 'live' | 'unconfigured';
  webhookConfigured: boolean;
  livePaymentsEnabled: boolean;
  error?: string;
} {
  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const webhookConfigured = webhookSecret.length > 0;
  const livePaymentsEnabled = (process.env.ENABLE_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true';

  if (!secretKey) {
    return {
      client: null,
      mode: 'unconfigured',
      webhookConfigured,
      livePaymentsEnabled,
      error: 'Add STRIPE_SECRET_KEY (sk_test_...) on the server to enable card payments.'
    };
  }

  if (
    !secretKey.startsWith('sk_test_') &&
    !secretKey.startsWith('sk_live_') &&
    !secretKey.startsWith('rk_test_') &&
    !secretKey.startsWith('rk_live_')
  ) {
    return {
      client: null,
      mode: 'unconfigured',
      webhookConfigured,
      livePaymentsEnabled,
      error: 'Invalid STRIPE_SECRET_KEY format configured on the server.'
    };
  }

  const isLiveKey = secretKey.includes('_live_');
  const mode: 'test' | 'live' = isLiveKey ? 'live' : 'test';

  if (!supabaseHealth.configured) {
    return {
      client: null,
      mode,
      webhookConfigured,
      livePaymentsEnabled,
      error: supabaseHealth.issue || 'Supabase database and private storage must be configured before enabling payments.'
    };
  }

  if (isLiveKey) {
    if (!livePaymentsEnabled) {
      return {
        client: null,
        mode: 'live',
        webhookConfigured,
        livePaymentsEnabled,
        error: 'Live Stripe payments stay disabled until ENABLE_LIVE_PAYMENTS=true is explicitly set.'
      };
    }
    if (!webhookConfigured) {
      return {
        client: null,
        mode: 'live',
        webhookConfigured,
        livePaymentsEnabled,
        error: 'Live Stripe payments stay disabled until STRIPE_WEBHOOK_SECRET is configured.'
      };
    }
  }

  const client = new Stripe(secretKey);
  return {
    client,
    mode,
    webhookConfigured,
    livePaymentsEnabled,
    error: !webhookConfigured
      ? 'STRIPE_WEBHOOK_SECRET is not set yet (required for automatic webhook confirmation).'
      : undefined
  };
}

function isValidEmailFromHeader(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254 || /[\r\n]/.test(trimmed)) return false;
  return /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(trimmed);
}

function sanitizeEmailError(raw: unknown): string {
  const text = String(raw || 'Email delivery failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bre_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'Email delivery failed').slice(0, 240);
}

// Resend-only email configuration (no SMTP settings)
function getEmailConfig(): {
  configured: boolean;
  provider: 'resend' | 'none';
  fromAddress: string | null;
  issue?: string;
} {
  const fromAddress = (process.env.EMAIL_FROM || '').trim();
  const hasValidFrom = isValidEmailFromHeader(fromAddress);
  const resendKey = (process.env.RESEND_API_KEY || '').trim();

  if (resendKey) {
    if (!fromAddress) {
      return {
        configured: false,
        provider: 'resend',
        fromAddress: null,
        issue: 'RESEND_API_KEY is set, but EMAIL_FROM is missing.'
      };
    }
    if (!hasValidFrom) {
      return {
        configured: false,
        provider: 'resend',
        fromAddress: null,
        issue: 'EMAIL_FROM must be a valid sender address (e.g. Little Pixel Keepsakes <orders@yourdomain.com>).'
      };
    }
    return { configured: true, provider: 'resend', fromAddress };
  }

  return {
    configured: false,
    provider: 'none',
    fromAddress: hasValidFrom ? fromAddress : null,
    issue: fromAddress
      ? hasValidFrom
        ? 'EMAIL_FROM is set, but RESEND_API_KEY is missing on the server.'
        : 'EMAIL_FROM is invalid and RESEND_API_KEY is missing on the server.'
      : 'Set RESEND_API_KEY and EMAIL_FROM on the server to send paid confirmation emails via Resend.'
  };
}

async function loadCurrentStoreSettings(
  supabaseHealth?: SupabaseHealthDiagnostic
): Promise<{ settings: EditableStoreSettings; supabase: SupabaseHealthDiagnostic }> {
  const health = supabaseHealth || (await checkSupabaseHealth());
  if (!health.databaseReady) {
    return { settings: getDefaultStoreSettings(), supabase: health };
  }
  try {
    const row = await fetchStoreSettingsRow();
    return { settings: mapStoreSettingsRow(row), supabase: health };
  } catch (err) {
    const errMsg = sanitizeSupabaseError(err);
    clearSupabaseHealthCache();
    return {
      settings: getDefaultStoreSettings(),
      supabase: {
        ...health,
        configured: false,
        databaseReady: false,
        issues: [...health.issues, errMsg],
        issue: errMsg
      }
    };
  }
}

async function evaluateAllPaymentMethods(forceHealthRefresh = false) {
  const supabaseHealth = await checkSupabaseHealth(forceHealthRefresh);
  const { settings, supabase } = await loadCurrentStoreSettings(supabaseHealth);

  // 1. Touch 'n Go eWallet QR — evaluated independently
  const tngEval = evaluateQrMethod({
    key: 'tng',
    label: 'Touch ’n Go eWallet QR',
    shortAccountName: 'TNG (Touch ’n Go eWallet)',
    enabledVarName: 'TNG_ENABLED',
    recipientVarName: 'TNG_RECIPIENT_NAME',
    imageVarName: 'TNG_QR_IMAGE',
    enabledEnv: process.env.TNG_ENABLED,
    recipientEnv: process.env.TNG_RECIPIENT_NAME,
    imageEnv: process.env.TNG_QR_IMAGE,
    override: settings.qrOverrides.tng,
    supabaseReady: supabase.configured,
    supabaseIssue: supabase.issue
  });

  // 2. Public Bank QR Pay — evaluated independently
  const duitnowEval = evaluateQrMethod({
    key: 'duitnow',
    label: 'Public Bank QR Pay',
    shortAccountName: 'Public Bank (QR Pay)',
    enabledVarName: 'DUITNOW_ENABLED',
    recipientVarName: 'DUITNOW_RECIPIENT_NAME',
    imageVarName: 'DUITNOW_QR_IMAGE',
    enabledEnv: process.env.DUITNOW_ENABLED,
    recipientEnv: process.env.DUITNOW_RECIPIENT_NAME,
    imageEnv: process.env.DUITNOW_QR_IMAGE,
    override: settings.qrOverrides.duitnow,
    supabaseReady: supabase.configured,
    supabaseIssue: supabase.issue
  });

  // 3. Credit or Debit Card (Stripe) — evaluated independently
  const stripeInfo = getStripeConfig(supabase);
  // 4. Paid confirmation email (Resend) — independent of payment & storage config
  const emailInfo = getEmailConfig();

  return {
    settings,
    supabase,
    merchantConfig: {
      tng: tngEval.config,
      duitnow: duitnowEval.config,
      stripe: {
        configured: Boolean(stripeInfo.client),
        mode: stripeInfo.mode
      }
    },
    diagnostics: {
      tng: tngEval.diagnostic,
      duitnow: duitnowEval.diagnostic,
      stripe: {
        configured: Boolean(stripeInfo.client),
        mode: stripeInfo.mode,
        webhookConfigured: stripeInfo.webhookConfigured,
        livePaymentsEnabled: stripeInfo.livePaymentsEnabled,
        issue: stripeInfo.error
      },
      email: emailInfo,
      supabase
    }
  };
}

function getPublicStorefrontConfig(settings: EditableStoreSettings) {
  const digits = settings.whatsappSupportNumber.replace(/\D/g, '');
  const whatsappUrl = digits.length >= 8 ? `https://wa.me/${digits}` : null;
  return {
    logoUrl: settings.logoUrl,
    heroImageUrl: settings.heroImageUrl,
    productImages: settings.productImages,
    galleryItems: settings.galleryItems,
    deliveryRatesSen: settings.deliveryRatesSen,
    whatsappSupportNumber: digits,
    whatsappUrl,
    deliveryPromiseText: DELIVERY_PROMISE_TEXT
  };
}

// Verify file magic bytes so spoofed MIME types are rejected
function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  return false;
}

function resolveTrustedOrigin(req?: express.Request): string {
  const configuredAppUrl = (process.env.APP_URL || '').trim();
  if (configuredAppUrl) {
    try {
      const parsed = new URL(configuredAppUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // Fall through to request host detection
    }
  }
  if (!req) return 'http://localhost:3000';
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const rawHost = forwardedHost || req.headers.host || 'localhost:3000';
  const safeHost = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost:3000';
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : req.protocol === 'https'
        ? 'https'
        : 'http';
  return `${proto}://${safeHost}`;
}

function sanitizeDisplayFilename(raw: unknown, fallbackBase: string, fallbackExt: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return `${fallbackBase}.${fallbackExt}`;
  }
  const base = path.basename(raw.trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || `${fallbackBase}.${fallbackExt}`;
}

function buildConfirmationEmailContent(order: OrderRow, originUrl: string) {
  const orderLink = `${originUrl}/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.access_token)}`;
  const methodLabel = getPaymentMethodDisplayLabel(order.payment_method) || 'Confirmed payment';
  const totalPaid = formatRM(order.total_sen);
  const subject = `Order Confirmed — Little Pixel Keepsakes (${order.reference})`;

  const text = [
    PAID_CONFIRMATION_HEADING,
    '',
    `Hi ${order.customer_full_name},`,
    '',
    `Order Reference: ${order.reference}`,
    `Items: ${order.product_name} (Qty ${order.item_quantity})`,
    `Total Paid: ${totalPaid}`,
    `Payment Method: ${methodLabel}`,
    '',
    DELIVERY_PROMISE_TEXT,
    '',
    `View your order status anytime: ${orderLink}`,
    '',
    'Thank you for supporting Little Pixel Keepsakes!'
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #14233C; max-width: 560px; margin: 0 auto; padding: 24px; background: #FAF6EE; border-radius: 16px;">
      <h1 style="font-size: 22px; margin: 0 0 12px; color: #14233C;">${escapeHtml(PAID_CONFIRMATION_HEADING)}</h1>
      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Hi ${escapeHtml(order.customer_full_name)},</p>
      <div style="background: #FFFFFF; border: 1px solid rgba(20,35,60,0.12); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Order Reference:</strong> <span style="font-family: monospace;">${escapeHtml(order.reference)}</span></p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Items:</strong> ${escapeHtml(order.product_name)} (Qty ${order.item_quantity})</p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Total Paid:</strong> ${escapeHtml(totalPaid)}</p>
        <p style="margin: 0; font-size: 13px;"><strong>Payment Method:</strong> ${escapeHtml(methodLabel)}</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 20px; font-weight: 600;">${escapeHtml(DELIVERY_PROMISE_TEXT)}</p>
      <p style="margin: 0 0 16px;">
        <a href="${escapeHtml(orderLink)}" style="display: inline-block; background: #14233C; color: #FFFFFF; text-decoration: none; font-weight: 700; font-size: 13px; padding: 10px 18px; border-radius: 10px;">View Order Status</a>
      </p>
      <p style="font-size: 12px; color: #526075; margin: 0;">Little Pixel Keepsakes · Handmade in Malaysia</p>
    </div>
  `.trim();

  return { subject, text, html };
}

// Guaranteed at-most-once Resend confirmation email per paid order, tracked in public.email_notifications.
// Never mutates order.payment_status or blocks payment/storage availability.
async function sendOrderConfirmationEmailOnce(
  order: OrderRow,
  req?: express.Request
): Promise<{
  sent: boolean;
  skipped?: boolean;
  status: 'sent' | 'not_configured' | 'failed';
  error?: string;
}> {
  if (order.payment_status !== 'Paid') {
    return { sent: false, skipped: true, status: 'not_configured' };
  }
  if (inFlightConfirmationEmails.has(order.reference)) {
    return { sent: false, skipped: true, status: 'sent' };
  }

  const existing = await fetchOrderConfirmationEmail(order.id).catch(() => null);
  if (existing?.sent_at || existing?.status === 'sent') {
    return { sent: false, skipped: true, status: 'sent' };
  }

  const originUrl = resolveTrustedOrigin(req);
  const { subject, text, html } = buildConfirmationEmailContent(order, originUrl);
  const attemptCount = (existing?.attempt_count || 0) + 1;
  const attemptTime = new Date().toISOString();

  const emailCfg = getEmailConfig();
  if (!emailCfg.configured || !emailCfg.fromAddress) {
    const safeMsg = sanitizeEmailError(
      emailCfg.issue || 'Set RESEND_API_KEY and EMAIL_FROM on the server to send confirmation emails via Resend.'
    );
    await upsertOrderConfirmationEmail({
      orderId: order.id,
      orderReference: order.reference,
      provider: emailCfg.provider,
      recipientEmail: order.customer_email,
      senderEmail: emailCfg.fromAddress,
      subject,
      status: 'not_configured',
      errorMessage: safeMsg,
      attemptCount,
      lastAttemptAt: attemptTime
    }).catch(err => console.error(`Failed to record email status for ${order.reference}:`, err));
    return { sent: false, status: 'not_configured', error: safeMsg };
  }

  inFlightConfirmationEmails.add(order.reference);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: emailCfg.fromAddress,
        to: [order.customer_email],
        subject,
        text,
        html
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '');
      let detail = rawBody;
      try {
        const parsedErr = JSON.parse(rawBody) as { message?: string; name?: string };
        if (parsedErr?.message) detail = parsedErr.message;
      } catch {
        // Keep raw body
      }
      throw new Error(`Resend HTTP ${response.status}: ${detail || response.statusText || 'Request failed'}`);
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    const sentAt = new Date().toISOString();
    await upsertOrderConfirmationEmail({
      orderId: order.id,
      orderReference: order.reference,
      provider: 'resend',
      recipientEmail: order.customer_email,
      senderEmail: emailCfg.fromAddress,
      subject,
      status: 'sent',
      providerMessageId: data.id || `resend_${Date.now()}`,
      errorMessage: null,
      attemptCount,
      sentAt,
      lastAttemptAt: attemptTime
    });
    return { sent: true, status: 'sent' };
  } catch (err: any) {
    const safeError = sanitizeEmailError(err?.message || err || 'Email delivery failed');
    console.error(`Confirmation email failed for order ${order.reference}: ${safeError}`);
    await upsertOrderConfirmationEmail({
      orderId: order.id,
      orderReference: order.reference,
      provider: 'resend',
      recipientEmail: order.customer_email,
      senderEmail: emailCfg.fromAddress,
      subject,
      status: 'failed',
      errorMessage: safeError,
      attemptCount,
      sentAt: null,
      lastAttemptAt: attemptTime
    }).catch(saveErr => console.error(`Failed to persist email error for ${order.reference}:`, saveErr));
    return { sent: false, status: 'failed', error: safeError };
  } finally {
    inFlightConfirmationEmails.delete(order.reference);
  }
}

interface AuthenticatedAdminRequest extends express.Request {
  adminSession?: AdminSessionRecord;
}

function requireAdminAuth(
  req: AuthenticatedAdminRequest,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Staff authentication required.' });
  }
  const token = authHeader.slice(7).trim();
  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) adminSessions.delete(token);
    return res.status(401).json({ error: 'Admin session expired or invalid. Please sign in again.' });
  }
  req.adminSession = session;
  return next();
}

async function requireSupabaseReady(res: express.Response): Promise<SupabaseHealthDiagnostic | null> {
  const health = await checkSupabaseHealth();
  if (!health.configured) {
    res.status(503).json({
      error:
        health.issue ||
        'Supabase PostgreSQL database and private storage buckets are not configured or unavailable.',
      code: 'SUPABASE_UNAVAILABLE',
      supabase: health
    });
    return null;
  }
  return health;
}

async function getAdminAuthMode(): Promise<{
  mode: 'env' | 'claimed' | 'bootstrap_required' | 'unavailable';
  supabase: SupabaseHealthDiagnostic;
}> {
  const supabase = await checkSupabaseHealth();
  const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
  if (envPasscode.length > 0) {
    return { mode: 'env', supabase };
  }
  if (!supabase.databaseReady) {
    return { mode: 'unavailable', supabase };
  }
  try {
    const accounts = await listActiveStaffAccounts();
    return { mode: accounts.length > 0 ? 'claimed' : 'bootstrap_required', supabase };
  } catch {
    return { mode: 'unavailable', supabase };
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const PORT = 3000;

  // ============================================================================
  // STRIPE WEBHOOK (Raw body before express.json)
  // ============================================================================
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    const supabaseHealth = await checkSupabaseHealth();

    if (!supabaseHealth.configured) {
      return res.status(503).json({
        error: supabaseHealth.issue || 'Supabase is unavailable; cannot process webhook.',
        code: 'SUPABASE_UNAVAILABLE'
      });
    }

    const stripeInfo = getStripeConfig(supabaseHealth);
    if (!stripeInfo.client) {
      return res.status(503).json({ error: 'Stripe is not configured on this server.' });
    }
    if (!webhookSecret) {
      return res.status(500).json({ error: 'Stripe webhook signing secret is not configured on the server.' });
    }
    if (!sig || typeof sig !== 'string') {
      return res.status(400).json({ error: 'Missing Stripe-Signature header.' });
    }

    let event: Stripe.Event;
    try {
      event = stripeInfo.client.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (await hasProcessedStripeEvent(event.id)) {
        return res.json({ received: true, duplicate: true });
      }

      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        const session = event.data.object as Stripe.Checkout.Session;
        const reference =
          session.client_reference_id || session.metadata?.orderReference || session.metadata?.reference;

        if (!reference || !ORDER_REF_REGEX.test(reference)) {
          return res.json({ received: true, ignored: 'invalid_reference' });
        }

        const order = await fetchOrderByReference(reference);
        if (!order) {
          return res.json({ received: true, ignored: 'order_not_found' });
        }

        // Already confirmed Paid — idempotent no-op (never sends a duplicate confirmation email)
        if (order.payment_status === 'Paid') {
          return res.json({ received: true, duplicate: true });
        }

        // Strictly verify this Stripe session was created by this server for this exact order
        const paymentRow = await fetchPaymentByStripeSessionId(session.id);
        const sessionMatchesOrder = Boolean(paymentRow && paymentRow.order_id === order.id);

        const amountTotal = session.amount_total;
        const currency = (session.currency || '').toLowerCase();
        const paymentStatus = session.payment_status;

        if (
          sessionMatchesOrder &&
          paymentRow &&
          typeof amountTotal === 'number' &&
          amountTotal === order.total_sen &&
          currency === 'myr' &&
          paymentStatus === 'paid'
        ) {
          const paidAt = new Date().toISOString();
          const paymentIntentId =
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id || null;

          await updatePaymentById(paymentRow.id, {
            status: 'paid',
            stripe_payment_intent_id: paymentIntentId,
            stripe_event_id: event.id,
            paid_at: paidAt
          });

          const updatedOrder = await updateOrderByReference(reference, {
            payment_status: 'Paid',
            payment_method: 'card',
            paid_at: paidAt,
            correction_reason: null,
            last_card_attempt_message: null
          });

          try {
            await sendOrderConfirmationEmailOnce(updatedOrder, req);
          } catch (emailErr) {
            console.error(`Unexpected confirmation email error for order ${reference}:`, emailErr);
          }
          console.log(`Order ${reference} confirmed Paid via verified Stripe webhook (${event.id}).`);
          return res.json({ received: true });
        } else {
          console.warn(`Stripe webhook mismatch for order ${reference}`, {
            eventId: event.id,
            sessionMatchesOrder,
            expectedAmount: order.total_sen,
            receivedAmount: amountTotal,
            receivedCurrency: currency,
            paymentStatus
          });
        }

        return res.json({ received: true });
      }

      if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const reference =
          session.client_reference_id || session.metadata?.orderReference || session.metadata?.reference;

        const paymentRow = await fetchPaymentByStripeSessionId(session.id);
        if (paymentRow && paymentRow.status !== 'paid') {
          await updatePaymentById(paymentRow.id, {
            status: event.type === 'checkout.session.expired' ? 'expired' : 'failed',
            stripe_event_id: event.id
          });
        }

        if (reference && ORDER_REF_REGEX.test(reference)) {
          const order = await fetchOrderByReference(reference);
          if (
            order &&
            (order.payment_status === 'Awaiting payment' ||
              order.payment_status === 'Receipt correction needed')
          ) {
            await updateOrderByReference(reference, {
              last_card_attempt_message:
                event.type === 'checkout.session.expired'
                  ? 'Your previous card checkout session expired. You can try again below without re-uploading your photo.'
                  : 'Your card payment failed. You can retry with another card or choose a QR payment method below.'
            });
          }
        }
        return res.json({ received: true });
      }

      return res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook processing error:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Failed to persist Stripe webhook state.' });
    }
  });

  app.use(express.json({ limit: '16mb' }));

  // ============================================================================
  // PUBLIC STOREFRONT CONFIG & HEALTH
  // ============================================================================
  app.get('/api/store-config', async (_req, res) => {
    const { settings, supabase, merchantConfig, diagnostics } = await evaluateAllPaymentMethods();
    return res.json({
      success: true,
      supabaseReady: supabase.configured,
      supabaseError: supabase.configured ? null : supabase.issue || 'Supabase is unavailable.',
      storefront: getPublicStorefrontConfig(settings),
      merchantConfig,
      configIssues: {
        tng: diagnostics.tng.issues,
        duitnow: diagnostics.duitnow.issues,
        supabase: supabase.issues
      }
    });
  });

  // ============================================================================
  // SECURE CUSTOMER PHOTO UPLOAD SESSIONS (PRIVATE SUPABASE BUCKET)
  // ============================================================================
  app.post('/api/photo-upload-session', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneExpiredUploadSessions();

    const ip = req.ip || 'unknown';
    const tracker = uploadSessionRateTracker.get(ip);
    if (tracker && tracker.resetAt > Date.now() && tracker.count >= MAX_UPLOAD_SESSIONS_PER_WINDOW) {
      return res.status(429).json({
        error: 'Too many photo upload sessions started recently. Please wait a few minutes and try again.'
      });
    }
    const nextCount = tracker && tracker.resetAt > Date.now() ? tracker.count + 1 : 1;
    uploadSessionRateTracker.set(ip, { count: nextCount, resetAt: Date.now() + LOGIN_WINDOW_MS });

    const sessionId = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + PHOTO_UPLOAD_SESSION_TTL_MS;

    photoUploadSessions.set(token, {
      sessionId,
      token,
      expiresAt,
      photoStoragePath: null,
      photoOriginalFilename: null,
      photoMimeType: null,
      photoSizeBytes: null
    });

    return res.json({
      success: true,
      uploadSessionToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      maxFileSizeBytes: MAX_UPLOAD_BYTES,
      allowedMimeTypes: ['image/jpeg', 'image/png']
    });
  });

  app.post('/api/upload-photo', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneExpiredUploadSessions();

    const headerSession =
      typeof req.headers['x-upload-session'] === 'string' ? req.headers['x-upload-session'].trim() : '';
    const bodySession =
      typeof req.body?.uploadSessionToken === 'string' ? req.body.uploadSessionToken.trim() : '';
    const uploadSessionToken = headerSession || bodySession;

    if (!uploadSessionToken) {
      return res.status(401).json({ error: 'A valid secure photo upload session is required.' });
    }

    const session = photoUploadSessions.get(uploadSessionToken);
    if (!session || session.expiresAt < Date.now()) {
      if (session) photoUploadSessions.delete(uploadSessionToken);
      return res.status(401).json({
        error: 'Your photo upload session has expired. Please refresh or re-select your photo.'
      });
    }

    try {
      const { imageBase64, filename } = req.body || {};
      if (typeof imageBase64 !== 'string' || !imageBase64) {
        return res.status(400).json({ error: 'No image data provided.' });
      }

      const matches = imageBase64.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Please upload a clear JPG or PNG image.' });
      }

      const mimeType: 'image/jpeg' | 'image/png' =
        matches[1].toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'Photo must be smaller than 10 MB.' });
      }
      if (!verifyMagicBytes(buffer, mimeType)) {
        return res.status(400).json({ error: 'Uploaded file does not match a valid JPG or PNG image.' });
      }

      const cfg = getSupabaseEnvConfig();
      const previousPath = session.photoStoragePath;
      const storagePath = `pending/${session.sessionId}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const originalFilename = sanitizeDisplayFilename(filename, 'customer_photo', ext);

      await uploadPrivateFile({
        bucket: cfg.photosBucket,
        storagePath,
        buffer,
        contentType: mimeType
      });

      if (previousPath && previousPath !== storagePath) {
        void removePrivateFile(cfg.photosBucket, previousPath);
      }

      session.photoStoragePath = storagePath;
      session.photoOriginalFilename = originalFilename;
      session.photoMimeType = mimeType;
      session.photoSizeBytes = buffer.length;
      session.expiresAt = Date.now() + PHOTO_UPLOAD_SESSION_TTL_MS;

      const signedPreviewUrl = await createShortLivedSignedUrl(cfg.photosBucket, storagePath, 900);

      return res.json({
        success: true,
        uploadSessionToken,
        photoStoragePath: storagePath,
        photoUrl: signedPreviewUrl || '',
        fileName: originalFilename,
        mimeType,
        sizeBytes: buffer.length
      });
    } catch (err) {
      console.error('Private customer photo upload error:', sanitizeSupabaseError(err));
      return res.status(502).json({
        error: 'Could not upload your photo to private storage. Please try again.'
      });
    }
  });

  // ============================================================================
  // DELIVERY VALIDATION & ORDER CREATION
  // ============================================================================
  app.post('/api/validate-delivery', async (req, res) => {
    const { settings } = await loadCurrentStoreSettings();
    const { state } = req.body || {};
    if (!state || typeof state !== 'string') {
      return res.status(400).json({ valid: false, error: 'Please select a delivery state.' });
    }
    const delivery = getDeliveryConfigForState(state, settings);
    if (!delivery) {
      return res.status(400).json({
        valid: false,
        error: 'We currently deliver within Malaysia only. Please select a valid Malaysian state.'
      });
    }
    return res.json({
      valid: true,
      zone: delivery.zone,
      deliveryFeeSen: delivery.rateSen
    });
  });

  app.post('/api/create-order', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneExpiredUploadSessions();

    try {
      const { productId, bundleId, uploadSessionToken, photoStoragePath, customer } = req.body || {};
      const resolvedKey = productId === 'bundle' ? bundleId : productId;
      const product = typeof resolvedKey === 'string' ? PRODUCT_CONFIG[resolvedKey] : undefined;

      if (!product) {
        return res.status(400).json({ error: 'Invalid product or bundle selection.' });
      }

      // Require a valid upload session owning the private photo object
      const tokenStr = typeof uploadSessionToken === 'string' ? uploadSessionToken.trim() : '';
      const session = tokenStr ? photoUploadSessions.get(tokenStr) : undefined;
      if (!session || session.expiresAt < Date.now() || !session.photoStoragePath) {
        return res.status(400).json({
          error: 'Please upload your keepsake photo before creating an order (upload session missing or expired).'
        });
      }
      if (
        typeof photoStoragePath === 'string' &&
        photoStoragePath.trim() &&
        !safeEqualStrings(photoStoragePath.trim(), session.photoStoragePath)
      ) {
        return res.status(403).json({
          error: 'Uploaded photo does not match your active checkout session.'
        });
      }

      if (!customer || typeof customer !== 'object') {
        return res.status(400).json({ error: 'Customer details are required.' });
      }

      const cleanCustomer = {
        fullName: String(customer.fullName || '').trim().slice(0, 120),
        email: String(customer.email || '').trim().slice(0, 160),
        mobile: String(customer.mobile || '').trim().slice(0, 40),
        address: String(customer.address || '').trim().slice(0, 300),
        postcode: String(customer.postcode || '').trim().slice(0, 16),
        city: String(customer.city || '').trim().slice(0, 80),
        state: String(customer.state || '').trim().slice(0, 60)
      };

      if (
        !cleanCustomer.fullName ||
        !cleanCustomer.email ||
        !cleanCustomer.email.includes('@') ||
        !cleanCustomer.mobile ||
        !cleanCustomer.address ||
        !cleanCustomer.postcode ||
        !cleanCustomer.city ||
        !cleanCustomer.state
      ) {
        return res.status(400).json({ error: 'Please complete all required customer and delivery fields.' });
      }

      const { settings } = await loadCurrentStoreSettings(health);
      const delivery = getDeliveryConfigForState(cleanCustomer.state, settings);
      if (!delivery) {
        return res.status(400).json({ error: 'Invalid Malaysian delivery state.' });
      }

      const subtotalSen = product.priceSen;
      const regularSubtotalSen = product.regularSen ?? null;
      const savingsSen = regularSubtotalSen ? regularSubtotalSen - subtotalSen : null;
      const deliveryFeeSen = delivery.rateSen;
      const totalSen = subtotalSen + deliveryFeeSen;

      const year = new Date().getFullYear();
      const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
      const reference = `LPK-${year}-${rand}`;
      const accessToken = crypto.randomBytes(24).toString('base64url');

      const cfg = getSupabaseEnvConfig();
      const ext = session.photoMimeType === 'image/png' ? 'png' : 'jpg';
      const finalPhotoPath = `orders/${reference}/${crypto.randomBytes(6).toString('hex')}.${ext}`;

      // Move photo from pending/ into its permanent order-scoped private path
      await movePrivateFile({
        bucket: cfg.photosBucket,
        fromPath: session.photoStoragePath,
        toPath: finalPhotoPath
      });

      let insertedOrder: OrderRow;
      try {
        insertedOrder = await insertOrderRow({
          reference,
          access_token: accessToken,
          product_id: productId,
          bundle_id: productId === 'bundle' ? bundleId : null,
          product_name: product.name,
          item_quantity: productId === 'bundle' ? 2 : 1,
          subtotal_sen: subtotalSen,
          regular_subtotal_sen: regularSubtotalSen,
          savings_sen: savingsSen,
          delivery_fee_sen: deliveryFeeSen,
          total_sen: totalSen,
          photo_storage_bucket: cfg.photosBucket,
          photo_storage_path: finalPhotoPath,
          photo_original_filename: session.photoOriginalFilename,
          photo_mime_type: session.photoMimeType,
          photo_size_bytes: session.photoSizeBytes,
          customer_full_name: cleanCustomer.fullName,
          customer_email: cleanCustomer.email,
          customer_mobile: cleanCustomer.mobile,
          customer_address: cleanCustomer.address,
          customer_postcode: cleanCustomer.postcode,
          customer_city: cleanCustomer.city,
          customer_state: cleanCustomer.state,
          payment_status: 'Awaiting payment',
          payment_method: null,
          paid_at: null,
          verified_by_staff: false,
          verified_by_staff_id: null,
          verification_note: null,
          correction_reason: null,
          last_card_attempt_message: null
        });
      } catch (dbErr) {
        // Roll back moved file if DB insert failed
        void removePrivateFile(cfg.photosBucket, finalPhotoPath);
        throw dbErr;
      }

      // Single-use upload session consumed
      photoUploadSessions.delete(tokenStr);

      const hydrated: HydratedOrder = {
        order: insertedOrder,
        latestPayment: null,
        latestReceiptPayment: null,
        confirmationEmail: null
      };

      return res.json({
        success: true,
        order: toPublicOrder(hydrated, buildCustomerAuthorizedPhotoUrl(insertedOrder))
      });
    } catch (err) {
      console.error('Order creation error:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Could not save order to Supabase. Please try again.' });
    }
  });

  // ============================================================================
  // CUSTOMER AUTHORIZED ORDER STATUS & PRIVATE PHOTO ACCESS
  // ============================================================================
  app.get('/api/orders/:reference', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference format.' });
    }

    try {
      const hydrated = await fetchHydratedOrderByReference(reference);
      if (!hydrated) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, hydrated.order)) {
        return res.status(403).json({
          error: 'This order requires its full secure order link to view status or upload payment receipts.'
        });
      }

      return res.json({
        success: true,
        order: toPublicOrder(hydrated, buildCustomerAuthorizedPhotoUrl(hydrated.order))
      });
    } catch (err) {
      console.error(`Failed to fetch order ${reference}:`, sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Unable to load order from Supabase.' });
    }
  });

  // Customer-only private photo stream (strictly requires matching order accessToken)
  app.get('/api/orders/:reference/photo', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }

    try {
      const order = await fetchOrderByReference(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({ error: 'Valid secure order session token is required to view this photo.' });
      }
      if (!order.photo_storage_path) {
        return res.status(404).json({ error: 'No photo attached to this order.' });
      }

      const { buffer, contentType } = await downloadPrivateFile(
        order.photo_storage_bucket,
        order.photo_storage_path
      );
      const mimeType = order.photo_mime_type || contentType || 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        order.photo_original_filename || `${order.reference}_photo.${ext}`,
        `${order.reference}_photo`,
        ext
      );
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(buffer);
    } catch (err) {
      console.error(`Failed to stream customer photo for ${reference}:`, sanitizeSupabaseError(err));
      return res.status(404).json({ error: 'Stored order photo could not be retrieved.' });
    }
  });

  // ============================================================================
  // MANUAL QR PAYMENT RECEIPT UPLOAD (PRIVATE SUPABASE RECEIPTS BUCKET)
  // ============================================================================
  app.post('/api/upload-receipt', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    try {
      const { reference, paymentMethod, transactionReference, receiptBase64, filename } = req.body || {};

      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      const order = await fetchOrderByReference(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({ error: 'Valid secure order link token is required to submit a receipt.' });
      }
      if (order.payment_status === 'Paid') {
        return res.status(409).json({ error: 'This order has already been paid.' });
      }
      if (order.payment_status === 'Pending verification') {
        return res.status(409).json({
          error: 'A payment receipt has already been submitted for this order and is pending verification.'
        });
      }

      if (paymentMethod !== 'tng' && paymentMethod !== 'duitnow') {
        return res.status(400).json({ error: 'Please select a valid manual QR payment method.' });
      }
      const qrMethod: 'tng' | 'duitnow' = paymentMethod;

      const { merchantConfig } = await evaluateAllPaymentMethods();
      if (!merchantConfig[qrMethod]) {
        return res.status(400).json({ error: 'Selected QR payment method is not currently configured.' });
      }

      const cleanTxRef = typeof transactionReference === 'string' ? transactionReference.trim() : '';
      if (cleanTxRef.length < 3 || cleanTxRef.length > 100) {
        return res.status(400).json({ error: 'Please enter a valid transaction reference (3–100 characters).' });
      }

      if (typeof receiptBase64 !== 'string' || !receiptBase64) {
        return res.status(400).json({ error: 'Please upload your payment receipt (JPG, PNG, or PDF).' });
      }

      const matches = receiptBase64.match(
        /^data:(image\/(?:jpeg|jpg|png)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/
      );
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid receipt file format. Please upload a JPG, PNG, or PDF file.' });
      }

      const rawMime = matches[1].toLowerCase();
      const normalizedMime: 'image/jpeg' | 'image/png' | 'application/pdf' =
        rawMime === 'application/pdf'
          ? 'application/pdf'
          : rawMime === 'image/png'
            ? 'image/png'
            : 'image/jpeg';
      const ext =
        normalizedMime === 'application/pdf' ? 'pdf' : normalizedMime === 'image/png' ? 'png' : 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'Receipt file must be smaller than 10 MB.' });
      }
      if (!verifyMagicBytes(buffer, normalizedMime)) {
        return res.status(400).json({ error: 'Uploaded receipt file content does not match its declared file type.' });
      }

      const cfg = getSupabaseEnvConfig();
      const receiptId = `rcpt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const storagePath = `orders/${reference}/${receiptId}.${ext}`;
      const originalFilename = sanitizeDisplayFilename(filename, 'receipt', ext);
      const uploadedAt = new Date().toISOString();

      await uploadPrivateFile({
        bucket: cfg.receiptsBucket,
        storagePath,
        buffer,
        contentType: normalizedMime
      });

      try {
        await insertPaymentRow({
          order_id: order.id,
          order_reference: order.reference,
          payment_method: qrMethod,
          status: 'pending_verification',
          amount_sen: order.total_sen,
          currency: 'myr',
          transaction_reference: cleanTxRef,
          receipt_storage_bucket: cfg.receiptsBucket,
          receipt_storage_path: storagePath,
          receipt_original_filename: originalFilename,
          receipt_mime_type: normalizedMime,
          receipt_size_bytes: buffer.length,
          receipt_uploaded_at: uploadedAt,
          stripe_session_id: null,
          stripe_payment_intent_id: null,
          stripe_event_id: null,
          verified_by_staff: false,
          verified_by_staff_id: null,
          verification_note: null,
          rejection_reason: null,
          paid_at: null
        });

        await updateOrderByReference(reference, {
          payment_method: qrMethod,
          payment_status: 'Pending verification',
          correction_reason: null,
          last_card_attempt_message: null
        });
      } catch (dbErr) {
        void removePrivateFile(cfg.receiptsBucket, storagePath);
        throw dbErr;
      }

      const hydrated = await fetchHydratedOrderByReference(reference);
      if (!hydrated) {
        return res.status(500).json({ error: 'Order updated but could not be reloaded.' });
      }

      return res.json({
        success: true,
        order: toPublicOrder(hydrated, buildCustomerAuthorizedPhotoUrl(hydrated.order))
      });
    } catch (err) {
      console.error('Receipt upload error:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Failed to save payment receipt to private storage.' });
    }
  });

  // ============================================================================
  // STRIPE CHECKOUT SESSION
  // ============================================================================
  app.post('/api/create-stripe-session', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    try {
      const stripeInfo = getStripeConfig(health);
      if (!stripeInfo.client) {
        return res.status(503).json({
          error: stripeInfo.error || 'Credit or Debit Card checkout is currently unavailable.'
        });
      }

      const { reference } = req.body || {};
      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      const order = await fetchOrderByReference(reference);
      if (!order) {
        return res.status(404).json({ error: 'Saved order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({ error: 'Valid secure order link token is required to start card checkout.' });
      }
      if (order.payment_status === 'Paid') {
        return res.status(409).json({ error: 'This order is already marked as Paid.' });
      }
      if (order.payment_status === 'Pending verification') {
        return res.status(409).json({
          error: 'A QR payment receipt is already pending verification for this order.'
        });
      }

      const origin = resolveTrustedOrigin(req);
      const tokenParam = encodeURIComponent(order.access_token);
      const refParam = encodeURIComponent(order.reference);

      const session = await stripeInfo.client.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: order.reference,
        customer_email: order.customer_email,
        metadata: {
          orderReference: order.reference,
          productName: order.product_name,
          expectedTotalSen: String(order.total_sen)
        },
        line_items: [
          {
            price_data: {
              currency: 'myr',
              product_data: {
                name: `Little Pixel Keepsakes — ${order.product_name}`,
                description: `Order Ref: ${order.reference} (Qty: ${order.item_quantity})`
              },
              unit_amount: order.subtotal_sen
            },
            quantity: 1
          },
          {
            price_data: {
              currency: 'myr',
              product_data: {
                name: `Delivery (${order.customer_state})`,
                description: DELIVERY_PROMISE_TEXT
              },
              unit_amount: order.delivery_fee_sen
            },
            quantity: 1
          }
        ],
        success_url: `${origin}/?payment=success&order=${refParam}&token=${tokenParam}`,
        cancel_url: `${origin}/?payment=cancelled&order=${refParam}&token=${tokenParam}`
      });

      await insertPaymentRow({
        order_id: order.id,
        order_reference: order.reference,
        payment_method: 'card',
        status: 'pending',
        amount_sen: order.total_sen,
        currency: 'myr',
        transaction_reference: null,
        receipt_storage_bucket: null,
        receipt_storage_path: null,
        receipt_original_filename: null,
        receipt_mime_type: null,
        receipt_size_bytes: null,
        receipt_uploaded_at: null,
        stripe_session_id: session.id,
        stripe_payment_intent_id: null,
        stripe_event_id: null,
        verified_by_staff: false,
        verified_by_staff_id: null,
        verification_note: null,
        rejection_reason: null,
        paid_at: null
      });

      await updateOrderByReference(reference, {
        last_card_attempt_message: null
      });

      return res.json({ success: true, url: session.url, mode: stripeInfo.mode });
    } catch (err: any) {
      console.error('Stripe session creation error:', err?.message || err);
      return res.status(502).json({
        error: 'Unable to initiate Stripe card checkout right now. You can retry or choose a QR payment method.'
      });
    }
  });

  // ============================================================================
  // PROTECTED STAFF ADMIN AUTH & OPERATIONS (BACKED BY public.staff_accounts)
  // ============================================================================
  app.get('/api/admin/auth-status', async (_req, res) => {
    const { mode, supabase } = await getAdminAuthMode();
    return res.json({
      success: true,
      mode,
      supabaseReady: supabase.configured,
      supabaseError: supabase.configured ? null : supabase.issue || 'Supabase is unavailable.'
    });
  });

  // One-time first-run passcode setup stored hashed (scrypt) in public.staff_accounts
  app.post('/api/admin/bootstrap', async (req, res) => {
    const { mode, supabase } = await getAdminAuthMode();
    if (mode === 'unavailable' || !supabase.databaseReady) {
      return res.status(503).json({
        error: supabase.issue || 'Supabase database must be configured before setting up staff admin access.',
        code: 'SUPABASE_UNAVAILABLE'
      });
    }
    if (mode !== 'bootstrap_required') {
      return res.status(409).json({ error: 'Staff admin access is already configured.' });
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 8 || passcode.length > 128) {
      return res.status(400).json({ error: 'Staff passcode must be between 8 and 128 characters.' });
    }

    try {
      const { salt, hash } = hashPasscode(passcode);
      const account = await createBootstrapStaffAccount({
        username: 'admin',
        displayName: 'Primary Staff Admin',
        passwordSalt: salt,
        passwordHash: hash
      });
      const token = createAdminSession(account.id, account.username);
      return res.json({ success: true, token });
    } catch (err) {
      console.error('Admin bootstrap failed:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Failed to save staff account in Supabase.' });
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    const { mode, supabase } = await getAdminAuthMode();
    if (mode === 'bootstrap_required') {
      return res.status(400).json({ error: 'Complete first-run admin passcode setup first.' });
    }
    if (mode === 'unavailable') {
      return res.status(503).json({
        error: supabase.issue || 'Supabase is unavailable and ADMIN_PASSCODE is not set.',
        code: 'SUPABASE_UNAVAILABLE'
      });
    }

    const ip = req.ip || 'unknown';
    const tracker = failedLoginTracker.get(ip);
    if (tracker && tracker.resetAt > Date.now() && tracker.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!passcode) {
      return res.status(401).json({ error: 'Incorrect staff passcode.' });
    }

    let authenticated = false;
    let staffId: string | null = null;
    let username = 'admin';

    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (envPasscode.length > 0 && safeEqualStrings(passcode, envPasscode)) {
      authenticated = true;
    } else if (supabase.databaseReady) {
      try {
        const accounts = await listActiveStaffAccounts();
        for (const account of accounts) {
          const candidate = hashPasscode(passcode, account.password_salt);
          if (safeEqualStrings(candidate.hash, account.password_hash)) {
            authenticated = true;
            staffId = account.id;
            username = account.username;
            void touchStaffLastLogin(account.id).catch(() => {});
            break;
          }
        }
      } catch (err) {
        console.error('Staff account lookup error:', sanitizeSupabaseError(err));
      }
    }

    if (!authenticated) {
      const currentCount = tracker && tracker.resetAt > Date.now() ? tracker.count + 1 : 1;
      failedLoginTracker.set(ip, { count: currentCount, resetAt: Date.now() + LOGIN_WINDOW_MS });
      return res.status(401).json({ error: 'Incorrect staff passcode.' });
    }

    failedLoginTracker.delete(ip);
    const token = createAdminSession(staffId, username);
    return res.json({ success: true, token });
  });

  app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
    const token = (req.headers.authorization || '').slice(7).trim();
    adminSessions.delete(token);
    return res.json({ success: true });
  });

  // Protected: List all orders, diagnostics & editable settings
  app.get('/api/admin/orders', requireAdminAuth, async (_req, res) => {
    const { settings, supabase, diagnostics } = await evaluateAllPaymentMethods(true);
    if (!supabase.databaseReady) {
      return res.json({
        success: true,
        orders: [],
        diagnostics,
        settings,
        supabaseError: supabase.issue || 'Supabase database is not configured or unavailable.'
      });
    }

    try {
      const hydratedList = await listHydratedOrders();
      const orders = await Promise.all(
        hydratedList.map(async hydrated => {
          const signedPhotoUrl = supabase.photosBucketReady
            ? await resolveAdminOrderPhotoUrl(hydrated.order)
            : '';
          return toAdminOrder(hydrated, signedPhotoUrl);
        })
      );
      return res.json({
        success: true,
        orders,
        diagnostics,
        settings,
        supabaseError: supabase.configured ? null : supabase.issue || null
      });
    } catch (err) {
      const msg = sanitizeSupabaseError(err);
      return res.status(503).json({
        error: `Failed to load orders from Supabase: ${msg}`,
        code: 'SUPABASE_UNAVAILABLE',
        diagnostics
      });
    }
  });

  // Protected: Read editable store & merchant QR settings
  app.get('/api/admin/settings', requireAdminAuth, async (_req, res) => {
    const { settings, merchantConfig, diagnostics } = await evaluateAllPaymentMethods(true);
    return res.json({
      success: true,
      settings,
      merchantConfig,
      diagnostics
    });
  });

  // Protected: Update editable storefront & merchant QR settings in public.store_settings
  app.put('/api/admin/settings', requireAdminAuth, async (req: AuthenticatedAdminRequest, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    try {
      const incoming = req.body?.settings as Partial<EditableStoreSettings> | undefined;
      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'Settings payload is required.' });
      }

      const { settings: current } = await loadCurrentStoreSettings(health);
      const next: EditableStoreSettings = JSON.parse(JSON.stringify(current));

      if (typeof incoming.logoUrl === 'string') {
        const check = validateStorefrontAssetSource(incoming.logoUrl);
        if (!check.valid || !check.normalizedUrl) {
          return res.status(400).json({ error: `Invalid logo image: ${check.reason}` });
        }
        next.logoUrl = check.normalizedUrl;
      }

      if (typeof incoming.heroImageUrl === 'string') {
        const check = validateStorefrontAssetSource(incoming.heroImageUrl);
        if (!check.valid || !check.normalizedUrl) {
          return res.status(400).json({ error: `Invalid hero image: ${check.reason}` });
        }
        next.heroImageUrl = check.normalizedUrl;
      }

      if (incoming.productImages && typeof incoming.productImages === 'object') {
        for (const key of ['keychain', 'magnet', 'bundle'] as const) {
          const val = incoming.productImages[key];
          if (typeof val === 'string' && val.trim()) {
            const check = validateStorefrontAssetSource(val);
            if (!check.valid || !check.normalizedUrl) {
              return res.status(400).json({ error: `Invalid ${key} product image: ${check.reason}` });
            }
            next.productImages[key] = check.normalizedUrl;
          }
        }
      }

      if (Array.isArray(incoming.galleryItems) && incoming.galleryItems.length > 0) {
        const updatedGallery: StoreGalleryImage[] = [];
        for (const [idx, item] of incoming.galleryItems.slice(0, 6).entries()) {
          const fallback = next.galleryItems[idx] || getDefaultStoreSettings().galleryItems[0];
          const rawImg = typeof item?.image === 'string' ? item.image : fallback.image;
          const imgCheck = validateStorefrontAssetSource(rawImg);
          if (!imgCheck.valid || !imgCheck.normalizedUrl) {
            return res
              .status(400)
              .json({ error: `Invalid gallery image #${idx + 1}: ${imgCheck.reason}` });
          }
          updatedGallery.push({
            id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 40) : fallback.id,
            category:
              typeof item?.category === 'string' && item.category.trim()
                ? item.category.trim().slice(0, 60)
                : fallback.category,
            title:
              typeof item?.title === 'string' && item.title.trim()
                ? item.title.trim().slice(0, 80)
                : fallback.title,
            description:
              typeof item?.description === 'string' && item.description.trim()
                ? item.description.trim().slice(0, 240)
                : fallback.description,
            image: imgCheck.normalizedUrl,
            tag:
              typeof item?.tag === 'string' && item.tag.trim()
                ? item.tag.trim().slice(0, 40)
                : fallback.tag
          });
        }
        next.galleryItems = updatedGallery;
      }

      if (incoming.deliveryRatesSen && typeof incoming.deliveryRatesSen === 'object') {
        const pen = incoming.deliveryRatesSen.peninsular;
        const east = incoming.deliveryRatesSen.eastMalaysia;
        if (typeof pen === 'number') {
          if (!Number.isInteger(pen) || pen < 0 || pen > 100000) {
            return res
              .status(400)
              .json({ error: 'Peninsular Malaysia delivery fee must be between RM 0.00 and RM 1,000.00.' });
          }
          next.deliveryRatesSen.peninsular = pen;
        }
        if (typeof east === 'number') {
          if (!Number.isInteger(east) || east < 0 || east > 100000) {
            return res
              .status(400)
              .json({ error: 'Sabah & Sarawak delivery fee must be between RM 0.00 and RM 1,000.00.' });
          }
          next.deliveryRatesSen.eastMalaysia = east;
        }
      }

      if (typeof incoming.whatsappSupportNumber === 'string') {
        const digits = incoming.whatsappSupportNumber.replace(/\D/g, '').slice(0, 20);
        if (digits && (digits.length < 8 || digits.length > 16)) {
          return res
            .status(400)
            .json({ error: 'WhatsApp support number must include country code (8–16 digits, e.g. 60123456789).' });
        }
        next.whatsappSupportNumber = digits;
      }

      if (incoming.qrOverrides && typeof incoming.qrOverrides === 'object') {
        for (const key of ['tng', 'duitnow'] as const) {
          const entry = incoming.qrOverrides[key];
          if (!entry || typeof entry !== 'object') continue;
          const label = key === 'tng' ? 'Touch ’n Go eWallet QR' : 'Public Bank QR Pay';
          if (entry.enabled === null || typeof entry.enabled === 'boolean') {
            next.qrOverrides[key].enabled = entry.enabled;
          }
          if (typeof entry.recipientName === 'string') {
            next.qrOverrides[key].recipientName = entry.recipientName.trim().slice(0, 140);
          }
          if (typeof entry.qrImage === 'string') {
            const trimmedImg = entry.qrImage.trim();
            if (!trimmedImg) {
              next.qrOverrides[key].qrImage = '';
            } else {
              const check = validateQrImageSource(trimmedImg);
              if (!check.valid || !check.normalizedUrl) {
                return res.status(400).json({ error: `Invalid ${label} image: ${check.reason}` });
              }
              next.qrOverrides[key].qrImage = check.normalizedUrl;
            }
          }
        }
      }

      await upsertStoreSettingsRow(next, req.adminSession?.staffId ?? null);

      const evaluated = await evaluateAllPaymentMethods();
      return res.json({
        success: true,
        settings: evaluated.settings,
        storefront: getPublicStorefrontConfig(evaluated.settings),
        merchantConfig: evaluated.merchantConfig,
        diagnostics: evaluated.diagnostics
      });
    } catch (err) {
      console.error('Failed to save store settings:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Failed to save store settings to Supabase.' });
    }
  });

  // Protected: Upload a public storefront marketing asset (logo/product/gallery) or merchant QR image
  app.post('/api/admin/upload-asset', requireAdminAuth, (req, res) => {
    try {
      const { target, imageBase64 } = req.body || {};
      if (target !== 'storefront' && target !== 'qr') {
        return res.status(400).json({ error: 'Invalid asset target.' });
      }
      if (typeof imageBase64 !== 'string' || !imageBase64) {
        return res.status(400).json({ error: 'No image data provided.' });
      }

      const matches = imageBase64.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Please upload a valid JPG or PNG image.' });
      }

      const mimeType = matches[1].toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'Asset image must be smaller than 10 MB.' });
      }
      if (!verifyMagicBytes(buffer, mimeType)) {
        return res.status(400).json({ error: 'Uploaded file does not match a valid JPG or PNG image.' });
      }

      const baseDir = target === 'qr' ? publicPaymentsDir : publicStorefrontAssetsDir;
      const prefix = target === 'qr' ? 'qr' : 'storefront';
      const publicPrefix = target === 'qr' ? '/payments/' : '/assets/storefront/';
      const uniqueName = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const filePath = path.resolve(baseDir, uniqueName);

      if (!filePath.startsWith(baseDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid upload destination.' });
      }

      fs.writeFileSync(filePath, buffer);
      return res.json({ success: true, assetUrl: `${publicPrefix}${uniqueName}` });
    } catch {
      return res.status(500).json({ error: 'Failed to upload image asset.' });
    }
  });

  // Protected: Staff preview & download of private customer photo from SUPABASE_PHOTOS_BUCKET
  app.get('/api/admin/orders/:reference/photo', requireAdminAuth, async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }

    try {
      const order = await fetchOrderByReference(reference);
      if (!order || !order.photo_storage_path) {
        return res.status(404).json({ error: 'No customer photo attached to this order.' });
      }

      const { buffer, contentType } = await downloadPrivateFile(
        order.photo_storage_bucket,
        order.photo_storage_path
      );
      const mimeType = order.photo_mime_type || contentType || 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        order.photo_original_filename || `${order.reference}_photo.${ext}`,
        `${order.reference}_photo`,
        ext
      );
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(buffer);
    } catch (err) {
      console.error(`Admin photo fetch failed for ${reference}:`, sanitizeSupabaseError(err));
      return res.status(404).json({ error: 'Stored customer photo could not be retrieved from private bucket.' });
    }
  });

  // Protected: Staff preview & download of private payment receipt from SUPABASE_RECEIPTS_BUCKET
  app.get('/api/admin/orders/:reference/receipt', requireAdminAuth, async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }

    try {
      const hydrated = await fetchHydratedOrderByReference(reference);
      const receiptPayment = hydrated?.latestReceiptPayment;
      if (!hydrated || !receiptPayment || !receiptPayment.receipt_storage_bucket || !receiptPayment.receipt_storage_path) {
        return res.status(404).json({ error: 'No payment receipt attached to this order.' });
      }

      const { buffer, contentType } = await downloadPrivateFile(
        receiptPayment.receipt_storage_bucket,
        receiptPayment.receipt_storage_path
      );
      const mimeType = receiptPayment.receipt_mime_type || contentType || 'application/octet-stream';
      const ext =
        mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        receiptPayment.receipt_original_filename || `${reference}_receipt.${ext}`,
        `${reference}_receipt`,
        ext
      );
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(buffer);
    } catch (err) {
      console.error(`Admin receipt fetch failed for ${reference}:`, sanitizeSupabaseError(err));
      return res.status(404).json({ error: 'Stored payment receipt could not be retrieved from private bucket.' });
    }
  });

  // Protected: Staff verifies incoming TNG or Public Bank transfer, marks order Paid, and sends one Resend email
  app.post(
    '/api/admin/orders/:reference/verify-payment',
    requireAdminAuth,
    async (req: AuthenticatedAdminRequest, res) => {
      const health = await requireSupabaseReady(res);
      if (!health) return;

      const { reference } = req.params;
      if (!ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      try {
        const hydrated = await fetchHydratedOrderByReference(reference);
        if (!hydrated) {
          return res.status(404).json({ error: 'Order not found.' });
        }
        const { order, latestReceiptPayment } = hydrated;
        if (order.payment_status === 'Paid') {
          return res.status(409).json({ error: 'Order is already marked as Paid.' });
        }
        if (
          order.payment_status !== 'Pending verification' ||
          !latestReceiptPayment?.receipt_storage_path ||
          (order.payment_method !== 'tng' && order.payment_method !== 'duitnow')
        ) {
          return res.status(400).json({
            error:
              'Only orders with a submitted TNG or Public Bank QR receipt pending verification can be marked paid by staff.'
          });
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 240) : '';
        const verificationNote =
          note || `Verified incoming ${getPaymentMethodDisplayLabel(order.payment_method)} transfer.`;
        const paidAt = new Date().toISOString();
        const staffId = req.adminSession?.staffId ?? null;

        await updatePaymentById(latestReceiptPayment.id, {
          status: 'paid',
          verified_by_staff: true,
          verified_by_staff_id: staffId,
          verification_note: verificationNote,
          paid_at: paidAt
        });

        const updatedOrder = await updateOrderByReference(reference, {
          payment_status: 'Paid',
          paid_at: paidAt,
          verified_by_staff: true,
          verified_by_staff_id: staffId,
          verification_note: verificationNote,
          correction_reason: null
        });

        try {
          await sendOrderConfirmationEmailOnce(updatedOrder, req);
        } catch (emailErr) {
          console.error(`Unexpected confirmation email error for order ${reference}:`, emailErr);
        }

        const refreshed = await fetchHydratedOrderByReference(reference);
        if (!refreshed) {
          return res.status(500).json({ error: 'Order marked paid but could not be reloaded.' });
        }
        const signedPhotoUrl = await resolveAdminOrderPhotoUrl(refreshed.order);
        return res.json({ success: true, order: toAdminOrder(refreshed, signedPhotoUrl) });
      } catch (err) {
        console.error(`Verify payment error for ${reference}:`, sanitizeSupabaseError(err));
        return res.status(500).json({ error: 'Failed to verify payment in Supabase.' });
      }
    }
  );

  // Protected: Retry sending confirmation email for a Paid order without changing its Paid status
  app.post('/api/admin/orders/:reference/retry-email', requireAdminAuth, async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }

    try {
      const hydrated = await fetchHydratedOrderByReference(reference);
      if (!hydrated) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (hydrated.order.payment_status !== 'Paid') {
        return res.status(400).json({ error: 'Only paid orders can send a confirmation email.' });
      }
      if (hydrated.confirmationEmail?.sent_at || hydrated.confirmationEmail?.status === 'sent') {
        const signedPhotoUrl = await resolveAdminOrderPhotoUrl(hydrated.order);
        return res.status(409).json({
          error: 'Confirmation email has already been sent for this order.',
          order: toAdminOrder(hydrated, signedPhotoUrl)
        });
      }

      const result = await sendOrderConfirmationEmailOnce(hydrated.order, req);
      const refreshed = (await fetchHydratedOrderByReference(reference)) || hydrated;
      const signedPhotoUrl = await resolveAdminOrderPhotoUrl(refreshed.order);

      if (result.sent) {
        return res.json({ success: true, order: toAdminOrder(refreshed, signedPhotoUrl) });
      }
      if (result.skipped && result.status === 'sent') {
        return res.status(409).json({
          error: 'Confirmation email has already been sent or is currently being sent.',
          order: toAdminOrder(refreshed, signedPhotoUrl)
        });
      }

      const statusCode = result.status === 'not_configured' ? 503 : 502;
      return res.status(statusCode).json({
        success: false,
        error: result.error || 'Could not send confirmation email. Order remains Paid.',
        order: toAdminOrder(refreshed, signedPhotoUrl)
      });
    } catch (err) {
      console.error(`Retry email error for ${reference}:`, sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Failed to retry confirmation email.' });
    }
  });

  // Protected: Staff requests a corrected receipt (sets status to "Receipt correction needed")
  app.post(
    '/api/admin/orders/:reference/reject-payment',
    requireAdminAuth,
    async (req: AuthenticatedAdminRequest, res) => {
      const health = await requireSupabaseReady(res);
      if (!health) return;

      const { reference } = req.params;
      if (!ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      try {
        const hydrated = await fetchHydratedOrderByReference(reference);
        if (!hydrated) {
          return res.status(404).json({ error: 'Order not found.' });
        }
        if (hydrated.order.payment_status !== 'Pending verification') {
          return res
            .status(400)
            .json({ error: 'Only orders pending verification can request a corrected receipt.' });
        }

        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.trim()
            ? req.body.reason.trim().slice(0, 240)
            : 'We could not match your uploaded receipt to an incoming transaction. Please verify the recipient name and exact amount, then upload a corrected receipt.';

        const payments = await fetchPaymentsForOrder(hydrated.order.id);
        const pendingPayment = payments.find(p => p.status === 'pending_verification');
        if (pendingPayment) {
          await updatePaymentById(pendingPayment.id, {
            status: 'correction_needed',
            rejection_reason: reason,
            verified_by_staff_id: req.adminSession?.staffId ?? null
          });
        }

        await updateOrderByReference(reference, {
          payment_status: 'Receipt correction needed',
          correction_reason: reason,
          verification_note: reason,
          last_card_attempt_message: null
        });

        const refreshed = await fetchHydratedOrderByReference(reference);
        if (!refreshed) {
          return res.status(500).json({ error: 'Order updated but could not be reloaded.' });
        }
        const signedPhotoUrl = await resolveAdminOrderPhotoUrl(refreshed.order);
        return res.json({ success: true, order: toAdminOrder(refreshed, signedPhotoUrl) });
      } catch (err) {
        console.error(`Reject payment error for ${reference}:`, sanitizeSupabaseError(err));
        return res.status(500).json({ error: 'Failed to request corrected receipt in Supabase.' });
      }
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.use('/payments', express.static(publicPaymentsDir));
    app.use('/assets', express.static(path.resolve(publicDir, 'assets')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
