import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Stripe from 'stripe';
import {
  buildDeliveryPromiseText,
  type DeliveryCountry,
  type EditableStoreSettings,
  type MetaConnectionCheckResult,
  type MetaConversionEventPublic,
  type MetaConversionEventStatus,
  type MetaTrackingDiagnostic,
  type PaymentMethodKey,
  type StoreGalleryImage,
  type StripeCheckoutDiagnostic,
  type SupabaseHealthDiagnostic,
  type SupportedCurrency
} from '../types/order';
import {
  COUNTRY_LABELS,
  COUNTRY_UPDATE_NOTICE,
  DEFAULT_MARKET_PRODUCT_BASE_PRICES,
  DEFAULT_PORTRAIT_FRAME_CONFIG,
  PORTRAIT_FRAME_PRODUCT_ID,
  buildMarketPricingConfig,
  calculateAuthoritativeOrderPricing,
  formatCountryLabel,
  formatCurrencyAmount,
  formatCurrencyWithCode,
  getAllowedPaymentMethodsForCountry,
  getCurrencyForCountry,
  normalizeCurrency,
  normalizeDeliveryCountry,
  resolvePortraitFrameConfig,
  sanitizePersonalisationText,
  validateCountryCurrencyPair,
  validateCustomerDeliveryAddress,
  verifySavedOrderPricingIntegrity
} from '../shared/pricing';
import {
  checkSupabaseHealth,
  clearSupabaseHealthCache,
  copyPrivateFile,
  createBootstrapStaffAccount,
  createShortLivedSignedUrl,
  createSignedPrivateUploadUrl,
  downloadPrivateFile,
  fetchHydratedOrderByReference,
  fetchMetaPurchaseEvent,
  fetchOrderByReference,
  fetchOrderConfirmationEmail,
  fetchPaymentByStripeSessionId,
  fetchPaymentsForOrder,
  fetchStaffAccountById,
  fetchStoreSettingsRow,
  getSupabaseEnvConfig,
  hasProcessedStripeEvent,
  insertOrderRow,
  insertPaymentRow,
  isUniqueViolationError,
  listActiveStaffAccounts,
  listHydratedOrders,
  listRecentMetaConversionEvents,
  removePrivateFile,
  sanitizeSupabaseError,
  touchStaffLastLogin,
  updateOrderByReference,
  updateOrderIfUnpaid,
  updatePaymentById,
  uploadPrivateFile,
  upsertMetaPurchaseEvent,
  upsertOrderConfirmationEmail,
  upsertStoreSettingsRow,
  type HydratedOrder,
  type MetaConversionEventRow,
  type OrderRow,
  type StoreSettingsRow
} from './supabase';
import {
  getMetaEnvConfig,
  sanitizeEventSourceUrl,
  sanitizeMetaCookie,
  sanitizeMetaError,
  sendMetaCapiPurchaseEvent,
  verifyMetaCapiConnection
} from './metaCapi';
import {
  buildPurchaseEventId,
  resolveMetaContentId,
  resolveMetaNumItems
} from '../shared/metaTracking';
import {
  computePasscodeVersion,
  deriveOrderPhotoPathForUpload,
  deriveOrderReferenceForUpload,
  signServerToken,
  verifyServerToken,
  type AdminSessionPayload,
  type PhotoIntentPayload,
  type PhotoSessionPayload,
  type PhotoVerifiedPayload,
  type ReceiptIntentPayload
} from './sessionTokens';

const isServerlessRuntime = Boolean(
  process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);

const projectRoot = (() => {
  const candidates = [process.cwd(), process.env.LAMBDA_TASK_ROOT].filter(
    (dir): dir is string => typeof dir === 'string' && dir.trim().length > 0
  );
  for (const dir of candidates) {
    if (fs.existsSync(path.resolve(dir, 'public'))) {
      return dir;
    }
  }
  return process.cwd();
})();

const DELIVERY_PROMISE_TEXT =
  'Your order will be delivered within 14 days after your payment is confirmed and we receive a usable photo.';
const PAID_CONFIRMATION_HEADING = 'Thank you! Your order is confirmed.';

// Public storefront static directories (NEVER used for customer photos or payment receipts)
const publicDir = path.resolve(projectRoot, 'public');
const publicPaymentsDir = path.resolve(publicDir, 'payments');
const publicStorefrontAssetsDir = path.resolve(publicDir, 'assets', 'storefront');

// Only create local static asset subdirectories in writable standalone Node runtimes (never on read-only serverless filesystems)
if (!isServerlessRuntime) {
  for (const dir of [publicPaymentsDir, publicStorefrontAssetsDir]) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Non-fatal on read-only filesystems
    }
  }
}


const ORDER_REF_REGEX = /^LPK-\d{4}-[A-Z0-9]{6,10}$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_LOGIN_ATTEMPTS = 10;
const PHOTO_UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000; // 60 min
const MAX_UPLOAD_SESSIONS_PER_WINDOW = 30;

const LEGACY_HERO_IMAGE_URL = '/src/assets/images/hero_bead_art_showcase_1795515646405.jpg';
const LEGACY_KEYCHAIN_IMAGE_URL = '/src/assets/images/pet_bead_art_1795515646980.jpg';
const LEGACY_MAGNET_IMAGE_URL = '/src/assets/images/couple_bead_art_1795515653017.jpg';
const LEGACY_BUNDLE_IMAGE_URL = '/src/assets/images/family_bead_art_1795515653155.jpg';
const LEGACY_PORTRAIT_FRAME_IMAGE_URL = '/src/assets/images/family_bead_art_1795515653155.jpg';

function resolveEnvSingaporeShippingCents(): number | null {
  const raw = stripWrappingQuotes(process.env.SG_SHIPPING_FEE_CENTS || '');
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
    return null;
  }
  return parsed;
}

function getDefaultStoreSettings(): EditableStoreSettings {
  return {
    logoUrl: '/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png',
    heroImageUrl: '/assets/aistudio/From_Photo_to_Perler_Keepsake_40f444e1.png',
    productImages: {
      keychain: '/assets/aistudio/Custom_Perler_Bead_Keychain_Showcase_b07b8ffc.png',
      magnet: '/assets/aistudio/Custom_Family_Perler_Bead_Magnet_c104de68.png',
      bundle: '/assets/aistudio/Custom_Family_Perler_Bead_Bundle_e5569304.png',
      portrait_frame: '/assets/aistudio/Our_Family_Perler_Bead_Portrait_ee465ba0.png'
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
    deliveryRateSingaporeCents: resolveEnvSingaporeShippingCents(),
    sgProductPricesCents: {
      keychain: DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.keychain,
      magnet: DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.magnet
    },
    portraitFrameConfig: { ...DEFAULT_PORTRAIT_FRAME_CONFIG },
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
  const rawHero = row.hero_image_url?.trim();
  const rawKeychain = row.product_images?.keychain?.trim();
  const rawMagnet = row.product_images?.magnet?.trim();
  const rawBundle = row.product_images?.bundle?.trim();
  const rawPortraitFrame = row.product_images?.portrait_frame?.trim();

  const hasSgShippingColumn = Object.prototype.hasOwnProperty.call(
    row,
    'delivery_rate_singapore_cents'
  );
  let resolvedSgShippingCents: number | null;
  if (hasSgShippingColumn) {
    resolvedSgShippingCents =
      typeof row.delivery_rate_singapore_cents === 'number' &&
      Number.isInteger(row.delivery_rate_singapore_cents) &&
      row.delivery_rate_singapore_cents >= 0
        ? row.delivery_rate_singapore_cents
        : null;
  } else {
    resolvedSgShippingCents = defaults.deliveryRateSingaporeCents;
  }

  const hasPortraitSgShippingColumn = Object.prototype.hasOwnProperty.call(
    row,
    'portrait_frame_delivery_singapore_cents'
  );
  const resolvedPortraitSgShippingCents = hasPortraitSgShippingColumn
    ? typeof row.portrait_frame_delivery_singapore_cents === 'number' &&
      Number.isInteger(row.portrait_frame_delivery_singapore_cents) &&
      row.portrait_frame_delivery_singapore_cents >= 0
      ? row.portrait_frame_delivery_singapore_cents
      : null
    : defaults.portraitFrameConfig.deliverySingaporeCents;

  const portraitFrameConfig = resolvePortraitFrameConfig({
    priceMySen: row.portrait_frame_price_my_sen ?? undefined,
    priceSgCents: row.portrait_frame_price_sg_cents ?? undefined,
    deliveryPeninsularSen: row.portrait_frame_delivery_peninsular_sen ?? undefined,
    deliveryEastMalaysiaSen: row.portrait_frame_delivery_east_malaysia_sen ?? undefined,
    deliverySingaporeCents: resolvedPortraitSgShippingCents,
    deliveryDays: row.portrait_frame_delivery_days ?? undefined
  });

  const rawSgPrices = row.sg_product_prices_cents;
  const sgProductPricesCents = {
    keychain:
      rawSgPrices &&
      Number.isInteger(rawSgPrices.keychain) &&
      rawSgPrices.keychain >= 100 &&
      rawSgPrices.keychain <= 500000
        ? rawSgPrices.keychain
        : DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.keychain,
    magnet:
      rawSgPrices &&
      Number.isInteger(rawSgPrices.magnet) &&
      rawSgPrices.magnet >= 100 &&
      rawSgPrices.magnet <= 500000
        ? rawSgPrices.magnet
        : DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.magnet
  };

  return {
    logoUrl: row.logo_url?.trim() || defaults.logoUrl,
    heroImageUrl: !rawHero || rawHero === LEGACY_HERO_IMAGE_URL ? defaults.heroImageUrl : rawHero,
    productImages: {
      keychain:
        !rawKeychain || rawKeychain === LEGACY_KEYCHAIN_IMAGE_URL
          ? defaults.productImages.keychain
          : rawKeychain,
      magnet:
        !rawMagnet || rawMagnet === LEGACY_MAGNET_IMAGE_URL
          ? defaults.productImages.magnet
          : rawMagnet,
      bundle:
        !rawBundle || rawBundle === LEGACY_BUNDLE_IMAGE_URL
          ? defaults.productImages.bundle
          : rawBundle,
      portrait_frame:
        !rawPortraitFrame || rawPortraitFrame === LEGACY_PORTRAIT_FRAME_IMAGE_URL
          ? defaults.productImages.portrait_frame
          : rawPortraitFrame
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
    deliveryRateSingaporeCents: resolvedSgShippingCents,
    sgProductPricesCents,
    portraitFrameConfig,
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

// Transient per-instance locks & rate-limiting caches (all persistent records live in Supabase;
// upload & staff sessions use stateless HMAC-SHA256 tokens so they work across serverless instances and restarts).
const inFlightConfirmationEmails: Set<string> = new Set();
const inFlightMetaConversions: Set<string> = new Set();
const inFlightStripeEvents: Set<string> = new Set();
const orderOperationLocks: Map<string, Promise<void>> = new Map();
let lastMetaConnectionCheck: (MetaConnectionCheckResult & { pixelId: string | null }) | null = null;

async function withOrderLock<T>(reference: string, fn: () => Promise<T>): Promise<T> {
  const prev = orderOperationLocks.get(reference) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = prev.then(() => next);
  orderOperationLocks.set(reference, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (orderOperationLocks.get(reference) === chained) {
      orderOperationLocks.delete(reference);
    }
  }
}

function getOrderDeliveryCountry(order: OrderRow): DeliveryCountry {
  return normalizeDeliveryCountry(order.delivery_country) ?? 'MY';
}

function getOrderCurrency(order: OrderRow): SupportedCurrency {
  const country = getOrderDeliveryCountry(order);
  return normalizeCurrency(order.currency) ?? getCurrencyForCountry(country);
}

function getSettingsDeliveryRatesInput(settings: EditableStoreSettings) {
  return {
    peninsularSen: settings.deliveryRatesSen.peninsular,
    eastMalaysiaSen: settings.deliveryRatesSen.eastMalaysia,
    singaporeCents: settings.deliveryRateSingaporeCents
  };
}

/**
 * Inspects and expires any open/pending Stripe Checkout sessions for an unpaid order.
 * If an existing session is ALREADY paid on Stripe, returns { alreadyPaid: true } so
 * callers MUST abort mutations or duplicate session creation safely.
 */
async function expireOpenStripeSessionsForOrder(
  order: OrderRow,
  stripeClient: Stripe | null
): Promise<{ alreadyPaid: boolean; paidSessionId?: string; expiredCount: number }> {
  const payments = await fetchPaymentsForOrder(order.id);
  const pendingCardPayments = payments.filter(
    p => p.payment_method === 'card' && p.status === 'pending' && Boolean(p.stripe_session_id)
  );
  let expiredCount = 0;

  for (const payment of pendingCardPayments) {
    const sessionId = payment.stripe_session_id!;
    if (stripeClient) {
      try {
        const existingSession = await stripeClient.checkout.sessions.retrieve(sessionId);
        if (existingSession.payment_status === 'paid') {
          return { alreadyPaid: true, paidSessionId: sessionId, expiredCount };
        }
        if (existingSession.status === 'open') {
          await stripeClient.checkout.sessions.expire(sessionId);
          await updatePaymentById(payment.id, { status: 'superseded' });
          expiredCount += 1;
        } else if (existingSession.status === 'expired') {
          await updatePaymentById(payment.id, { status: 'expired' });
        } else {
          await updatePaymentById(payment.id, { status: 'superseded' });
        }
      } catch (err: any) {
        const msg = sanitizeSensitiveText(err?.message || err);
        // If Stripe reports the session is already expired/not open, mark superseded cleanly;
        // otherwise rethrow so we never leave an active live session un-invalidated when changing country!
        if (/already expired|status of 'expired'|cannot expire/i.test(msg)) {
          await updatePaymentById(payment.id, { status: 'expired' }).catch(() => {});
        } else {
          throw new Error(`Could not invalidate prior Stripe Checkout session (${sessionId}): ${msg}`);
        }
      }
    } else {
      await updatePaymentById(payment.id, { status: 'superseded' }).catch(() => {});
      expiredCount += 1;
    }
  }

  return { alreadyPaid: false, expiredCount };
}

interface AdminSessionRecord {
  sid: string;
  staffId: string | null;
  username: string;
  expiresAt: number;
}
const revokedAdminSessionIds: Map<string, number> = new Map();
const failedLoginTracker: Map<string, { count: number; resetAt: number }> = new Map();
const uploadSessionRateTracker: Map<string, { count: number; resetAt: number }> = new Map();
const uploadUrlRateTracker: Map<string, { count: number; resetAt: number }> = new Map();
const receiptUploadUrlRateTracker: Map<string, { count: number; resetAt: number }> = new Map();

const PHOTO_INTENT_TTL_MS = 15 * 60 * 1000; // 15 min
const RECEIPT_INTENT_TTL_MS = 15 * 60 * 1000; // 15 min
const MAX_UPLOAD_URLS_PER_WINDOW = 60;

// Best-effort per-instance cache ONLY for legacy callers that do not pass uploadIntentToken
interface LegacyPendingIntentCache {
  path: string;
  mime: 'image/jpeg' | 'image/png';
  name: string;
  prevPath: string | null;
  expiresAt: number;
}
const legacyPendingIntentBySid: Map<string, LegacyPendingIntentCache> = new Map();

function pruneTransientCaches(): void {
  const now = Date.now();
  for (const [sid, exp] of revokedAdminSessionIds.entries()) {
    if (exp < now) revokedAdminSessionIds.delete(sid);
  }
  for (const [sid, entry] of legacyPendingIntentBySid.entries()) {
    if (entry.expiresAt < now) legacyPendingIntentBySid.delete(sid);
  }
}

function checkRateLimit(
  trackerMap: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const existing = trackerMap.get(key);
  if (existing && existing.resetAt > now && existing.count >= maxRequests) {
    return false;
  }
  const nextCount = existing && existing.resetAt > now ? existing.count + 1 : 1;
  trackerMap.set(key, { count: nextCount, resetAt: now + windowMs });
  return true;
}

function getClientIp(req: express.Request): string {
  const netlifyIp = req.headers['x-nf-client-connection-ip'];
  if (typeof netlifyIp === 'string' && netlifyIp.trim()) return netlifyIp.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
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


function createAdminSession(
  staffId: string | null,
  username: string,
  secretMaterial: string
): string {
  const now = Date.now();
  const payload: AdminSessionPayload = {
    typ: 'admin_session',
    sid: crypto.randomBytes(16).toString('hex'),
    staffId,
    username,
    pv: computePasscodeVersion(secretMaterial),
    iat: now,
    exp: now + ADMIN_SESSION_TTL_MS
  };
  return signServerToken(payload);
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
  const deliveryCountry = getOrderDeliveryCountry(order);
  const currency = getOrderCurrency(order);
  const latestPaymentCurrency = latestPayment?.currency
    ? normalizeCurrency(latestPayment.currency)
    : null;

  return {
    reference: order.reference,
    accessToken: order.access_token,
    deliveryCountry,
    currency,
    allowedPaymentMethods: getAllowedPaymentMethodsForCountry(deliveryCountry),
    pricingBreakdown: order.pricing_breakdown ?? undefined,
    productId: order.product_id,
    bundleId: order.bundle_id ?? undefined,
    productName: order.product_name,
    itemQuantity: order.item_quantity,
    subtotalSen: order.subtotal_sen,
    regularSubtotalSen: order.regular_subtotal_sen ?? undefined,
    savingsSen: order.savings_sen ?? undefined,
    deliveryFeeSen: order.delivery_fee_sen,
    totalSen: order.total_sen,
    personalisationText: order.personalisation_text ?? undefined,
    deliveryDays: order.delivery_days ?? order.pricing_breakdown?.deliveryDays ?? 14,
    photoUrl,
    photoFileName: order.photo_original_filename ?? undefined,
    customer: {
      fullName: order.customer_full_name,
      email: order.customer_email,
      mobile: order.customer_mobile,
      address: order.customer_address,
      postcode: order.customer_postcode,
      city: order.customer_city,
      state: order.customer_state,
      country: deliveryCountry
    },
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method ?? null,
    paymentMethodLabel: getPaymentMethodDisplayLabel(order.payment_method),
    latestPaymentCurrency,
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

// Admin order serializer: includes sanitized email & Meta CAPI delivery details for authorised staff only
function toAdminOrder(hydrated: HydratedOrder, signedPhotoUrl: string) {
  const { confirmationEmail, metaPurchaseEvent } = hydrated;
  return {
    ...toPublicOrder(hydrated, signedPhotoUrl),
    confirmationEmailError: confirmationEmail?.error_message ?? undefined,
    confirmationEmailLastAttemptAt: confirmationEmail?.last_attempt_at ?? undefined,
    metaPurchaseStatus: metaPurchaseEvent?.status ?? null,
    metaPurchaseEventId: metaPurchaseEvent?.event_id ?? undefined,
    metaPurchaseSentAt: metaPurchaseEvent?.sent_at ?? undefined,
    metaPurchaseError: metaPurchaseEvent?.error_message ?? undefined,
    metaPurchaseAttemptCount: metaPurchaseEvent?.attempt_count ?? undefined,
    metaPurchaseTestMode: metaPurchaseEvent ? Boolean(metaPurchaseEvent.test_mode) : undefined
  };
}

function mapMetaConversionEventPublic(row: MetaConversionEventRow): MetaConversionEventPublic {
  return {
    orderReference: row.order_reference,
    eventName: row.event_name,
    eventId: row.event_id,
    eventTime: row.event_time,
    deliveryCountry: row.delivery_country === 'SG' ? 'SG' : 'MY',
    currency: row.currency === 'SGD' ? 'SGD' : 'MYR',
    valueMinor: row.value_minor,
    contentIds: Array.isArray(row.content_ids) ? row.content_ids : [],
    numItems: row.num_items,
    status: row.status,
    testMode: Boolean(row.test_mode),
    fbtraceId: row.fbtrace_id ?? null,
    eventsReceived: row.events_received ?? null,
    errorMessage: row.error_message ?? null,
    attemptCount: row.attempt_count,
    sentAt: row.sent_at ?? null,
    lastAttemptAt: row.last_attempt_at
  };
}

async function buildMetaTrackingDiagnostic(
  supabase: SupabaseHealthDiagnostic
): Promise<MetaTrackingDiagnostic> {
  const metaCfg = getMetaEnvConfig();
  const schemaReady = Boolean(supabase.metaConversionsSchemaReady);
  const recentRows = supabase.databaseReady
    ? await listRecentMetaConversionEvents(20).catch(() => [])
    : [];
  const recentEvents = recentRows.map(mapMetaConversionEventPublic);

  let sent = 0;
  let failed = 0;
  let notConfigured = 0;
  let skippedConsent = 0;
  let lastSuccessAt: string | null = null;

  for (const ev of recentEvents) {
    if (ev.status === 'sent') {
      sent += 1;
      if (ev.sentAt && (!lastSuccessAt || ev.sentAt > lastSuccessAt)) {
        lastSuccessAt = ev.sentAt;
      }
    } else if (ev.status === 'failed') {
      failed += 1;
    } else if (ev.status === 'not_configured') {
      notConfigured += 1;
    } else if (ev.status === 'skipped_consent') {
      skippedConsent += 1;
    }
  }

  const issues = [...metaCfg.issues];
  if (supabase.databaseReady && !schemaReady) {
    issues.push(
      'Run supabase/migrations/003_meta_conversions.sql in Supabase SQL Editor to persist Meta CAPI delivery logs and deduplication records.'
    );
  }

  // Only surface cached connection check if it matches the currently active runtime META_PIXEL_ID
  const activeCheck =
    lastMetaConnectionCheck &&
    lastMetaConnectionCheck.pixelId &&
    lastMetaConnectionCheck.pixelId === metaCfg.pixelId
      ? {
          checkedAt: lastMetaConnectionCheck.checkedAt,
          ok: lastMetaConnectionCheck.ok,
          status: lastMetaConnectionCheck.status,
          datasetName: lastMetaConnectionCheck.datasetName ?? null,
          message: lastMetaConnectionCheck.message
        }
      : null;

  const latestEvent = recentEvents[0] || null;
  let capiConnectionStatus: MetaTrackingDiagnostic['capiConnectionStatus'];
  let capiConnectionMessage: string;

  if (!metaCfg.capiConfigured) {
    capiConnectionStatus = 'not_configured';
    capiConnectionMessage =
      metaCfg.issues.join(' ') ||
      'Set META_PIXEL_ID and META_CAPI_ACCESS_TOKEN in server environment variables.';
  } else if (activeCheck) {
    capiConnectionStatus = activeCheck.ok ? 'connected' : 'error';
    capiConnectionMessage = activeCheck.message;
  } else if (latestEvent && latestEvent.status === 'sent') {
    capiConnectionStatus = 'connected';
    capiConnectionMessage = `Server CAPI credentials set for Dataset ID ${metaCfg.pixelId}. Most recent recorded Purchase event delivered cleanly; click Test CAPI Connection to verify active credentials.`;
  } else if (latestEvent && latestEvent.status === 'failed') {
    capiConnectionStatus = 'error';
    capiConnectionMessage =
      latestEvent.errorMessage ||
      'Most recent recorded Conversions API event delivery failed. Click Test CAPI Connection to verify active credentials.';
  } else {
    capiConnectionStatus = 'configured';
    capiConnectionMessage = `Server-side CAPI credentials configured for Dataset ID ${metaCfg.pixelId}. Click Test CAPI Connection to verify reachability.`;
  }

  return {
    pixelConfigured: metaCfg.pixelConfigured,
    pixelId: metaCfg.pixelId,
    capiConfigured: metaCfg.capiConfigured,
    capiConnectionStatus,
    capiConnectionMessage,
    testEventConfigured: metaCfg.testEventConfigured,
    testMode: metaCfg.testMode,
    schemaReady,
    lastSuccessAt,
    lastConnectionCheck: activeCheck,
    summary: {
      sent,
      failed,
      notConfigured,
      skippedConsent
    },
    recentEvents,
    issue: issues.length > 0 ? issues.join(' ') : undefined
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
    '/src/assets/': path.resolve(projectRoot, 'src/assets')
  };

  for (const prefix of allowedPrefixes) {
    if (normalized.startsWith(prefix)) {
      const baseDir = prefixToDir[prefix];
      const resolved =
        prefix === '/src/assets/'
          ? path.resolve(projectRoot, normalized.slice(1))
          : path.resolve(publicDir, normalized.slice(1));
      if (!resolved.startsWith(baseDir + path.sep)) {
        return { valid: false, reason: `Image path escapes ${prefix}.` };
      }
      // On Netlify serverless functions, static frontend assets live on the CDN rather than local disk
      if (!isServerlessRuntime || fs.existsSync(baseDir)) {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          if (!isServerlessRuntime) {
            return { valid: false, reason: `Image file not found at ${normalized}.` };
          }
        }
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

let cachedStripeSignature = '';
let cachedStripeClient: Stripe | null = null;
let lastStripeCheckoutDiagnostic: StripeCheckoutDiagnostic | null = null;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function sanitizeSensitiveText(raw: unknown, maxLen = 240): string {
  const rawMessage =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message?: unknown }).message || '')
        : String(raw || '');
  return rawMessage
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9_*]{4,}\b/gi, '$1_$2_[REDACTED]')
    .replace(/\bwhsec_[A-Za-z0-9_*]{4,}\b/gi, 'whsec_[REDACTED]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bre_[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function recordStripeCheckoutDiagnostic(
  diag: Omit<StripeCheckoutDiagnostic, 'timestamp'> & { stripeParam?: string }
): void {
  const sanitized: StripeCheckoutDiagnostic = {
    timestamp: new Date().toISOString(),
    stage: diag.stage,
    code: diag.code,
    mode: diag.mode,
    httpStatus: diag.httpStatus,
    ...(diag.stripeType ? { stripeType: diag.stripeType } : {}),
    ...(diag.stripeCode ? { stripeCode: diag.stripeCode } : {}),
    ...(diag.originSource ? { originSource: diag.originSource } : {}),
    message: sanitizeSensitiveText(diag.message || 'Stripe checkout failed.')
  };
  lastStripeCheckoutDiagnostic = sanitized;
  const logPayload = diag.stripeParam
    ? { ...sanitized, stripeParam: sanitizeSensitiveText(diag.stripeParam, 80) }
    : sanitized;
  console.error('[StripeCheckoutDiagnostic]', JSON.stringify(logPayload));
}

function getStripeConfig(supabaseHealth: SupabaseHealthDiagnostic): {
  client: Stripe | null;
  mode: 'test' | 'live' | 'unconfigured';
  webhookConfigured: boolean;
  livePaymentsEnabled: boolean;
  errorCode?: string;
  error?: string;
} {
  const secretKey = stripWrappingQuotes(process.env.STRIPE_SECRET_KEY || '');
  const webhookSecret = stripWrappingQuotes(process.env.STRIPE_WEBHOOK_SECRET || '');
  const webhookConfigured = webhookSecret.length > 0;
  const livePaymentsEnabled =
    stripWrappingQuotes(process.env.ENABLE_LIVE_PAYMENTS || '').toLowerCase() === 'true';

  if (!secretKey) {
    return {
      client: null,
      mode: 'unconfigured',
      webhookConfigured,
      livePaymentsEnabled,
      errorCode: 'STRIPE_KEY_MISSING',
      error: 'Add STRIPE_SECRET_KEY (sk_test_... or sk_live_...) on the server to enable card payments.'
    };
  }

  if (secretKey.startsWith('pk_test_') || secretKey.startsWith('pk_live_')) {
    return {
      client: null,
      mode: 'unconfigured',
      webhookConfigured,
      livePaymentsEnabled,
      errorCode: 'STRIPE_PUBLISHABLE_KEY_USED',
      error:
        'STRIPE_SECRET_KEY is set to a publishable key (pk_...). Replace it with a server secret key (sk_test_... or sk_live_...).'
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
      errorCode: 'STRIPE_KEY_INVALID_FORMAT',
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
      errorCode: 'SUPABASE_UNAVAILABLE',
      error:
        supabaseHealth.issue ||
        'Supabase database and private storage must be configured before enabling payments.'
    };
  }

  if (isLiveKey) {
    if (!livePaymentsEnabled) {
      return {
        client: null,
        mode: 'live',
        webhookConfigured,
        livePaymentsEnabled,
        errorCode: 'STRIPE_LIVE_MODE_DISABLED',
        error: 'Live Stripe payments stay disabled until ENABLE_LIVE_PAYMENTS=true is explicitly set.'
      };
    }
    if (!webhookConfigured) {
      return {
        client: null,
        mode: 'live',
        webhookConfigured,
        livePaymentsEnabled,
        errorCode: 'STRIPE_WEBHOOK_SECRET_MISSING',
        error: 'Live Stripe payments stay disabled until STRIPE_WEBHOOK_SECRET is configured.'
      };
    }
  }

  if (!cachedStripeClient || cachedStripeSignature !== secretKey) {
    cachedStripeClient = new Stripe(secretKey, {
      timeout: 20_000,
      maxNetworkRetries: 1
    });
    cachedStripeSignature = secretKey;
  }

  const warnings: string[] = [];
  if (!webhookConfigured) {
    warnings.push('STRIPE_WEBHOOK_SECRET is not set yet (required for automatic webhook confirmation).');
  }
  if (!isLiveKey && livePaymentsEnabled) {
    warnings.push('ENABLE_LIVE_PAYMENTS=true is set, but STRIPE_SECRET_KEY is a test key (running in Test Mode).');
  }

  return {
    client: cachedStripeClient,
    mode,
    webhookConfigured,
    livePaymentsEnabled,
    error: warnings.length > 0 ? warnings.join(' ') : undefined
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
  const fromAddress = stripWrappingQuotes(process.env.EMAIL_FROM || '');
  const hasValidFrom = isValidEmailFromHeader(fromAddress);
  const resendKey = stripWrappingQuotes(process.env.RESEND_API_KEY || '');

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
  const originInfo = resolveTrustedOriginInfo();
  // 4. Paid confirmation email (Resend) — independent of payment & storage config
  const emailInfo = getEmailConfig();
  // 5. Meta Pixel & Conversions API diagnostics — NEVER exposes META_CAPI_ACCESS_TOKEN
  const metaTracking = await buildMetaTrackingDiagnostic(supabase);

  const stripeIssues = [stripeInfo.error, originInfo.issue].filter(Boolean).join(' ');
  const sgConfigured =
    typeof settings.deliveryRateSingaporeCents === 'number' &&
    Number.isInteger(settings.deliveryRateSingaporeCents) &&
    settings.deliveryRateSingaporeCents >= 0;
  const sgEnvFee = resolveEnvSingaporeShippingCents();
  const sgSource: 'settings' | 'env' | 'unconfigured' = !sgConfigured
    ? 'unconfigured'
    : supabase.countryPricingSchemaReady
      ? 'settings'
      : sgEnvFee !== null
        ? 'env'
        : 'settings';

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
        redirectOrigin: originInfo.origin,
        redirectOriginSource: originInfo.source,
        issue: stripeIssues || undefined,
        lastCheckoutError: lastStripeCheckoutDiagnostic
      },
      singaporeShipping: {
        configured: sgConfigured,
        feeCents: sgConfigured ? settings.deliveryRateSingaporeCents : null,
        source: sgSource,
        issue: sgConfigured
          ? supabase.countryPricingSchemaReady === false
            ? 'Run supabase/migrations/002_country_based_pricing.sql in Supabase SQL Editor to persist Singapore (SGD) orders.'
            : undefined
          : 'Singapore delivery fee is not configured. Set a Singapore Delivery Fee (SGD) in Store & Payment Settings or SG_SHIPPING_FEE_CENTS on the server.'
      },
      email: emailInfo,
      metaTracking,
      supabase
    }
  };
}

function getPublicStorefrontConfig(settings: EditableStoreSettings) {
  const digits = settings.whatsappSupportNumber.replace(/\D/g, '');
  const whatsappUrl = digits.length >= 8 ? `https://wa.me/${digits}` : null;
  const singaporeShippingConfigured =
    typeof settings.deliveryRateSingaporeCents === 'number' &&
    Number.isInteger(settings.deliveryRateSingaporeCents) &&
    settings.deliveryRateSingaporeCents >= 0;
  const resolvedFrame = resolvePortraitFrameConfig(settings.portraitFrameConfig);
  const portraitFrameSingaporeShippingConfigured =
    typeof resolvedFrame.deliverySingaporeCents === 'number' &&
    Number.isInteger(resolvedFrame.deliverySingaporeCents) &&
    resolvedFrame.deliverySingaporeCents >= 0;
  const metaCfg = getMetaEnvConfig();
  return {
    logoUrl: settings.logoUrl,
    heroImageUrl: settings.heroImageUrl,
    productImages: settings.productImages,
    galleryItems: settings.galleryItems,
    deliveryRatesSen: settings.deliveryRatesSen,
    deliveryRateSingaporeCents: singaporeShippingConfigured
      ? settings.deliveryRateSingaporeCents
      : null,
    singaporeShippingConfigured,
    marketPricing: buildMarketPricingConfig(settings.sgProductPricesCents, resolvedFrame),
    portraitFrameConfig: {
      ...resolvedFrame,
      singaporeShippingConfigured: portraitFrameSingaporeShippingConfigured,
      deliveryPromiseText: buildDeliveryPromiseText(resolvedFrame.deliveryDays, true)
    },
    whatsappSupportNumber: digits,
    whatsappUrl,
    deliveryPromiseText: DELIVERY_PROMISE_TEXT,
    // Public Meta Pixel config ONLY — META_CAPI_ACCESS_TOKEN and META_TEST_EVENT_CODE remain strictly server-side
    metaTracking: {
      pixelId: metaCfg.pixelId,
      pixelConfigured: metaCfg.pixelConfigured,
      testMode: metaCfg.testMode
    }
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

function resolveTrustedOriginInfo(req?: express.Request): {
  origin: string;
  source: 'app_url' | 'request_headers' | 'fallback_localhost';
  issue?: string;
} {
  const configuredAppUrl = stripWrappingQuotes(
    process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || ''
  );
  let appUrlIssue: string | undefined;

  if (configuredAppUrl) {
    try {
      const parsed = new URL(configuredAppUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { origin: parsed.origin, source: 'app_url' };
      }
      appUrlIssue = 'APP_URL must start with https:// or http://.';
    } catch {
      appUrlIssue = 'APP_URL is not a valid URL.';
    }
  }

  if (!req) {
    return {
      origin: 'http://localhost:3000',
      source: 'fallback_localhost',
      issue: appUrlIssue
    };
  }

  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const rawHost = (forwardedHost || req.headers.host || '').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : '';

  if (safeHost) {
    const proto =
      forwardedProto === 'https' || forwardedProto === 'http'
        ? forwardedProto
        : req.protocol === 'https'
          ? 'https'
          : 'http';
    return {
      origin: `${proto}://${safeHost}`,
      source: 'request_headers',
      issue: appUrlIssue
    };
  }

  return {
    origin: 'http://localhost:3000',
    source: 'fallback_localhost',
    issue: appUrlIssue
  };
}

function resolveTrustedOrigin(req?: express.Request): string {
  return resolveTrustedOriginInfo(req).origin;
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
  const deliveryCountry = getOrderDeliveryCountry(order);
  const currency = getOrderCurrency(order);
  const countryLabel = formatCountryLabel(deliveryCountry);
  const subtotalText = formatCurrencyAmount(order.subtotal_sen, currency);
  const deliveryFeeText = formatCurrencyAmount(order.delivery_fee_sen, currency);
  const savingsText =
    order.savings_sen && order.savings_sen > 0
      ? formatCurrencyAmount(order.savings_sen, currency)
      : null;
  const totalPaid = formatCurrencyWithCode(order.total_sen, currency);
  const isPortraitFrame = order.product_id === PORTRAIT_FRAME_PRODUCT_ID;
  const deliveryDays = order.delivery_days ?? order.pricing_breakdown?.deliveryDays ?? 14;
  const deliveryPromiseText = buildDeliveryPromiseText(deliveryDays, isPortraitFrame);
  const personalisationNote = sanitizePersonalisationText(order.personalisation_text);
  const deliveryAddress =
    deliveryCountry === 'SG'
      ? `${order.customer_address}, Singapore ${order.customer_postcode}`
      : `${order.customer_address}, ${order.customer_postcode} ${order.customer_city}, ${order.customer_state}, Malaysia`;
  const subject = `Order Confirmed — Little Pixel Keepsakes (${order.reference})`;

  const text = [
    PAID_CONFIRMATION_HEADING,
    '',
    `Hi ${order.customer_full_name},`,
    '',
    `Order Reference: ${order.reference}`,
    `Delivery Country: ${countryLabel}`,
    `Delivery Address: ${deliveryAddress}`,
    `Currency: ${currency}`,
    `Items: ${order.product_name} (Qty ${order.item_quantity})`,
    ...(isPortraitFrame ? ['Frame Details: Wooden frame included (20 cm x 17 cm)'] : []),
    ...(personalisationNote
      ? [`Frame Personalisation: "${personalisationNote}" (subject to production feasibility)`]
      : []),
    `Items Subtotal: ${subtotalText}`,
    ...(savingsText ? [`Bundle Savings (20% off): - ${savingsText}`] : []),
    `Delivery Fee: ${deliveryFeeText}`,
    `Total Paid: ${totalPaid}`,
    `Payment Method: ${methodLabel}`,
    '',
    deliveryPromiseText,
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
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Delivery Country:</strong> ${escapeHtml(countryLabel)}</p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Delivery Address:</strong> ${escapeHtml(deliveryAddress)}</p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Currency:</strong> ${escapeHtml(currency)}</p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Items:</strong> ${escapeHtml(order.product_name)} (Qty ${order.item_quantity})</p>
        ${isPortraitFrame ? '<p style="margin: 0 0 8px; font-size: 13px;"><strong>Frame Details:</strong> Wooden frame included (20 cm x 17 cm)</p>' : ''}
        ${personalisationNote ? `<p style="margin: 0 0 8px; font-size: 13px;"><strong>Frame Personalisation:</strong> &ldquo;${escapeHtml(personalisationNote)}&rdquo; <span style="color: #526075;">(subject to production feasibility)</span></p>` : ''}
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Items Subtotal:</strong> ${escapeHtml(subtotalText)}</p>
        ${savingsText ? `<p style="margin: 0 0 8px; font-size: 13px; color: #047857;"><strong>Bundle Savings (20% off):</strong> - ${escapeHtml(savingsText)}</p>` : ''}
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Delivery Fee:</strong> ${escapeHtml(deliveryFeeText)}</p>
        <p style="margin: 0 0 8px; font-size: 14px;"><strong>Total Paid:</strong> ${escapeHtml(totalPaid)}</p>
        <p style="margin: 0; font-size: 13px;"><strong>Payment Method:</strong> ${escapeHtml(methodLabel)}</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 20px; font-weight: 600;">${escapeHtml(deliveryPromiseText)}</p>
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
        Authorization: `Bearer ${stripWrappingQuotes(process.env.RESEND_API_KEY || '')}`,
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

// Guaranteed at-most-once server-side Meta Conversions API Purchase event per verified Paid order.
// Tracked & deduplicated in public.meta_conversion_events using deterministic event_id = `purchase_${order.reference}`.
// NEVER sends events for unpaid or pending-verification orders and NEVER disrupts payment confirmation.
async function sendMetaPurchaseEventOnce(
  order: OrderRow,
  req?: express.Request
): Promise<{
  sent: boolean;
  skipped?: boolean;
  status: MetaConversionEventStatus;
  eventId: string;
  error?: string;
}> {
  const eventId = buildPurchaseEventId(order.reference);
  if (order.payment_status !== 'Paid') {
    return { sent: false, skipped: true, status: 'not_configured', eventId };
  }

  return withOrderLock(`meta-purchase:${order.reference}`, async () => {
    if (inFlightMetaConversions.has(order.reference)) {
      return { sent: false, skipped: true, status: 'sent', eventId };
    }

    const existing = await fetchMetaPurchaseEvent(order.id).catch(() => null);
    if (existing?.sent_at || existing?.status === 'sent') {
      return { sent: false, skipped: true, status: 'sent', eventId };
    }

    const deliveryCountry = getOrderDeliveryCountry(order);
    const currency = getOrderCurrency(order);
    const contentId = resolveMetaContentId(order.product_id, order.bundle_id);
    const numItems = resolveMetaNumItems(order.product_id, order.bundle_id, order.item_quantity);
    const paidAtIso = order.paid_at || new Date().toISOString();
    const parsedPaidMs = Date.parse(paidAtIso);
    const eventTime = Math.floor((Number.isFinite(parsedPaidMs) ? parsedPaidMs : Date.now()) / 1000);
    const attemptCount = (existing?.attempt_count || 0) + 1;
    const attemptTime = new Date().toISOString();
    const metaCfg = getMetaEnvConfig();

    // Respect customer marketing consent opt-out stored at checkout
    if (order.meta_marketing_consent === false) {
      await upsertMetaPurchaseEvent({
        orderId: order.id,
        orderReference: order.reference,
        eventId,
        eventTime,
        deliveryCountry,
        currency,
        valueMinor: order.total_sen,
        contentIds: [contentId],
        numItems,
        status: 'skipped_consent',
        testMode: metaCfg.testMode,
        errorMessage: 'Customer opted out of marketing tracking.',
        attemptCount,
        sentAt: null,
        lastAttemptAt: attemptTime
      }).catch(err =>
        console.error(`Failed to record Meta consent skip for ${order.reference}:`, sanitizeMetaError(err))
      );
      return { sent: false, skipped: true, status: 'skipped_consent', eventId };
    }

    inFlightMetaConversions.add(order.reference);
    try {
      const originUrl = resolveTrustedOrigin(req);
      const cleanSourceUrl = sanitizeEventSourceUrl(order.meta_event_source_url, originUrl);

      const sendResult = await sendMetaCapiPurchaseEvent({
        orderReference: order.reference,
        deliveryCountry,
        currency,
        productId: order.product_id,
        bundleId: order.bundle_id,
        productName: order.product_name,
        itemQuantity: order.item_quantity,
        subtotalMinor: order.subtotal_sen,
        totalMinor: order.total_sen,
        paidAtIso,
        customerEmail: order.customer_email,
        customerPhone: order.customer_mobile,
        fbp: order.meta_fbp ?? null,
        fbc: order.meta_fbc ?? null,
        clientIpAddress: order.meta_client_ip ?? null,
        clientUserAgent: order.meta_client_user_agent ?? null,
        eventSourceUrl: cleanSourceUrl
      });

      if (sendResult.ok) {
        const sentAt = new Date().toISOString();
        await upsertMetaPurchaseEvent({
          orderId: order.id,
          orderReference: order.reference,
          eventId: sendResult.eventId,
          eventTime: sendResult.eventTime,
          deliveryCountry,
          currency,
          valueMinor: order.total_sen,
          contentIds: sendResult.contentIds,
          numItems: sendResult.numItems,
          status: 'sent',
          testMode: sendResult.testMode,
          fbtraceId: sendResult.fbtraceId ?? null,
          eventsReceived: sendResult.eventsReceived ?? 1,
          errorMessage: null,
          attemptCount,
          sentAt,
          lastAttemptAt: attemptTime
        }).catch(err =>
          console.error(`Failed to persist Meta CAPI success for ${order.reference}:`, sanitizeMetaError(err))
        );
        return { sent: true, status: 'sent', eventId: sendResult.eventId };
      }

      const finalStatus: MetaConversionEventStatus = sendResult.notConfigured
        ? 'not_configured'
        : 'failed';
      const safeError = sanitizeMetaError(
        sendResult.error || 'Meta Conversions API Purchase delivery failed.'
      );
      if (finalStatus === 'failed') {
        console.error(`Meta CAPI Purchase failed for order ${order.reference}: ${safeError}`);
      }

      await upsertMetaPurchaseEvent({
        orderId: order.id,
        orderReference: order.reference,
        eventId: sendResult.eventId,
        eventTime: sendResult.eventTime,
        deliveryCountry,
        currency,
        valueMinor: order.total_sen,
        contentIds: sendResult.contentIds,
        numItems: sendResult.numItems,
        status: finalStatus,
        testMode: sendResult.testMode,
        fbtraceId: sendResult.fbtraceId ?? null,
        eventsReceived: null,
        errorMessage: safeError,
        attemptCount,
        sentAt: null,
        lastAttemptAt: attemptTime
      }).catch(err =>
        console.error(`Failed to persist Meta CAPI error for ${order.reference}:`, sanitizeMetaError(err))
      );

      return { sent: false, status: finalStatus, eventId: sendResult.eventId, error: safeError };
    } finally {
      inFlightMetaConversions.delete(order.reference);
    }
  });
}

interface AuthenticatedAdminRequest extends express.Request {
  adminSession?: AdminSessionRecord;
}

async function requireAdminAuth(
  req: AuthenticatedAdminRequest,
  res: express.Response,
  next: express.NextFunction
) {
  pruneTransientCaches();
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Staff authentication required.' });
  }
  const token = authHeader.slice(7).trim();
  const payload = verifyServerToken<AdminSessionPayload>(token, 'admin_session');
  if (!payload) {
    return res.status(401).json({ error: 'Admin session expired or invalid. Please sign in again.' });
  }
  if (revokedAdminSessionIds.has(payload.sid)) {
    return res.status(401).json({ error: 'Admin session has been signed out. Please sign in again.' });
  }

  // Verify token still matches active environment passcode or active Supabase staff account
  if (payload.staffId) {
    try {
      const account = await fetchStaffAccountById(payload.staffId);
      if (!account || !account.is_active) {
        return res.status(401).json({ error: 'Staff account is no longer active. Please sign in again.' });
      }
      const expectedPv = computePasscodeVersion(`staff:${account.id}:${account.password_hash}`);
      if (!safeEqualStrings(payload.pv, expectedPv)) {
        return res.status(401).json({ error: 'Admin session expired due to credential update. Please sign in again.' });
      }
    } catch (err) {
      console.error('Admin session verification error:', sanitizeSupabaseError(err));
      return res.status(503).json({ error: 'Unable to verify staff session right now. Please try again.' });
    }
  } else {
    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (!envPasscode) {
      return res.status(401).json({ error: 'Admin session expired or invalid. Please sign in again.' });
    }
    const expectedPv = computePasscodeVersion(`env:${envPasscode}`);
    if (!safeEqualStrings(payload.pv, expectedPv)) {
      return res.status(401).json({ error: 'Admin session expired due to passcode update. Please sign in again.' });
    }
  }

  req.adminSession = {
    sid: payload.sid,
    staffId: payload.staffId,
    username: payload.username,
    expiresAt: payload.exp
  };
  return next();
}

async function requireSupabaseReady(res: express.Response): Promise<SupabaseHealthDiagnostic | null> {
  try {
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
  } catch (err) {
    const msg = sanitizeSupabaseError(err);
    clearSupabaseHealthCache();
    res.status(503).json({
      error: `Unable to verify Supabase availability: ${msg}`,
      code: 'SUPABASE_UNAVAILABLE'
    });
    return null;
  }
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

export function createApiApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  // Normalize Netlify Functions request paths so /api/* routes work identically on Netlify Functions and Node
  app.use((req, _res, next) => {
    if (req.url.startsWith('/.netlify/functions/api/api/')) {
      req.url = req.url.slice('/.netlify/functions/api'.length);
    } else if (req.url.startsWith('/.netlify/functions/api/')) {
      req.url = '/api/' + req.url.slice('/.netlify/functions/api/'.length);
    } else if (
      req.url === '/.netlify/functions/api' ||
      req.url.startsWith('/.netlify/functions/api?')
    ) {
      req.url = '/api' + req.url.slice('/.netlify/functions/api'.length);
    }
    next();
  });

  // ============================================================================
  // STRIPE WEBHOOK (Raw body before express.json)
  // ============================================================================
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = stripWrappingQuotes(process.env.STRIPE_WEBHOOK_SECRET || '');
    const supabaseHealth = await checkSupabaseHealth();

    if (!supabaseHealth.configured) {
      return res.status(503).json({
        error: supabaseHealth.issue || 'Supabase is unavailable; cannot process webhook.',
        code: 'SUPABASE_UNAVAILABLE'
      });
    }

    const stripeInfo = getStripeConfig(supabaseHealth);
    if (!stripeInfo.client) {
      return res.status(503).json({
        error: 'Stripe is not configured on this server.',
        code: 'STRIPE_UNAVAILABLE'
      });
    }
    if (!webhookSecret) {
      return res.status(500).json({
        error: 'Stripe webhook signing secret is not configured on the server.',
        code: 'STRIPE_WEBHOOK_SECRET_MISSING'
      });
    }
    if (!sig || typeof sig !== 'string') {
      return res.status(400).json({
        error: 'Missing Stripe-Signature header.',
        code: 'MISSING_WEBHOOK_SIGNATURE'
      });
    }

    let event: Stripe.Event;
    try {
      event = stripeInfo.client.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error('Webhook signature verification failed:', sanitizeSensitiveText(err?.message || err));
      return res.status(400).json({
        error: 'Webhook signature verification failed.',
        code: 'INVALID_WEBHOOK_SIGNATURE'
      });
    }

    if (inFlightStripeEvents.has(event.id)) {
      return res.json({ received: true, duplicate: true });
    }
    inFlightStripeEvents.add(event.id);

    try {
      if (await hasProcessedStripeEvent(event.id)) {
        return res.json({ received: true, duplicate: true });
      }

      const expectedLivemode = stripeInfo.mode === 'live';
      if (Boolean(event.livemode) !== expectedLivemode) {
        console.warn(`Stripe webhook livemode mismatch for event ${event.id}`, {
          expectedLivemode,
          receivedLivemode: Boolean(event.livemode)
        });
        return res.json({ received: true, ignored: 'mode_mismatch' });
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

        return await withOrderLock(reference, async () => {
          const order = await fetchOrderByReference(reference);
          if (!order) {
            return res.json({ received: true, ignored: 'order_not_found' });
          }

          // Already confirmed Paid — idempotent no-op (never sends a duplicate confirmation email)
          if (order.payment_status === 'Paid') {
            return res.json({ received: true, duplicate: true });
          }

          const orderCountry = getOrderDeliveryCountry(order);
          const expectedCurrencyLower = getOrderCurrency(order).toLowerCase();

          // Strictly verify this Stripe session was created by this server for this exact order, country, currency & amount
          const paymentRow = await fetchPaymentByStripeSessionId(session.id);
          if (paymentRow?.status === 'paid') {
            return res.json({ received: true, duplicate: true });
          }

          const paymentCurrencyLower = (paymentRow?.currency || '').toLowerCase();
          const metadataCountry = session.metadata?.deliveryCountry
            ? normalizeDeliveryCountry(session.metadata.deliveryCountry)
            : null;
          const countryMatches = !metadataCountry || metadataCountry === orderCountry;

          const sessionMatchesOrder = Boolean(
            paymentRow &&
              paymentRow.order_id === order.id &&
              paymentRow.payment_method === 'card' &&
              paymentRow.status !== 'superseded' &&
              paymentRow.amount_sen === order.total_sen &&
              paymentCurrencyLower === expectedCurrencyLower &&
              countryMatches
          );

          const amountTotal = session.amount_total;
          const currency = (session.currency || '').toLowerCase();
          const paymentStatus = session.payment_status;

          if (
            sessionMatchesOrder &&
            paymentRow &&
            typeof amountTotal === 'number' &&
            amountTotal === order.total_sen &&
            currency === expectedCurrencyLower &&
            paymentStatus === 'paid'
          ) {
            const paidAt = new Date().toISOString();
            const paymentIntentId =
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id || null;

            const updatedOrder = await updateOrderIfUnpaid(reference, {
              payment_status: 'Paid',
              payment_method: 'card',
              paid_at: paidAt,
              correction_reason: null,
              last_card_attempt_message: null
            });

            if (!updatedOrder) {
              return res.json({ received: true, duplicate: true });
            }

            await updatePaymentById(paymentRow.id, {
              status: 'paid',
              stripe_payment_intent_id: paymentIntentId,
              stripe_event_id: event.id,
              paid_at: paidAt
            });

            try {
              await sendOrderConfirmationEmailOnce(updatedOrder, req);
            } catch (emailErr) {
              console.error(`Unexpected confirmation email error for order ${reference}:`, emailErr);
            }
            try {
              await sendMetaPurchaseEventOnce(updatedOrder, req);
            } catch (metaErr) {
              console.error(`Unexpected Meta CAPI error for order ${reference}:`, sanitizeMetaError(metaErr));
            }
            console.log(
              `Order ${reference} (${orderCountry}/${expectedCurrencyLower.toUpperCase()}) confirmed Paid via verified Stripe webhook (${event.id}).`
            );
            return res.json({ received: true });
          } else {
            console.warn(`Stripe webhook mismatch for order ${reference}`, {
              eventId: event.id,
              sessionMatchesOrder,
              paymentStatusRow: paymentRow?.status,
              expectedCountry: orderCountry,
              metadataCountry,
              expectedCurrency: expectedCurrencyLower,
              receivedCurrency: currency,
              expectedAmount: order.total_sen,
              receivedAmount: amountTotal,
              paymentStatus
            });
            return res.json({ received: true, ignored: 'validation_mismatch' });
          }
        });
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
    } finally {
      inFlightStripeEvents.delete(event.id);
    }
  });

  app.use(express.json({ limit: '16mb' }));

  // ============================================================================
  // PUBLIC HEALTH & STOREFRONT CONFIG
  // ============================================================================
  app.get('/api/health', async (_req, res) => {
    const supabase = await checkSupabaseHealth();
    return res.status(supabase.configured ? 200 : 503).json({
      ok: supabase.configured,
      runtime: isServerlessRuntime ? 'serverless' : 'node',
      supabaseReady: supabase.configured,
      databaseReady: supabase.databaseReady,
      photosBucketReady: supabase.photosBucketReady,
      receiptsBucketReady: supabase.receiptsBucketReady
    });
  });

  app.get('/api/store-config', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
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
  // SECURE CUSTOMER PHOTO UPLOAD SESSIONS (STATELESS HMAC + PRIVATE SUPABASE BUCKET)
  // ============================================================================
  app.post('/api/photo-upload-session', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    try {
      pruneTransientCaches();

      const ip = getClientIp(req);
      if (!checkRateLimit(uploadSessionRateTracker, ip, MAX_UPLOAD_SESSIONS_PER_WINDOW, LOGIN_WINDOW_MS)) {
        return res.status(429).json({
          error: 'Too many photo upload sessions started recently. Please wait a few minutes and try again.',
          code: 'UPLOAD_SESSION_RATE_LIMITED'
        });
      }

      const now = Date.now();
      const sessionId = crypto.randomBytes(16).toString('hex');
      const expiresAt = now + PHOTO_UPLOAD_SESSION_TTL_MS;

      const token = signServerToken<PhotoSessionPayload>({
        typ: 'photo_session',
        sid: sessionId,
        iat: now,
        exp: expiresAt
      });

      return res.json({
        success: true,
        uploadSessionToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
        maxFileSizeBytes: MAX_UPLOAD_BYTES,
        allowedMimeTypes: ['image/jpeg', 'image/png']
      });
    } catch (err) {
      console.error('Photo upload session creation error:', sanitizeSensitiveText(err));
      return res.status(500).json({
        error: 'Unable to start a secure photo upload session. Please try again.',
        code: 'UPLOAD_SESSION_CREATE_FAILED'
      });
    }
  });

  // Step 1 (Direct Signed Upload): Issue a short-lived signed upload URL scoped to private customer-photos
  app.post('/api/upload-photo-url', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneTransientCaches();

    const ip = getClientIp(req);
    if (!checkRateLimit(uploadUrlRateTracker, ip, MAX_UPLOAD_URLS_PER_WINDOW, LOGIN_WINDOW_MS)) {
      return res.status(429).json({
        error: 'Too many photo upload requests right now. Please wait a moment and try again.',
        code: 'UPLOAD_RATE_LIMITED'
      });
    }

    const headerSession =
      typeof req.headers['x-upload-session'] === 'string' ? req.headers['x-upload-session'].trim() : '';
    const bodySession =
      typeof req.body?.uploadSessionToken === 'string' ? req.body.uploadSessionToken.trim() : '';
    const uploadSessionToken = headerSession || bodySession;

    if (!uploadSessionToken) {
      return res.status(401).json({
        error: 'A valid secure photo upload session is required.',
        code: 'UPLOAD_SESSION_REQUIRED'
      });
    }

    const sessionPayload = verifyServerToken<PhotoSessionPayload | PhotoVerifiedPayload>(
      uploadSessionToken,
      ['photo_session', 'photo_verified']
    );
    if (!sessionPayload) {
      return res.status(401).json({
        error: 'Your photo upload session has expired. Please retry your upload.',
        code: 'UPLOAD_SESSION_EXPIRED'
      });
    }

    try {
      const { filename, mimeType, sizeBytes } = req.body || {};
      const normalizedRawMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
      if (
        normalizedRawMime !== 'image/jpeg' &&
        normalizedRawMime !== 'image/jpg' &&
        normalizedRawMime !== 'image/png'
      ) {
        return res.status(400).json({
          error: 'Please upload a clear JPG or PNG image.',
          code: 'INVALID_IMAGE_TYPE'
        });
      }
      const resolvedMime: 'image/jpeg' | 'image/png' =
        normalizedRawMime === 'image/png' ? 'image/png' : 'image/jpeg';

      if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return res.status(400).json({
          error: 'Selected photo file is empty or unreadable.',
          code: 'INVALID_IMAGE_SIZE'
        });
      }
      if (sizeBytes > MAX_UPLOAD_BYTES) {
        return res.status(413).json({
          error: 'Photo must be smaller than 10 MB.',
          code: 'FILE_TOO_LARGE'
        });
      }

      const cfg = getSupabaseEnvConfig();
      const ext = resolvedMime === 'image/png' ? 'png' : 'jpg';
      const storagePath = `pending/${sessionPayload.sid}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const originalFilename = sanitizeDisplayFilename(filename, 'customer_photo', ext);
      const previousVerifiedPath =
        sessionPayload.typ === 'photo_verified' ? sessionPayload.path : null;

      const signed = await createSignedPrivateUploadUrl(cfg.photosBucket, storagePath);

      const now = Date.now();
      const intentExp = now + PHOTO_INTENT_TTL_MS;
      const uploadIntentToken = signServerToken<PhotoIntentPayload>({
        typ: 'photo_intent',
        sid: sessionPayload.sid,
        path: storagePath,
        mime: resolvedMime,
        name: originalFilename,
        prevPath: previousVerifiedPath,
        iat: now,
        exp: intentExp
      });

      legacyPendingIntentBySid.set(sessionPayload.sid, {
        path: storagePath,
        mime: resolvedMime,
        name: originalFilename,
        prevPath: previousVerifiedPath,
        expiresAt: intentExp
      });

      return res.json({
        success: true,
        uploadSessionToken,
        uploadIntentToken,
        signedUploadUrl: signed.signedUrl,
        photoStoragePath: storagePath,
        mimeType: resolvedMime,
        fileName: originalFilename,
        maxFileSizeBytes: MAX_UPLOAD_BYTES
      });
    } catch (err) {
      console.error('Signed photo upload URL error:', sanitizeSupabaseError(err));
      clearSupabaseHealthCache();
      return res.status(502).json({
        error: 'Could not authorize secure storage upload right now. Please try again.',
        code: 'SIGNED_UPLOAD_URL_FAILED'
      });
    }
  });

  // Step 2 (Direct Signed Upload): Verify uploaded private object size & magic bytes and issue verified order session token
  app.post('/api/upload-photo/confirm', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneTransientCaches();

    const headerSession =
      typeof req.headers['x-upload-session'] === 'string' ? req.headers['x-upload-session'].trim() : '';
    const bodySession =
      typeof req.body?.uploadSessionToken === 'string' ? req.body.uploadSessionToken.trim() : '';
    const uploadSessionToken = headerSession || bodySession;

    if (!uploadSessionToken) {
      return res.status(401).json({
        error: 'A valid secure photo upload session is required.',
        code: 'UPLOAD_SESSION_REQUIRED'
      });
    }

    const sessionPayload = verifyServerToken<PhotoSessionPayload | PhotoVerifiedPayload>(
      uploadSessionToken,
      ['photo_session', 'photo_verified']
    );
    if (!sessionPayload) {
      return res.status(401).json({
        error: 'Your photo upload session has expired. Please retry your upload.',
        code: 'UPLOAD_SESSION_EXPIRED'
      });
    }

    const { photoStoragePath, uploadIntentToken } = req.body || {};
    const requestedPath = typeof photoStoragePath === 'string' ? photoStoragePath.trim() : '';

    // Verify signed stateless upload intent token (works across ANY serverless instance)
    let targetPath = '';
    let expectedMime: 'image/jpeg' | 'image/png' = 'image/jpeg';
    let originalFilename = 'customer_photo.jpg';
    let previousVerifiedPath: string | null =
      sessionPayload.typ === 'photo_verified' ? sessionPayload.path : null;

    if (typeof uploadIntentToken === 'string' && uploadIntentToken.trim()) {
      const intent = verifyServerToken<PhotoIntentPayload>(uploadIntentToken.trim(), 'photo_intent');
      if (
        !intent ||
        !safeEqualStrings(intent.sid, sessionPayload.sid) ||
        !requestedPath ||
        !safeEqualStrings(requestedPath, intent.path)
      ) {
        return res.status(400).json({
          error: 'Uploaded photo reference does not match your active upload session.',
          code: 'UPLOAD_PATH_MISMATCH'
        });
      }
      targetPath = intent.path;
      expectedMime = intent.mime;
      originalFilename = intent.name;
      if (intent.prevPath) previousVerifiedPath = intent.prevPath;
    } else {
      // Backward-compatible fallback for callers that did not include uploadIntentToken
      const cached = legacyPendingIntentBySid.get(sessionPayload.sid);
      if (
        !cached ||
        cached.expiresAt < Date.now() ||
        !requestedPath ||
        !safeEqualStrings(requestedPath, cached.path)
      ) {
        return res.status(400).json({
          error: 'Uploaded photo reference does not match your active upload session.',
          code: 'UPLOAD_PATH_MISMATCH'
        });
      }
      targetPath = cached.path;
      expectedMime = cached.mime;
      originalFilename = cached.name;
      if (cached.prevPath) previousVerifiedPath = cached.prevPath;
    }

    if (!targetPath.startsWith(`pending/${sessionPayload.sid}/`)) {
      return res.status(400).json({
        error: 'Uploaded photo path is outside your active upload session scope.',
        code: 'UPLOAD_PATH_MISMATCH'
      });
    }

    const cfg = getSupabaseEnvConfig();

    try {
      const { buffer } = await downloadPrivateFile(cfg.photosBucket, targetPath);

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        void removePrivateFile(cfg.photosBucket, targetPath);
        return res.status(400).json({
          error: 'Photo must be a valid image smaller than 10 MB.',
          code: 'INVALID_IMAGE_SIZE'
        });
      }

      if (!verifyMagicBytes(buffer, expectedMime)) {
        void removePrivateFile(cfg.photosBucket, targetPath);
        return res.status(400).json({
          error: 'Uploaded file does not match a valid JPG or PNG image.',
          code: 'INVALID_IMAGE_CONTENT'
        });
      }

      if (previousVerifiedPath && previousVerifiedPath !== targetPath) {
        void removePrivateFile(cfg.photosBucket, previousVerifiedPath);
      }
      legacyPendingIntentBySid.delete(sessionPayload.sid);

      const now = Date.now();
      const verifiedSessionToken = signServerToken<PhotoVerifiedPayload>({
        typ: 'photo_verified',
        sid: sessionPayload.sid,
        path: targetPath,
        mime: expectedMime,
        name: originalFilename,
        size: buffer.length,
        iat: now,
        exp: now + PHOTO_UPLOAD_SESSION_TTL_MS
      });

      const signedPreviewUrl = await createShortLivedSignedUrl(cfg.photosBucket, targetPath, 900);

      return res.json({
        success: true,
        uploadSessionToken: verifiedSessionToken,
        photoStoragePath: targetPath,
        photoUrl: signedPreviewUrl || '',
        fileName: originalFilename,
        mimeType: expectedMime,
        sizeBytes: buffer.length
      });
    } catch (err) {
      console.error('Private photo upload verification error:', sanitizeSupabaseError(err));
      return res.status(502).json({
        error: 'Could not verify your uploaded photo in private storage. Please try again.',
        code: 'UPLOAD_VERIFICATION_FAILED'
      });
    }
  });

  // Backend binary photo upload fallback (supports raw binary image/jpeg & image/png as well as legacy JSON Base64)
  app.post(
    '/api/upload-photo',
    express.raw({ type: ['image/jpeg', 'image/jpg', 'image/png'], limit: '11mb' }),
    async (req, res) => {
      const health = await requireSupabaseReady(res);
      if (!health) return;

      pruneTransientCaches();

      const contentTypeHeader = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const isRawBinary =
        contentTypeHeader === 'image/jpeg' ||
        contentTypeHeader === 'image/jpg' ||
        contentTypeHeader === 'image/png';

      const headerSession =
        typeof req.headers['x-upload-session'] === 'string' ? req.headers['x-upload-session'].trim() : '';
      const bodySession =
        !isRawBinary && typeof req.body?.uploadSessionToken === 'string'
          ? req.body.uploadSessionToken.trim()
          : '';
      const uploadSessionToken = headerSession || bodySession;

      if (!uploadSessionToken) {
        return res.status(401).json({
          error: 'A valid secure photo upload session is required.',
          code: 'UPLOAD_SESSION_REQUIRED'
        });
      }

      const sessionPayload = verifyServerToken<PhotoSessionPayload | PhotoVerifiedPayload>(
        uploadSessionToken,
        ['photo_session', 'photo_verified']
      );
      if (!sessionPayload) {
        return res.status(401).json({
          error: 'Your photo upload session has expired. Please retry your upload.',
          code: 'UPLOAD_SESSION_EXPIRED'
        });
      }

      try {
        let mimeType: 'image/jpeg' | 'image/png';
        let buffer: Buffer;
        let rawFilename: unknown;

        if (isRawBinary) {
          if (!Buffer.isBuffer(req.body)) {
            return res.status(400).json({
              error: 'No binary image data received.',
              code: 'NO_IMAGE_DATA'
            });
          }
          mimeType = contentTypeHeader === 'image/png' ? 'image/png' : 'image/jpeg';
          buffer = req.body;
          const rawHeaderName = req.headers['x-file-name'];
          if (typeof rawHeaderName === 'string' && rawHeaderName.trim()) {
            try {
              rawFilename = decodeURIComponent(rawHeaderName.trim());
            } catch {
              rawFilename = rawHeaderName.trim();
            }
          }
        } else {
          const { imageBase64, filename } = req.body || {};
          if (typeof imageBase64 !== 'string' || !imageBase64) {
            return res.status(400).json({
              error: 'No image data provided.',
              code: 'NO_IMAGE_DATA'
            });
          }

          const commaIdx = imageBase64.indexOf(',');
          if (commaIdx <= 0) {
            return res.status(400).json({
              error: 'Please upload a clear JPG or PNG image.',
              code: 'INVALID_IMAGE_TYPE'
            });
          }
          const prefix = imageBase64.slice(0, commaIdx).toLowerCase();
          if (
            prefix !== 'data:image/jpeg;base64' &&
            prefix !== 'data:image/jpg;base64' &&
            prefix !== 'data:image/png;base64'
          ) {
            return res.status(400).json({
              error: 'Please upload a clear JPG or PNG image.',
              code: 'INVALID_IMAGE_TYPE'
            });
          }
          mimeType = prefix === 'data:image/png;base64' ? 'image/png' : 'image/jpeg';
          const base64Body = imageBase64.slice(commaIdx + 1).trim();
          if (!base64Body) {
            return res.status(400).json({
              error: 'No image data provided.',
              code: 'NO_IMAGE_DATA'
            });
          }
          buffer = Buffer.from(base64Body, 'base64');
          rawFilename = filename;
        }

        const ext = mimeType === 'image/png' ? 'png' : 'jpg';

        if (buffer.length === 0) {
          return res.status(400).json({
            error: 'Uploaded photo file is empty.',
            code: 'INVALID_IMAGE_SIZE'
          });
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
          return res.status(413).json({
            error: 'Photo must be smaller than 10 MB.',
            code: 'FILE_TOO_LARGE'
          });
        }
        if (!verifyMagicBytes(buffer, mimeType)) {
          return res.status(400).json({
            error: 'Uploaded file does not match a valid JPG or PNG image.',
            code: 'INVALID_IMAGE_CONTENT'
          });
        }

        const cfg = getSupabaseEnvConfig();
        const previousPath =
          sessionPayload.typ === 'photo_verified' ? sessionPayload.path : null;
        const storagePath = `pending/${sessionPayload.sid}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
        const originalFilename = sanitizeDisplayFilename(rawFilename, 'customer_photo', ext);

        await uploadPrivateFile({
          bucket: cfg.photosBucket,
          storagePath,
          buffer,
          contentType: mimeType
        });

        if (previousPath && previousPath !== storagePath) {
          void removePrivateFile(cfg.photosBucket, previousPath);
        }
        legacyPendingIntentBySid.delete(sessionPayload.sid);

        const now = Date.now();
        const verifiedSessionToken = signServerToken<PhotoVerifiedPayload>({
          typ: 'photo_verified',
          sid: sessionPayload.sid,
          path: storagePath,
          mime: mimeType,
          name: originalFilename,
          size: buffer.length,
          iat: now,
          exp: now + PHOTO_UPLOAD_SESSION_TTL_MS
        });

        const signedPreviewUrl = await createShortLivedSignedUrl(cfg.photosBucket, storagePath, 900);

        return res.json({
          success: true,
          uploadSessionToken: verifiedSessionToken,
          photoStoragePath: storagePath,
          photoUrl: signedPreviewUrl || '',
          fileName: originalFilename,
          mimeType,
          sizeBytes: buffer.length
        });
      } catch (err) {
        console.error('Private customer photo upload error:', sanitizeSupabaseError(err));
        return res.status(502).json({
          error: 'Could not upload your photo to private storage. Please try again.',
          code: 'STORAGE_UPLOAD_FAILED'
        });
      }
    }
  );

  // ============================================================================
  // DELIVERY VALIDATION & ORDER CREATION
  // ============================================================================
  app.post('/api/validate-delivery', async (req, res) => {
    const { settings } = await loadCurrentStoreSettings();
    const { country, state, postcode, city, productId, bundleId, currency, quoteOnly } = req.body || {};

    const deliveryCountry = normalizeDeliveryCountry(country);
    if (!deliveryCountry) {
      return res.status(400).json({
        valid: false,
        code: 'UNSUPPORTED_COUNTRY',
        error: 'Please select a supported delivery country: Malaysia (MY) or Singapore (SG).'
      });
    }

    const currencyCheck = validateCountryCurrencyPair(deliveryCountry, currency);
    if (!currencyCheck.valid) {
      return res.status(400).json({
        valid: false,
        code: currencyCheck.code,
        error: currencyCheck.error
      });
    }

    // Validate country-specific postal code & state/city unless caller is only requesting a live country quote
    if (!quoteOnly || (typeof postcode === 'string' && postcode.trim().length > 0)) {
      const addrCheck = validateCustomerDeliveryAddress(
        {
          country: deliveryCountry,
          postcode: typeof postcode === 'string' ? postcode : '',
          city: typeof city === 'string' ? city : deliveryCountry === 'SG' ? 'Singapore' : '',
          state: typeof state === 'string' ? state : deliveryCountry === 'SG' ? 'Singapore' : ''
        },
        { requireContactFields: false }
      );
      if (!addrCheck.valid) {
        return res.status(400).json({
          valid: false,
          code: addrCheck.code || 'INVALID_DELIVERY_ADDRESS',
          error: addrCheck.error || 'Please enter a valid delivery address and postal code.'
        });
      }
    }

    const pricing = calculateAuthoritativeOrderPricing({
      country: deliveryCountry,
      productId: typeof productId === 'string' && productId.trim() ? productId : 'keychain',
      bundleId: typeof bundleId === 'string' ? bundleId : undefined,
      state: typeof state === 'string' ? state : deliveryCountry === 'SG' ? 'Singapore' : '',
      deliveryRates: getSettingsDeliveryRatesInput(settings),
      sgProductPricesCents: settings.sgProductPricesCents,
      portraitFrameConfig: settings.portraitFrameConfig
    });

    if (!pricing.ok) {
      return res.status(pricing.httpStatus).json({
        valid: false,
        code: pricing.code,
        error: pricing.error
      });
    }

    return res.json({
      valid: true,
      deliveryCountry: pricing.deliveryCountry,
      currency: pricing.currency,
      zone: pricing.deliveryZone,
      deliveryFeeSen: pricing.deliveryFeeMinor,
      deliveryDays: pricing.deliveryDays,
      allowedPaymentMethods: pricing.allowedPaymentMethods,
      pricing: pricing.breakdown
    });
  });

  app.post('/api/create-order', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneTransientCaches();

    try {
      const {
        productId,
        bundleId,
        uploadSessionToken,
        photoStoragePath,
        customer,
        currency,
        personalisationText,
        metaAttribution
      } = req.body || {};

      // Require a cryptographically verified stateless upload session owning the private photo object
      const tokenStr = typeof uploadSessionToken === 'string' ? uploadSessionToken.trim() : '';
      const verifiedSession = tokenStr
        ? verifyServerToken<PhotoVerifiedPayload>(tokenStr, 'photo_verified')
        : null;
      if (
        !verifiedSession ||
        !verifiedSession.path ||
        !verifiedSession.path.startsWith(`pending/${verifiedSession.sid}/`)
      ) {
        return res.status(400).json({
          error:
            'Please upload your keepsake photo before creating an order (upload session missing or expired).',
          code: 'PHOTO_UPLOAD_REQUIRED'
        });
      }
      if (
        typeof photoStoragePath === 'string' &&
        photoStoragePath.trim() &&
        !safeEqualStrings(photoStoragePath.trim(), verifiedSession.path)
      ) {
        return res.status(403).json({
          error: 'Uploaded photo does not match your active checkout session.',
          code: 'PHOTO_SESSION_MISMATCH'
        });
      }

      if (!customer || typeof customer !== 'object') {
        return res.status(400).json({
          error: 'Customer and delivery country details are required.',
          code: 'MISSING_CUSTOMER_DETAILS'
        });
      }

      // Strictly validate delivery country & country-specific address/postal format on backend
      const addressCheck = validateCustomerDeliveryAddress(customer, { requireContactFields: true });
      if (!addressCheck.valid || !addressCheck.normalized) {
        return res.status(400).json({
          error: addressCheck.error || 'Please complete all required customer and delivery fields.',
          code: addressCheck.code || 'INVALID_DELIVERY_ADDRESS'
        });
      }
      const cleanCustomer = addressCheck.normalized;

      // Reject unsupported or mismatched currency selections (never trust frontend currency/prices)
      const currencyCheck = validateCountryCurrencyPair(cleanCustomer.country, currency);
      if (!currencyCheck.valid) {
        return res.status(400).json({
          error: currencyCheck.error,
          code: currencyCheck.code
        });
      }

      const { settings } = await loadCurrentStoreSettings(health);
      const pricing = calculateAuthoritativeOrderPricing({
        country: cleanCustomer.country,
        productId,
        bundleId,
        state: cleanCustomer.state,
        deliveryRates: getSettingsDeliveryRatesInput(settings),
        sgProductPricesCents: settings.sgProductPricesCents,
        portraitFrameConfig: settings.portraitFrameConfig
      });

      if (!pricing.ok) {
        return res.status(pricing.httpStatus).json({
          error: pricing.error,
          code: pricing.code
        });
      }

      const cleanPersonalisationText =
        pricing.productId === PORTRAIT_FRAME_PRODUCT_ID
          ? sanitizePersonalisationText(personalisationText)
          : null;

      const cfg = getSupabaseEnvConfig();
      const ext: 'jpg' | 'png' = verifiedSession.mime === 'image/png' ? 'png' : 'jpg';
      const reference = deriveOrderReferenceForUpload(
        verifiedSession.sid,
        verifiedSession.path,
        verifiedSession.iat
      );
      const finalPhotoPath = deriveOrderPhotoPathForUpload(
        reference,
        verifiedSession.sid,
        verifiedSession.path,
        ext
      );

      return await withOrderLock(`create-order:${reference}`, async () => {
        const tryResumeExistingOrder = async () => {
          const existing = await fetchHydratedOrderByReference(reference);
          if (!existing) return null;

          // Cryptographic photo ownership verification: ensure this exact verified upload created this order
          if (!safeEqualStrings(existing.order.photo_storage_path, finalPhotoPath)) {
            return res.status(409).json({
              error:
                'This uploaded photo has already been used for another order. Please upload a new photo.',
              code: 'PHOTO_ALREADY_USED'
            });
          }

          // Enforce single-use photo protection: block claiming an existing order's photo for a different order
          const sameProduct =
            existing.order.product_id === pricing.productId &&
            (existing.order.bundle_id || null) === (pricing.bundleId || null);
          const sameCustomerEmail =
            existing.order.customer_email.trim().toLowerCase() ===
            cleanCustomer.email.trim().toLowerCase();

          // Pending file can be cleaned up best-effort now that the order row is confirmed in Supabase
          void removePrivateFile(cfg.photosBucket, verifiedSession.path);

          if (!sameProduct || !sameCustomerEmail) {
            return res.status(409).json({
              error:
                'This uploaded photo was already used for an existing order. Please upload a new photo to place another order.',
              code: 'PHOTO_ALREADY_USED'
            });
          }

          // If the order is still awaiting payment and the customer updated delivery country/address before retrying,
          // recalculate authoritative pricing & invalidate open Stripe sessions cleanly in place.
          const existingCountry = getOrderDeliveryCountry(existing.order);
          const existingCurrency = getOrderCurrency(existing.order);
          const deliveryChanged =
            existingCountry !== pricing.deliveryCountry ||
            existingCurrency !== pricing.currency ||
            existing.order.total_sen !== pricing.totalMinor ||
            existing.order.customer_full_name !== cleanCustomer.fullName ||
            existing.order.customer_mobile !== cleanCustomer.mobile ||
            existing.order.customer_address !== cleanCustomer.address ||
            existing.order.customer_postcode !== cleanCustomer.postcode ||
            existing.order.customer_city !== cleanCustomer.city ||
            existing.order.customer_state !== cleanCustomer.state ||
            (existing.order.personalisation_text ?? null) !== cleanPersonalisationText;

          if (existing.order.payment_status === 'Awaiting payment' && deliveryChanged) {
            const countryOrTotalChanged =
              existingCountry !== pricing.deliveryCountry ||
              existingCurrency !== pricing.currency ||
              existing.order.total_sen !== pricing.totalMinor;

            if (countryOrTotalChanged) {
              const stripeInfo = getStripeConfig(health);
              const expiryResult = await expireOpenStripeSessionsForOrder(
                existing.order,
                stripeInfo.client
              );
              if (expiryResult.alreadyPaid) {
                return res.json({
                  success: true,
                  resumed: true,
                  order: toPublicOrder(existing, buildCustomerAuthorizedPhotoUrl(existing.order))
                });
              }
            }

            let updatedOrder: OrderRow | null;
            try {
              updatedOrder = await updateOrderIfUnpaid(reference, {
                delivery_country: pricing.deliveryCountry,
                currency: pricing.currency,
                pricing_breakdown: pricing.breakdown,
                subtotal_sen: pricing.subtotalMinor,
                regular_subtotal_sen: pricing.regularSubtotalMinor,
                savings_sen: pricing.savingsMinor,
                delivery_fee_sen: pricing.deliveryFeeMinor,
                total_sen: pricing.totalMinor,
                personalisation_text: cleanPersonalisationText,
                delivery_days: pricing.deliveryDays,
                customer_full_name: cleanCustomer.fullName,
                customer_email: cleanCustomer.email,
                customer_mobile: cleanCustomer.mobile,
                customer_address: cleanCustomer.address,
                customer_postcode: cleanCustomer.postcode,
                customer_city: cleanCustomer.city,
                customer_state: cleanCustomer.state,
                payment_method:
                  existingCountry !== pricing.deliveryCountry ? null : existing.order.payment_method,
                last_card_attempt_message: null,
                correction_reason:
                  existingCountry !== pricing.deliveryCountry
                    ? null
                    : existing.order.correction_reason
              });
            } catch (updateErr) {
              const updateMsg = sanitizeSupabaseError(updateErr);
              if (updateMsg.includes('SCHEMA_MIGRATION_REQUIRED')) {
                return res.status(503).json({
                  error:
                    'Database migration 002_country_based_pricing.sql must be executed in Supabase before placing Singapore (SGD) orders.',
                  code: 'SCHEMA_MIGRATION_REQUIRED'
                });
              }
              throw updateErr;
            }

            if (updatedOrder) {
              const reloaded = await fetchHydratedOrderByReference(reference);
              if (reloaded) {
                return res.json({
                  success: true,
                  resumed: true,
                  order: toPublicOrder(reloaded, buildCustomerAuthorizedPhotoUrl(reloaded.order))
                });
              }
            }
          }

          return res.json({
            success: true,
            resumed: true,
            order: toPublicOrder(existing, buildCustomerAuthorizedPhotoUrl(existing.order))
          });
        };

        // Step 1: Idempotent resume — if an order was already created for this verified upload session
        // (e.g. double click or retry after a network timeout), securely resume it without creating a duplicate.
        const existingResponse = await tryResumeExistingOrder();
        if (existingResponse) return existingResponse;

        // Step 2: Copy pending photo NON-DESTRUCTIVELY into its permanent order-scoped private path.
        // Keeping pending/ intact until the database insert succeeds ensures failed order creation
        // can be retried safely without losing or prematurely consuming the customer's uploaded photo.
        try {
          await copyPrivateFile({
            bucket: cfg.photosBucket,
            fromPath: verifiedSession.path,
            toPath: finalPhotoPath
          });
        } catch (copyErr) {
          // Cross-instance serverless race check: another invocation may have just created the order and consumed pending/
          const raceResume = await tryResumeExistingOrder();
          if (raceResume) return raceResume;

          console.error('Copy pending photo error:', sanitizeSupabaseError(copyErr));
          return res.status(400).json({
            error:
              'Your uploaded photo could not be found or was already used for another order. Please re-upload your photo.',
            code: 'PHOTO_MOVE_FAILED'
          });
        }

        const accessToken = crypto.randomBytes(24).toString('base64url');
        const cleanMetaFbp = sanitizeMetaCookie(metaAttribution?.fbp);
        const cleanMetaFbc = sanitizeMetaCookie(metaAttribution?.fbc);
        const cleanMetaSourceUrl = sanitizeEventSourceUrl(
          metaAttribution?.eventSourceUrl,
          resolveTrustedOrigin(req)
        );
        const cleanClientIp = getClientIp(req);
        const cleanUserAgent =
          typeof req.headers['user-agent'] === 'string'
            ? req.headers['user-agent'].trim().slice(0, 400)
            : null;
        const metaMarketingConsent = metaAttribution?.marketingConsent === false ? false : true;

        let insertedOrder: OrderRow;
        try {
          insertedOrder = await insertOrderRow({
            reference,
            access_token: accessToken,
            delivery_country: pricing.deliveryCountry,
            currency: pricing.currency,
            pricing_breakdown: pricing.breakdown,
            product_id: pricing.productId,
            bundle_id: pricing.bundleId,
            product_name: pricing.productName,
            item_quantity: pricing.itemQuantity,
            subtotal_sen: pricing.subtotalMinor,
            regular_subtotal_sen: pricing.regularSubtotalMinor,
            savings_sen: pricing.savingsMinor,
            delivery_fee_sen: pricing.deliveryFeeMinor,
            total_sen: pricing.totalMinor,
            personalisation_text: cleanPersonalisationText,
            delivery_days: pricing.deliveryDays,
            photo_storage_bucket: cfg.photosBucket,
            photo_storage_path: finalPhotoPath,
            photo_original_filename: verifiedSession.name,
            photo_mime_type: verifiedSession.mime,
            photo_size_bytes: verifiedSession.size,
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
            last_card_attempt_message: null,
            meta_fbp: cleanMetaFbp,
            meta_fbc: cleanMetaFbc,
            meta_event_source_url: cleanMetaSourceUrl,
            meta_client_ip: cleanClientIp || null,
            meta_client_user_agent: cleanUserAgent,
            meta_marketing_consent: metaMarketingConsent
          });
        } catch (dbErr) {
          // Cross-instance race: another serverless instance inserted the same deterministic reference concurrently
          if (isUniqueViolationError(dbErr)) {
            const concurrentResume = await tryResumeExistingOrder();
            if (concurrentResume) return concurrentResume;
          }

          // Safe rollback: remove ONLY the copied order destination; leave verifiedSession.path in pending/ intact!
          await removePrivateFile(cfg.photosBucket, finalPhotoPath);

          const msg = sanitizeSupabaseError(dbErr);
          if (msg.includes('SCHEMA_MIGRATION_REQUIRED')) {
            return res.status(503).json({
              error:
                'Database migration 002_country_based_pricing.sql must be executed in Supabase before placing Singapore (SGD) orders.',
              code: 'SCHEMA_MIGRATION_REQUIRED'
            });
          }
          throw dbErr;
        }

        // Step 3: ONLY AFTER the order row is durably saved in Supabase, consume the pending upload
        // so the photo remains single-use and cannot be claimed by another order.
        await removePrivateFile(cfg.photosBucket, verifiedSession.path);

        const hydrated: HydratedOrder = {
          order: insertedOrder,
          latestPayment: null,
          latestReceiptPayment: null,
          confirmationEmail: null,
          metaPurchaseEvent: null
        };

        return res.json({
          success: true,
          resumed: false,
          order: toPublicOrder(hydrated, buildCustomerAuthorizedPhotoUrl(insertedOrder))
        });
      });
    } catch (err) {
      console.error('Order creation error:', sanitizeSupabaseError(err));
      return res.status(500).json({ error: 'Could not save order to Supabase. Please try again.' });
    }
  });

  // ============================================================================
  // CUSTOMER AUTHORIZED ORDER STATUS, UNPAID DELIVERY COUNTRY UPDATE & PHOTO ACCESS
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

  // Update delivery country / address on an UNPAID order before payment confirmation.
  // Invalidates any open Stripe Checkout sessions, guards against concurrent payment confirmation,
  // recalculates authoritative pricing, and blocks all mutations after payment confirmation.
  app.patch('/api/orders/:reference/delivery', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference format.', code: 'INVALID_ORDER_REFERENCE' });
    }

    try {
      return await withOrderLock(reference, async () => {
        const order = await fetchOrderByReference(reference);
        if (!order) {
          return res.status(404).json({ error: 'Order not found.', code: 'ORDER_NOT_FOUND' });
        }
        if (!isOrderAuthorized(req, order)) {
          return res.status(403).json({
            error: 'Valid secure order link token is required to update delivery details.',
            code: 'ORDER_UNAUTHORIZED'
          });
        }
        if (order.payment_status === 'Paid') {
          return res.status(409).json({
            error: 'Delivery country, currency, and pricing cannot be changed after payment confirmation.',
            code: 'ORDER_LOCKED_AFTER_PAYMENT'
          });
        }
        if (order.payment_status === 'Pending verification') {
          return res.status(409).json({
            error: 'Delivery details cannot be changed while a payment receipt is pending verification.',
            code: 'ORDER_LOCKED_PENDING_VERIFICATION'
          });
        }

        const incomingCustomer =
          req.body?.customer && typeof req.body.customer === 'object' ? req.body.customer : req.body || {};
        const submittedCurrency = req.body?.currency;

        const mergedCustomerInput = {
          fullName:
            typeof incomingCustomer.fullName === 'string' && incomingCustomer.fullName.trim()
              ? incomingCustomer.fullName
              : order.customer_full_name,
          email:
            typeof incomingCustomer.email === 'string' && incomingCustomer.email.trim()
              ? incomingCustomer.email
              : order.customer_email,
          mobile:
            typeof incomingCustomer.mobile === 'string' && incomingCustomer.mobile.trim()
              ? incomingCustomer.mobile
              : order.customer_mobile,
          address:
            typeof incomingCustomer.address === 'string'
              ? incomingCustomer.address
              : order.customer_address,
          postcode:
            typeof incomingCustomer.postcode === 'string'
              ? incomingCustomer.postcode
              : order.customer_postcode,
          city:
            typeof incomingCustomer.city === 'string' ? incomingCustomer.city : order.customer_city,
          state:
            typeof incomingCustomer.state === 'string' ? incomingCustomer.state : order.customer_state,
          country: incomingCustomer.country
        };

        const addressCheck = validateCustomerDeliveryAddress(mergedCustomerInput, {
          requireContactFields: true
        });
        if (!addressCheck.valid || !addressCheck.normalized) {
          return res.status(400).json({
            error: addressCheck.error || 'Please enter a valid delivery address and postal code.',
            code: addressCheck.code || 'INVALID_DELIVERY_ADDRESS'
          });
        }
        const cleanCustomer = addressCheck.normalized;

        const currencyCheck = validateCountryCurrencyPair(cleanCustomer.country, submittedCurrency);
        if (!currencyCheck.valid) {
          return res.status(400).json({
            error: currencyCheck.error,
            code: currencyCheck.code
          });
        }

        const { settings } = await loadCurrentStoreSettings(health);
        const pricing = calculateAuthoritativeOrderPricing({
          country: cleanCustomer.country,
          productId: order.product_id,
          bundleId: order.bundle_id,
          state: cleanCustomer.state,
          deliveryRates: getSettingsDeliveryRatesInput(settings),
          sgProductPricesCents: settings.sgProductPricesCents,
          portraitFrameConfig: settings.portraitFrameConfig
        });

        if (!pricing.ok) {
          return res.status(pricing.httpStatus).json({
            error: pricing.error,
            code: pricing.code
          });
        }

        const previousCountry = getOrderDeliveryCountry(order);
        const previousCurrency = getOrderCurrency(order);
        const previousTotal = order.total_sen;
        const countryChanged = previousCountry !== pricing.deliveryCountry;
        const totalChanged =
          previousTotal !== pricing.totalMinor || previousCurrency !== pricing.currency;

        // Expire any open Stripe Checkout sessions before mutating delivery country/currency/total.
        // If an existing session was already paid concurrently, block the change cleanly!
        const stripeInfo = getStripeConfig(health);
        let expiredStripeSessions = 0;
        if (countryChanged || totalChanged) {
          const expiryResult = await expireOpenStripeSessionsForOrder(order, stripeInfo.client);
          if (expiryResult.alreadyPaid) {
            return res.status(409).json({
              error:
                'A card payment for this order has already been completed and is being confirmed. Delivery country and pricing can no longer be changed.',
              code: 'PAYMENT_ALREADY_COMPLETED'
            });
          }
          expiredStripeSessions = expiryResult.expiredCount;
        }

        const updated = await updateOrderIfUnpaid(reference, {
          delivery_country: pricing.deliveryCountry,
          currency: pricing.currency,
          pricing_breakdown: pricing.breakdown,
          subtotal_sen: pricing.subtotalMinor,
          regular_subtotal_sen: pricing.regularSubtotalMinor,
          savings_sen: pricing.savingsMinor,
          delivery_fee_sen: pricing.deliveryFeeMinor,
          total_sen: pricing.totalMinor,
          delivery_days: pricing.deliveryDays,
          customer_full_name: cleanCustomer.fullName,
          customer_email: cleanCustomer.email,
          customer_mobile: cleanCustomer.mobile,
          customer_address: cleanCustomer.address,
          customer_postcode: cleanCustomer.postcode,
          customer_city: cleanCustomer.city,
          customer_state: cleanCustomer.state,
          payment_method: countryChanged ? null : order.payment_method,
          last_card_attempt_message: null,
          correction_reason: countryChanged ? null : order.correction_reason
        });

        if (!updated) {
          return res.status(409).json({
            error: 'Delivery country, currency, and pricing cannot be changed after payment confirmation.',
            code: 'ORDER_LOCKED_AFTER_PAYMENT'
          });
        }

        const hydrated = await fetchHydratedOrderByReference(reference);
        if (!hydrated) {
          return res.status(500).json({ error: 'Order updated but could not be reloaded.' });
        }

        return res.json({
          success: true,
          countryChanged,
          totalChanged,
          expiredStripeSessions,
          notice: countryChanged || totalChanged ? COUNTRY_UPDATE_NOTICE : null,
          order: toPublicOrder(hydrated, buildCustomerAuthorizedPhotoUrl(hydrated.order))
        });
      });
    } catch (err) {
      const msg = sanitizeSupabaseError(err);
      if (msg.includes('SCHEMA_MIGRATION_REQUIRED')) {
        return res.status(503).json({
          error:
            'Database migration 002_country_based_pricing.sql must be executed in Supabase before switching orders to Singapore (SGD).',
          code: 'SCHEMA_MIGRATION_REQUIRED'
        });
      }
      console.error(`Update delivery error for ${reference}:`, msg);
      return res.status(500).json({
        error: 'Could not update delivery details right now. Please try again.',
        code: 'DELIVERY_UPDATE_FAILED'
      });
    }
  });

  // Customer-only private photo access (strictly requires matching order accessToken; uses short-lived signed URL redirect so 10 MB photos work on serverless)
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

      const mimeType = order.photo_mime_type || 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        order.photo_original_filename || `${order.reference}_photo.${ext}`,
        `${order.reference}_photo`,
        ext
      );
      const isDownload = req.query.download === '1';

      // Issue a 5-minute signed URL redirect so images up to 10 MB never hit serverless response size caps
      const signedUrl = await createShortLivedSignedUrl(
        order.photo_storage_bucket,
        order.photo_storage_path,
        300,
        isDownload ? safeName : undefined
      );
      if (signedUrl && signedUrl.startsWith('https://')) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.redirect(302, signedUrl);
      }

      const { buffer, contentType } = await downloadPrivateFile(
        order.photo_storage_bucket,
        order.photo_storage_path
      );
      const resolvedMime = order.photo_mime_type || contentType || 'image/jpeg';
      const disposition = isDownload ? 'attachment' : 'inline';

      res.setHeader('Content-Type', resolvedMime);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(buffer);
    } catch (err) {
      console.error(`Failed to serve customer photo for ${reference}:`, sanitizeSupabaseError(err));
      return res.status(404).json({ error: 'Stored order photo could not be retrieved.' });
    }
  });

  // ============================================================================
  // MANUAL QR PAYMENT RECEIPT UPLOAD (DIRECT SUPABASE SIGNED URL + FALLBACK)
  // ============================================================================

  // Step 1 (Direct Signed Receipt Upload): Authorize and return scoped Supabase signed upload URL for JPG, PNG, or PDF up to 10 MB
  app.post('/api/upload-receipt-url', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    pruneTransientCaches();

    const ip = getClientIp(req);
    if (!checkRateLimit(receiptUploadUrlRateTracker, ip, MAX_UPLOAD_URLS_PER_WINDOW, LOGIN_WINDOW_MS)) {
      return res.status(429).json({
        error: 'Too many receipt upload requests right now. Please wait a moment and try again.',
        code: 'RECEIPT_UPLOAD_RATE_LIMITED'
      });
    }

    try {
      const { reference, paymentMethod, filename, mimeType, sizeBytes } = req.body || {};

      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.', code: 'INVALID_ORDER_REFERENCE' });
      }

      const order = await fetchOrderByReference(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.', code: 'ORDER_NOT_FOUND' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({
          error: 'Valid secure order link token is required to submit a receipt.',
          code: 'ORDER_UNAUTHORIZED'
        });
      }
      if (order.payment_status === 'Paid') {
        return res.status(409).json({ error: 'This order has already been paid.', code: 'ORDER_ALREADY_PAID' });
      }
      if (order.payment_status === 'Pending verification') {
        return res.status(409).json({
          error: 'A payment receipt has already been submitted for this order and is pending verification.',
          code: 'ORDER_PENDING_VERIFICATION'
        });
      }

      // Strictly block manual MYR QR payments for Singapore (SGD) orders
      const orderCountry = getOrderDeliveryCountry(order);
      const orderCurrency = getOrderCurrency(order);
      if (orderCountry !== 'MY' || orderCurrency !== 'MYR') {
        return res.status(400).json({
          error:
            'Manual QR payments (Touch ’n Go / Public Bank) are only available for Malaysia (MYR) delivery orders. Please pay by card via Stripe.',
          code: 'QR_PAYMENT_NOT_ALLOWED_FOR_COUNTRY'
        });
      }

      if (paymentMethod !== 'tng' && paymentMethod !== 'duitnow') {
        return res.status(400).json({
          error: 'Please select a valid manual QR payment method.',
          code: 'INVALID_PAYMENT_METHOD'
        });
      }
      const qrMethod: 'tng' | 'duitnow' = paymentMethod;

      const { merchantConfig } = await evaluateAllPaymentMethods();
      if (!merchantConfig[qrMethod]) {
        return res.status(400).json({
          error: 'Selected QR payment method is not currently configured.',
          code: 'PAYMENT_METHOD_UNCONFIGURED'
        });
      }

      const rawMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
      if (
        rawMime !== 'image/jpeg' &&
        rawMime !== 'image/jpg' &&
        rawMime !== 'image/png' &&
        rawMime !== 'application/pdf'
      ) {
        return res.status(400).json({
          error: 'Please upload a JPG, PNG, or PDF receipt file.',
          code: 'INVALID_RECEIPT_TYPE'
        });
      }
      const normalizedMime: 'image/jpeg' | 'image/png' | 'application/pdf' =
        rawMime === 'application/pdf'
          ? 'application/pdf'
          : rawMime === 'image/png'
            ? 'image/png'
            : 'image/jpeg';

      if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return res.status(400).json({
          error: 'Selected receipt file is empty or unreadable.',
          code: 'INVALID_RECEIPT_SIZE'
        });
      }
      if (sizeBytes > MAX_UPLOAD_BYTES) {
        return res.status(413).json({
          error: 'Receipt file must be smaller than 10 MB.',
          code: 'FILE_TOO_LARGE'
        });
      }

      const cfg = getSupabaseEnvConfig();
      const ext =
        normalizedMime === 'application/pdf' ? 'pdf' : normalizedMime === 'image/png' ? 'png' : 'jpg';
      const receiptId = `rcpt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const storagePath = `orders/${reference}/${receiptId}.${ext}`;
      const originalFilename = sanitizeDisplayFilename(filename, 'receipt', ext);

      const signed = await createSignedPrivateUploadUrl(cfg.receiptsBucket, storagePath);
      const now = Date.now();
      const receiptUploadToken = signServerToken<ReceiptIntentPayload>({
        typ: 'receipt_intent',
        ref: reference,
        method: qrMethod,
        path: storagePath,
        mime: normalizedMime,
        name: originalFilename,
        iat: now,
        exp: now + RECEIPT_INTENT_TTL_MS
      });

      return res.json({
        success: true,
        signedUploadUrl: signed.signedUrl,
        receiptStoragePath: storagePath,
        receiptUploadToken,
        mimeType: normalizedMime,
        fileName: originalFilename,
        maxFileSizeBytes: MAX_UPLOAD_BYTES
      });
    } catch (err) {
      console.error('Signed receipt upload URL error:', sanitizeSupabaseError(err));
      clearSupabaseHealthCache();
      return res.status(502).json({
        error: 'Could not authorise secure receipt upload right now. Please try again.',
        code: 'SIGNED_RECEIPT_URL_FAILED'
      });
    }
  });

  // Step 2 (Direct Signed Receipt Upload): Verify uploaded private receipt bytes & magic headers, then persist payment & order state
  app.post('/api/upload-receipt/confirm', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) return;

    try {
      const { reference, paymentMethod, transactionReference, receiptStoragePath, receiptUploadToken } =
        req.body || {};

      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.', code: 'INVALID_ORDER_REFERENCE' });
      }

      const order = await fetchOrderByReference(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.', code: 'ORDER_NOT_FOUND' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({
          error: 'Valid secure order link token is required to submit a receipt.',
          code: 'ORDER_UNAUTHORIZED'
        });
      }
      if (order.payment_status === 'Paid') {
        return res.status(409).json({ error: 'This order has already been paid.', code: 'ORDER_ALREADY_PAID' });
      }
      if (order.payment_status === 'Pending verification') {
        return res.status(409).json({
          error: 'A payment receipt has already been submitted for this order and is pending verification.',
          code: 'ORDER_PENDING_VERIFICATION'
        });
      }

      const orderCountry = getOrderDeliveryCountry(order);
      const orderCurrency = getOrderCurrency(order);
      if (orderCountry !== 'MY' || orderCurrency !== 'MYR') {
        return res.status(400).json({
          error:
            'Manual QR payments (Touch ’n Go / Public Bank) are only available for Malaysia (MYR) delivery orders. Please pay by card via Stripe.',
          code: 'QR_PAYMENT_NOT_ALLOWED_FOR_COUNTRY'
        });
      }

      const cleanTxRef = typeof transactionReference === 'string' ? transactionReference.trim() : '';
      if (cleanTxRef.length < 3 || cleanTxRef.length > 100) {
        return res.status(400).json({
          error: 'Please enter a valid transaction reference (3–100 characters).',
          code: 'INVALID_TRANSACTION_REF'
        });
      }

      const intent =
        typeof receiptUploadToken === 'string'
          ? verifyServerToken<ReceiptIntentPayload>(receiptUploadToken.trim(), 'receipt_intent')
          : null;

      if (
        !intent ||
        !safeEqualStrings(intent.ref, reference) ||
        intent.method !== paymentMethod ||
        typeof receiptStoragePath !== 'string' ||
        !safeEqualStrings(receiptStoragePath.trim(), intent.path) ||
        !intent.path.startsWith(`orders/${reference}/`)
      ) {
        return res.status(400).json({
          error: 'Uploaded receipt session has expired or does not match this order. Please retry submitting your receipt.',
          code: 'RECEIPT_UPLOAD_MISMATCH'
        });
      }

      const cfg = getSupabaseEnvConfig();
      const { buffer } = await downloadPrivateFile(cfg.receiptsBucket, intent.path);

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        void removePrivateFile(cfg.receiptsBucket, intent.path);
        return res.status(400).json({
          error: 'Receipt file must be a valid file smaller than 10 MB.',
          code: 'INVALID_RECEIPT_SIZE'
        });
      }
      if (!verifyMagicBytes(buffer, intent.mime)) {
        void removePrivateFile(cfg.receiptsBucket, intent.path);
        return res.status(400).json({
          error: 'Uploaded receipt file content does not match a valid JPG, PNG, or PDF file.',
          code: 'INVALID_RECEIPT_CONTENT'
        });
      }

      const uploadedAt = new Date().toISOString();

      try {
        await insertPaymentRow({
          order_id: order.id,
          order_reference: order.reference,
          delivery_country: 'MY',
          payment_method: intent.method,
          status: 'pending_verification',
          amount_sen: order.total_sen,
          currency: 'myr',
          transaction_reference: cleanTxRef,
          receipt_storage_bucket: cfg.receiptsBucket,
          receipt_storage_path: intent.path,
          receipt_original_filename: intent.name,
          receipt_mime_type: intent.mime,
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
          payment_method: intent.method,
          payment_status: 'Pending verification',
          correction_reason: null,
          last_card_attempt_message: null
        });
      } catch (dbErr) {
        void removePrivateFile(cfg.receiptsBucket, intent.path);
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
      console.error('Receipt confirm error:', sanitizeSupabaseError(err));
      return res.status(502).json({
        error: 'Could not verify and save your payment receipt. Please try again.',
        code: 'RECEIPT_CONFIRM_FAILED'
      });
    }
  });

  // Legacy / fallback backend receipt upload endpoint (retained for backward compatibility)
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

      const orderCountry = getOrderDeliveryCountry(order);
      const orderCurrency = getOrderCurrency(order);
      if (orderCountry !== 'MY' || orderCurrency !== 'MYR') {
        return res.status(400).json({
          error:
            'Manual QR payments (Touch ’n Go / Public Bank) are only available for Malaysia (MYR) delivery orders. Please pay by card via Stripe.',
          code: 'QR_PAYMENT_NOT_ALLOWED_FOR_COUNTRY'
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

      const commaIdx = receiptBase64.indexOf(',');
      if (commaIdx <= 0) {
        return res.status(400).json({ error: 'Invalid receipt file format. Please upload a JPG, PNG, or PDF file.' });
      }
      const prefix = receiptBase64.slice(0, commaIdx).toLowerCase();
      if (
        prefix !== 'data:image/jpeg;base64' &&
        prefix !== 'data:image/jpg;base64' &&
        prefix !== 'data:image/png;base64' &&
        prefix !== 'data:application/pdf;base64'
      ) {
        return res.status(400).json({ error: 'Invalid receipt file format. Please upload a JPG, PNG, or PDF file.' });
      }

      const normalizedMime: 'image/jpeg' | 'image/png' | 'application/pdf' =
        prefix === 'data:application/pdf;base64'
          ? 'application/pdf'
          : prefix === 'data:image/png;base64'
            ? 'image/png'
            : 'image/jpeg';
      const ext =
        normalizedMime === 'application/pdf' ? 'pdf' : normalizedMime === 'image/png' ? 'png' : 'jpg';
      const buffer = Buffer.from(receiptBase64.slice(commaIdx + 1).trim(), 'base64');

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
          delivery_country: 'MY',
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
  // STRIPE CHECKOUT SESSION (Country & Currency Enforced, Fixed Pricing, No Auto FX)
  // ============================================================================
  app.post('/api/create-stripe-session', async (req, res) => {
    const health = await requireSupabaseReady(res);
    if (!health) {
      recordStripeCheckoutDiagnostic({
        stage: 'config',
        code: 'SUPABASE_UNAVAILABLE',
        mode: 'unconfigured',
        httpStatus: 503,
        message: 'Supabase health check failed before starting Stripe Checkout.'
      });
      return;
    }

    const stripeInfo = getStripeConfig(health);
    if (!stripeInfo.client) {
      const code = stripeInfo.errorCode || 'STRIPE_UNAVAILABLE';
      const errMsg = stripeInfo.error || 'Credit or Debit Card checkout is currently unavailable.';
      recordStripeCheckoutDiagnostic({
        stage: 'config',
        code,
        mode: stripeInfo.mode,
        httpStatus: 503,
        message: errMsg
      });
      return res.status(503).json({
        error: errMsg,
        code
      });
    }

    const { reference } = req.body || {};
    if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({
        error: 'Invalid order reference.',
        code: 'INVALID_ORDER_REFERENCE'
      });
    }

    const stripeClient = stripeInfo.client;
    return await withOrderLock(reference, async () => {
      let order: OrderRow | null;
      try {
        order = await fetchOrderByReference(reference);
      } catch (dbErr) {
        const msg = sanitizeSupabaseError(dbErr);
        clearSupabaseHealthCache();
        recordStripeCheckoutDiagnostic({
          stage: 'order_lookup',
          code: 'SUPABASE_ORDER_LOOKUP_FAILED',
          mode: stripeInfo.mode,
          httpStatus: 503,
          message: msg
        });
        return res.status(503).json({
          error: 'Unable to load your saved order right now. Please try again.',
          code: 'SUPABASE_ORDER_LOOKUP_FAILED'
        });
      }

      if (!order) {
        return res.status(404).json({ error: 'Saved order not found.', code: 'ORDER_NOT_FOUND' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({
          error: 'Valid secure order link token is required to start card checkout.',
          code: 'ORDER_UNAUTHORIZED'
        });
      }
      if (order.payment_status === 'Paid') {
        return res.status(409).json({
          error: 'This order is already marked as Paid.',
          code: 'ORDER_ALREADY_PAID'
        });
      }
      if (order.payment_status === 'Pending verification') {
        return res.status(409).json({
          error: 'A QR payment receipt is already pending verification for this order.',
          code: 'ORDER_PENDING_VERIFICATION'
        });
      }

      // Retrieve current store settings & verify delivery country, currency, product price,
      // bundle discount, shipping charges, and final payable total before opening Stripe
      const { settings } = await loadCurrentStoreSettings(health);
      const verified = verifySavedOrderPricingIntegrity({
        order,
        deliveryRates: getSettingsDeliveryRatesInput(settings),
        sgProductPricesCents: settings.sgProductPricesCents,
        portraitFrameConfig: settings.portraitFrameConfig
      });

      if (!verified.valid) {
        recordStripeCheckoutDiagnostic({
          stage: 'config',
          code: verified.code,
          mode: stripeInfo.mode,
          httpStatus: verified.httpStatus,
          message: `Order ${order.reference} failed pricing/currency verification: ${verified.error}`
        });
        return res.status(verified.httpStatus).json({
          error: verified.error,
          code: verified.code
        });
      }

      // Expire any previous open Stripe Checkout sessions and guard against concurrent payment completion
      try {
        const expiryResult = await expireOpenStripeSessionsForOrder(order, stripeInfo.client);
        if (expiryResult.alreadyPaid) {
          return res.status(409).json({
            error:
              'A card payment for this order has already been completed and is being confirmed. Please refresh your order status.',
            code: 'PAYMENT_ALREADY_COMPLETED'
          });
        }
      } catch (expireErr) {
        const msg = sanitizeSensitiveText(expireErr);
        recordStripeCheckoutDiagnostic({
          stage: 'stripe_api',
          code: 'STRIPE_PRIOR_SESSION_CHECK_FAILED',
          mode: stripeInfo.mode,
          httpStatus: 502,
          message: msg
        });
        return res.status(502).json({
          error:
            'Could not verify your previous checkout session status right now. Please wait a moment and try again.',
          code: 'STRIPE_PRIOR_SESSION_CHECK_FAILED'
        });
      }

      const originInfo = resolveTrustedOriginInfo(req);
      const tokenParam = encodeURIComponent(order.access_token);
      const refParam = encodeURIComponent(order.reference);
      const successUrl = `${originInfo.origin}/?payment=success&order=${refParam}&token=${tokenParam}`;
      const cancelUrl = `${originInfo.origin}/?payment=cancelled&order=${refParam}&token=${tokenParam}`;

      try {
        const parsedSuccess = new URL(successUrl);
        const parsedCancel = new URL(cancelUrl);
        if (
          (parsedSuccess.protocol !== 'https:' && parsedSuccess.protocol !== 'http:') ||
          (parsedCancel.protocol !== 'https:' && parsedCancel.protocol !== 'http:')
        ) {
          throw new Error('Redirect URLs must use https:// or http://.');
        }
      } catch (urlErr) {
        const msg = sanitizeSensitiveText(urlErr);
        recordStripeCheckoutDiagnostic({
          stage: 'redirect_url',
          code: 'INVALID_REDIRECT_URL',
          mode: stripeInfo.mode,
          httpStatus: 500,
          originSource: originInfo.source,
          message: `Invalid Stripe redirect URL resolved from ${originInfo.source}: ${msg}`
        });
        return res.status(500).json({
          error: 'Checkout redirect URL is misconfigured on the server. Please contact support.',
          code: 'INVALID_REDIRECT_URL'
        });
      }

      const stripeCurrency = verified.currency.toLowerCase();
      const isPortraitFrameOrder = order.product_id === PORTRAIT_FRAME_PRODUCT_ID;
      const orderDeliveryDays =
        order.delivery_days ?? order.pricing_breakdown?.deliveryDays ?? verified.expected.deliveryDays;
      const orderDeliveryPromise = buildDeliveryPromiseText(orderDeliveryDays, isPortraitFrameOrder);
      const personalisationNote = sanitizePersonalisationText(order.personalisation_text);
      const deliveryLabel =
        verified.deliveryCountry === 'SG'
          ? isPortraitFrameOrder
            ? 'Portrait Frame Delivery (Singapore)'
            : 'Delivery (Singapore)'
          : isPortraitFrameOrder
            ? `Portrait Frame Delivery (${verified.expected.deliveryZone}, Malaysia)`
            : `Delivery (${verified.expected.deliveryZone}, Malaysia)`;
      const itemDescription = personalisationNote
        ? `Order Ref: ${order.reference} (Qty: ${order.item_quantity} · ${COUNTRY_LABELS[verified.deliveryCountry]}) · Personalisation: ${personalisationNote}`
        : `Order Ref: ${order.reference} (Qty: ${order.item_quantity} · ${COUNTRY_LABELS[verified.deliveryCountry]})`;

      let session: Stripe.Checkout.Session;
      try {
        session = await stripeClient.checkout.sessions.create({
          mode: 'payment',
          allowed_payment_method_types: ['card'],
          adaptive_pricing: { enabled: false },
          client_reference_id: order.reference,
          customer_email: order.customer_email,
          metadata: {
            orderReference: order.reference,
            deliveryCountry: verified.deliveryCountry,
            currency: verified.currency,
            productId: order.product_id,
            productName: order.product_name,
            ...(personalisationNote ? { personalisationText: personalisationNote } : {}),
            expectedSubtotalMinor: String(order.subtotal_sen),
            expectedDeliveryFeeMinor: String(order.delivery_fee_sen),
            expectedTotalMinor: String(order.total_sen),
            expectedTotalSen: String(order.total_sen)
          },
          line_items: [
            {
              price_data: {
                currency: stripeCurrency,
                product_data: {
                  name: `Little Pixel Keepsakes — ${order.product_name}`,
                  description: itemDescription
                },
                unit_amount: order.subtotal_sen
              },
              quantity: 1
            },
            {
              price_data: {
                currency: stripeCurrency,
                product_data: {
                  name: deliveryLabel,
                  description: orderDeliveryPromise
                },
                unit_amount: order.delivery_fee_sen
              },
              quantity: 1
            }
          ],
          success_url: successUrl,
          cancel_url: cancelUrl
        });
      } catch (stripeErr: any) {
        const stripeType = typeof stripeErr?.type === 'string' ? stripeErr.type : undefined;
        const stripeCode =
          typeof stripeErr?.code === 'string'
            ? stripeErr.code
            : typeof stripeErr?.raw?.code === 'string'
              ? stripeErr.raw.code
              : undefined;
        const rawMessage = sanitizeSensitiveText(stripeErr?.message || stripeErr || 'Stripe API call failed');

        let httpStatus = 502;
        let code = 'STRIPE_API_ERROR';
        let customerError =
          verified.deliveryCountry === 'MY'
            ? 'Unable to initiate Stripe card checkout right now. You can retry or choose a QR payment method.'
            : 'Unable to initiate Stripe card checkout right now. Please try again in a moment.';

        if (stripeType === 'StripeAuthenticationError' || stripeErr?.statusCode === 401) {
          httpStatus = 503;
          code = 'STRIPE_AUTH_ERROR';
          customerError =
            'Card payments are temporarily unavailable due to a payment gateway credential issue. Please try again later or contact support.';
        } else if (stripeType === 'StripePermissionError' || stripeErr?.statusCode === 403) {
          httpStatus = 503;
          code = 'STRIPE_PERMISSION_ERROR';
          customerError =
            'Card payments are temporarily unavailable due to a payment gateway permission configuration issue. Please contact support.';
        } else if (
          stripeType === 'StripeConnectionError' ||
          stripeCode === 'ETIMEDOUT' ||
          stripeCode === 'ECONNRESET' ||
          stripeCode === 'ENOTFOUND' ||
          /timeout|timed out|socket hang up|network/i.test(rawMessage)
        ) {
          httpStatus = 504;
          code = 'STRIPE_CONNECTION_ERROR';
          customerError =
            'Could not reach Stripe Checkout right now. Please wait a moment and try again.';
        } else if (stripeType === 'StripeRateLimitError' || stripeErr?.statusCode === 429) {
          httpStatus = 429;
          code = 'STRIPE_RATE_LIMIT';
          customerError =
            'Card checkout is busy right now. Please wait a few seconds and try again.';
        } else if (stripeType === 'StripeInvalidRequestError' || stripeErr?.statusCode === 400) {
          httpStatus = 502;
          code = 'STRIPE_INVALID_REQUEST';
          customerError =
            'Unable to start Stripe card checkout due to a checkout configuration error. Please contact support.';
        }

        const stripeParam =
          typeof stripeErr?.param === 'string'
            ? stripeErr.param
            : typeof stripeErr?.raw?.param === 'string'
              ? stripeErr.raw.param
              : undefined;

        recordStripeCheckoutDiagnostic({
          stage: 'stripe_api',
          code,
          mode: stripeInfo.mode,
          httpStatus,
          stripeType,
          stripeCode,
          stripeParam,
          originSource: originInfo.source,
          message: rawMessage
        });

        return res.status(httpStatus).json({
          error: customerError,
          code
        });
      }

      if (!session?.id || !session?.url || !session.url.startsWith('https://')) {
        recordStripeCheckoutDiagnostic({
          stage: 'stripe_api',
          code: 'STRIPE_MISSING_CHECKOUT_URL',
          mode: stripeInfo.mode,
          httpStatus: 502,
          originSource: originInfo.source,
          message: 'Stripe created a session without a valid HTTPS checkout URL.'
        });
        return res.status(502).json({
          error: 'Stripe did not return a valid checkout URL. Please try again.',
          code: 'STRIPE_MISSING_CHECKOUT_URL'
        });
      }

      try {
        await insertPaymentRow({
          order_id: order.id,
          order_reference: order.reference,
          delivery_country: verified.deliveryCountry,
          payment_method: 'card',
          status: 'pending',
          amount_sen: order.total_sen,
          currency: stripeCurrency,
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
      } catch (saveErr) {
        const msg = sanitizeSupabaseError(saveErr);
        recordStripeCheckoutDiagnostic({
          stage: 'save_payment',
          code: 'PAYMENT_RECORD_SAVE_FAILED',
          mode: stripeInfo.mode,
          httpStatus: 500,
          originSource: originInfo.source,
          message: msg
        });
        // Best-effort expire orphaned Stripe session so it cannot be paid without a matching DB payment row
        void stripeClient.checkout.sessions.expire(session.id).catch(() => {});
        return res.status(500).json({
          error: 'Unable to record your card checkout session in the database. Please try again.',
          code: 'PAYMENT_RECORD_SAVE_FAILED'
        });
      }

      try {
        await updateOrderByReference(reference, {
          last_card_attempt_message: null
        });
      } catch (orderUpdateErr) {
        console.warn(
          `Non-fatal warning clearing last_card_attempt_message for ${reference}:`,
          sanitizeSupabaseError(orderUpdateErr)
        );
      }

      lastStripeCheckoutDiagnostic = null;
      return res.json({
        success: true,
        url: session.url,
        sessionId: session.id,
        mode: stripeInfo.mode,
        currency: verified.currency,
        deliveryCountry: verified.deliveryCountry
      });
    });
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
      const token = createAdminSession(
        account.id,
        account.username,
        `staff:${account.id}:${account.password_hash}`
      );
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

    const ip = getClientIp(req);
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
    let secretMaterial = '';

    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (envPasscode.length > 0 && safeEqualStrings(passcode, envPasscode)) {
      authenticated = true;
      secretMaterial = `env:${envPasscode}`;
    } else if (supabase.databaseReady) {
      try {
        const accounts = await listActiveStaffAccounts();
        for (const account of accounts) {
          const candidate = hashPasscode(passcode, account.password_salt);
          if (safeEqualStrings(candidate.hash, account.password_hash)) {
            authenticated = true;
            staffId = account.id;
            username = account.username;
            secretMaterial = `staff:${account.id}:${account.password_hash}`;
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
    const token = createAdminSession(staffId, username, secretMaterial);
    return res.json({ success: true, token });
  });

  app.post('/api/admin/logout', requireAdminAuth, (req: AuthenticatedAdminRequest, res) => {
    if (req.adminSession?.sid) {
      revokedAdminSessionIds.set(req.adminSession.sid, req.adminSession.expiresAt);
    }
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
        for (const key of ['keychain', 'magnet', 'bundle', 'portrait_frame'] as const) {
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

      if (incoming.deliveryRateSingaporeCents !== undefined) {
        if (incoming.deliveryRateSingaporeCents === null) {
          next.deliveryRateSingaporeCents = null;
        } else if (
          typeof incoming.deliveryRateSingaporeCents === 'number' &&
          Number.isInteger(incoming.deliveryRateSingaporeCents) &&
          incoming.deliveryRateSingaporeCents >= 0 &&
          incoming.deliveryRateSingaporeCents <= 100000
        ) {
          next.deliveryRateSingaporeCents = incoming.deliveryRateSingaporeCents;
        } else {
          return res.status(400).json({
            error:
              'Singapore delivery fee must be between S$ 0.00 and S$ 1,000.00, or left blank to disable Singapore shipping.'
          });
        }
      }

      if (incoming.sgProductPricesCents && typeof incoming.sgProductPricesCents === 'object') {
        const sgKc = incoming.sgProductPricesCents.keychain;
        const sgMag = incoming.sgProductPricesCents.magnet;
        if (typeof sgKc === 'number') {
          if (!Number.isInteger(sgKc) || sgKc < 100 || sgKc > 500000) {
            return res
              .status(400)
              .json({ error: 'Singapore Keychain price must be between S$ 1.00 and S$ 5,000.00.' });
          }
          next.sgProductPricesCents.keychain = sgKc;
        }
        if (typeof sgMag === 'number') {
          if (!Number.isInteger(sgMag) || sgMag < 100 || sgMag > 500000) {
            return res
              .status(400)
              .json({ error: 'Singapore Fridge Magnet price must be between S$ 1.00 and S$ 5,000.00.' });
          }
          next.sgProductPricesCents.magnet = sgMag;
        }
      }

      if (incoming.portraitFrameConfig && typeof incoming.portraitFrameConfig === 'object') {
        const pf = incoming.portraitFrameConfig;
        if (typeof pf.priceMySen === 'number') {
          if (!Number.isInteger(pf.priceMySen) || pf.priceMySen < 200 || pf.priceMySen > 500000) {
            return res.status(400).json({
              error: 'Portrait Frame Malaysia price must be between RM 2.00 and RM 5,000.00.'
            });
          }
          next.portraitFrameConfig.priceMySen = pf.priceMySen;
        }
        if (typeof pf.priceSgCents === 'number') {
          if (!Number.isInteger(pf.priceSgCents) || pf.priceSgCents < 50 || pf.priceSgCents > 500000) {
            return res.status(400).json({
              error: 'Portrait Frame Singapore price must be between S$ 0.50 and S$ 5,000.00.'
            });
          }
          next.portraitFrameConfig.priceSgCents = pf.priceSgCents;
        }
        if (typeof pf.deliveryPeninsularSen === 'number') {
          if (
            !Number.isInteger(pf.deliveryPeninsularSen) ||
            pf.deliveryPeninsularSen < 0 ||
            pf.deliveryPeninsularSen > 100000
          ) {
            return res.status(400).json({
              error:
                'Portrait Frame Peninsular Malaysia delivery fee must be between RM 0.00 and RM 1,000.00.'
            });
          }
          next.portraitFrameConfig.deliveryPeninsularSen = pf.deliveryPeninsularSen;
        }
        if (typeof pf.deliveryEastMalaysiaSen === 'number') {
          if (
            !Number.isInteger(pf.deliveryEastMalaysiaSen) ||
            pf.deliveryEastMalaysiaSen < 0 ||
            pf.deliveryEastMalaysiaSen > 100000
          ) {
            return res.status(400).json({
              error:
                'Portrait Frame Sabah & Sarawak delivery fee must be between RM 0.00 and RM 1,000.00.'
            });
          }
          next.portraitFrameConfig.deliveryEastMalaysiaSen = pf.deliveryEastMalaysiaSen;
        }
        if (pf.deliverySingaporeCents !== undefined) {
          if (pf.deliverySingaporeCents === null) {
            next.portraitFrameConfig.deliverySingaporeCents = null;
          } else if (
            typeof pf.deliverySingaporeCents === 'number' &&
            Number.isInteger(pf.deliverySingaporeCents) &&
            pf.deliverySingaporeCents >= 0 &&
            pf.deliverySingaporeCents <= 100000
          ) {
            next.portraitFrameConfig.deliverySingaporeCents = pf.deliverySingaporeCents;
          } else {
            return res.status(400).json({
              error:
                'Portrait Frame Singapore delivery fee must be between S$ 0.00 and S$ 1,000.00, or left blank to disable Singapore shipping.'
            });
          }
        }
        if (typeof pf.deliveryDays === 'number') {
          if (!Number.isInteger(pf.deliveryDays) || pf.deliveryDays < 1 || pf.deliveryDays > 90) {
            return res.status(400).json({
              error: 'Portrait Frame delivery timeframe must be a whole number between 1 and 90 days.'
            });
          }
          next.portraitFrameConfig.deliveryDays = pf.deliveryDays;
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
      const msg = sanitizeSupabaseError(err);
      if (msg.includes('SCHEMA_MIGRATION_REQUIRED')) {
        return res.status(503).json({
          error: msg.replace(/^SCHEMA_MIGRATION_REQUIRED:\s*/i, ''),
          code: 'SCHEMA_MIGRATION_REQUIRED'
        });
      }
      console.error('Failed to save store settings:', msg);
      return res.status(500).json({ error: 'Failed to save store settings to Supabase.' });
    }
  });

  // Protected: Upload a public storefront marketing asset (logo/product/gallery) or merchant QR image
  app.post('/api/admin/upload-asset', requireAdminAuth, (req, res) => {
    if (isServerlessRuntime) {
      return res.status(400).json({
        error:
          'Direct disk uploads are disabled on serverless deployments. Please paste a hosted https:// image URL or commit static assets into /public/.',
        code: 'SERVERLESS_READONLY_FS'
      });
    }
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

      const mimeType = order.photo_mime_type || 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        order.photo_original_filename || `${order.reference}_photo.${ext}`,
        `${order.reference}_photo`,
        ext
      );
      const isDownload = req.query.download === '1';

      if (req.query.format === 'signed') {
        const signedUrl = await createShortLivedSignedUrl(
          order.photo_storage_bucket,
          order.photo_storage_path,
          300,
          isDownload ? safeName : undefined
        );
        if (!signedUrl) {
          return res.status(502).json({ error: 'Could not generate a temporary signed link for this photo.' });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({
          success: true,
          signedUrl,
          fileName: safeName,
          mimeType
        });
      }

      const { buffer, contentType } = await downloadPrivateFile(
        order.photo_storage_bucket,
        order.photo_storage_path
      );
      const resolvedMime = order.photo_mime_type || contentType || 'image/jpeg';
      const disposition = isDownload ? 'attachment' : 'inline';

      res.setHeader('Content-Type', resolvedMime);
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

      const mimeType = receiptPayment.receipt_mime_type || 'application/octet-stream';
      const ext =
        mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
      const safeName = sanitizeDisplayFilename(
        receiptPayment.receipt_original_filename || `${reference}_receipt.${ext}`,
        `${reference}_receipt`,
        ext
      );
      const isDownload = req.query.download === '1';

      if (req.query.format === 'signed') {
        const signedUrl = await createShortLivedSignedUrl(
          receiptPayment.receipt_storage_bucket,
          receiptPayment.receipt_storage_path,
          300,
          isDownload ? safeName : undefined
        );
        if (!signedUrl) {
          return res.status(502).json({ error: 'Could not generate a temporary signed link for this receipt.' });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({
          success: true,
          signedUrl,
          fileName: safeName,
          mimeType
        });
      }

      const { buffer, contentType } = await downloadPrivateFile(
        receiptPayment.receipt_storage_bucket,
        receiptPayment.receipt_storage_path
      );
      const resolvedMime = receiptPayment.receipt_mime_type || contentType || 'application/octet-stream';
      const disposition = isDownload ? 'attachment' : 'inline';

      res.setHeader('Content-Type', resolvedMime);
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
          getOrderDeliveryCountry(order) !== 'MY' ||
          getOrderCurrency(order) !== 'MYR' ||
          order.payment_status !== 'Pending verification' ||
          !latestReceiptPayment?.receipt_storage_path ||
          latestReceiptPayment.status !== 'pending_verification' ||
          latestReceiptPayment.payment_method !== order.payment_method ||
          (order.payment_method !== 'tng' && order.payment_method !== 'duitnow')
        ) {
          return res.status(400).json({
            error:
              'Only Malaysia (MYR) orders with a submitted TNG or Public Bank QR receipt pending verification can be marked paid by staff.'
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

        try {
          await sendMetaPurchaseEventOnce(updatedOrder, req);
        } catch (metaErr) {
          console.error(`Unexpected Meta CAPI error for order ${reference}:`, sanitizeMetaError(metaErr));
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

  // Protected: Retry sending a failed/unconfigured Meta CAPI Purchase event for a Paid order.
  // Strictly uses the deterministic event_id (`purchase_<REF>`) and blocks retries if already sent.
  app.post('/api/admin/orders/:reference/retry-meta-purchase', requireAdminAuth, async (req, res) => {
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
        return res.status(400).json({
          error: 'Meta Purchase events can only be sent for backend-verified Paid orders.'
        });
      }
      if (hydrated.metaPurchaseEvent?.sent_at || hydrated.metaPurchaseEvent?.status === 'sent') {
        const signedPhotoUrl = await resolveAdminOrderPhotoUrl(hydrated.order);
        const metaTracking = await buildMetaTrackingDiagnostic(health);
        return res.status(409).json({
          error: 'Meta Purchase event has already been delivered for this order.',
          order: toAdminOrder(hydrated, signedPhotoUrl),
          metaTracking
        });
      }

      const result = await sendMetaPurchaseEventOnce(hydrated.order, req);
      const refreshed = (await fetchHydratedOrderByReference(reference)) || hydrated;
      const signedPhotoUrl = await resolveAdminOrderPhotoUrl(refreshed.order);
      const metaTracking = await buildMetaTrackingDiagnostic(health);

      if (result.sent) {
        return res.json({
          success: true,
          order: toAdminOrder(refreshed, signedPhotoUrl),
          metaTracking
        });
      }
      if (result.skipped && result.status === 'sent') {
        return res.status(409).json({
          error: 'Meta Purchase event has already been sent or is currently in progress.',
          order: toAdminOrder(refreshed, signedPhotoUrl),
          metaTracking
        });
      }
      if (result.status === 'skipped_consent') {
        return res.status(409).json({
          error: 'Customer opted out of marketing tracking for this order.',
          order: toAdminOrder(refreshed, signedPhotoUrl),
          metaTracking
        });
      }

      const statusCode = result.status === 'not_configured' ? 503 : 502;
      return res.status(statusCode).json({
        success: false,
        error: result.error || 'Could not deliver Meta Purchase event. Order remains Paid.',
        order: toAdminOrder(refreshed, signedPhotoUrl),
        metaTracking
      });
    } catch (err) {
      console.error(`Retry Meta CAPI error for ${reference}:`, sanitizeMetaError(err));
      return res.status(500).json({ error: 'Failed to retry Meta Purchase event.' });
    }
  });

  // Protected: Read-only verification of current runtime META_PIXEL_ID & META_CAPI_ACCESS_TOKEN.
  // Never exposes META_CAPI_ACCESS_TOKEN, never sends synthetic Purchase events, and never resends past purchases.
  app.post('/api/admin/meta-capi/verify', requireAdminAuth, async (_req, res) => {
    try {
      const supabase = await checkSupabaseHealth(false);
      const checkResult = await verifyMetaCapiConnection();
      lastMetaConnectionCheck = checkResult;
      const metaTracking = await buildMetaTrackingDiagnostic(supabase);
      return res.status(checkResult.ok ? 200 : checkResult.status === 'not_configured' ? 503 : 502).json({
        success: checkResult.ok,
        message: checkResult.message,
        metaTracking
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: sanitizeMetaError(err)
      });
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

  // Explicitly block legacy /uploads/* paths from ever being served publicly
  app.use('/uploads', (_req, res) => {
    return res.status(404).json({ error: 'Not found.' });
  });

  // Ensure unmatched /api/* routes always return JSON (never Vite or SPA HTML)
  app.use('/api', (_req, res) => {
    return res.status(404).json({
      error: 'API endpoint not found.',
      code: 'API_NOT_FOUND'
    });
  });

  // Global JSON error handler for /api/* (e.g., payload too large, invalid JSON body, or unexpected middleware errors)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.path.startsWith('/api')) {
      return next(err);
    }
    if (res.headersSent) {
      return next(err);
    }
    const isPayloadTooLarge = err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413;
    const isBodyParseError = !isPayloadTooLarge && (err?.type === 'entity.parse.failed' || err instanceof SyntaxError);
    const status = isPayloadTooLarge
      ? 413
      : isBodyParseError
        ? 400
        : typeof err?.status === 'number' && err.status >= 400 && err.status < 600
          ? err.status
          : typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
            ? err.statusCode
            : 500;
    console.error(`API error on ${req.method} ${req.path}:`, sanitizeSensitiveText(err?.message || err));
    return res.status(status).json({
      error: isPayloadTooLarge
        ? 'Uploaded file exceeds the maximum 10 MB size limit. Please choose a smaller JPG or PNG image.'
        : isBodyParseError
          ? 'Invalid JSON request payload.'
          : 'An unexpected server error occurred. Please try again.',
      code: isPayloadTooLarge
        ? 'PAYLOAD_TOO_LARGE'
        : isBodyParseError
          ? 'INVALID_JSON_BODY'
          : 'INTERNAL_SERVER_ERROR'
    });
  });

  return app;
}
