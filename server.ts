import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DELIVERY_PROMISE_TEXT =
  'Your order will be delivered within 14 days after your payment is confirmed and we receive a usable photo.';
const PAID_CONFIRMATION_HEADING = 'Thank you! Your order is confirmed.';

// Public & private directories (private storage must remain strictly outside public/ and dist/)
const publicDir = path.resolve(__dirname, 'public');
const distDir = path.resolve(__dirname, 'dist');
const publicUploadsDir = path.resolve(publicDir, 'uploads');
const publicPaymentsDir = path.resolve(publicDir, 'payments');

const configuredPrivateDir = (process.env.PRIVATE_STORAGE_DIR || '').trim();
const privateStorageDir = configuredPrivateDir
  ? path.resolve(__dirname, configuredPrivateDir)
  : path.resolve(__dirname, 'private_storage');
const privateReceiptsDir = path.resolve(privateStorageDir, 'receipts');
const storeFilePath = path.resolve(privateStorageDir, 'store.json');

function isStrictlyOutsidePublicDirs(targetPath: string): boolean {
  const normalized = path.resolve(targetPath);
  const insidePublic = normalized === publicDir || normalized.startsWith(publicDir + path.sep);
  const insideDist = normalized === distDir || normalized.startsWith(distDir + path.sep);
  return !insidePublic && !insideDist;
}

for (const dir of [publicUploadsDir, publicPaymentsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

if (isStrictlyOutsidePublicDirs(privateStorageDir)) {
  for (const dir of [privateStorageDir, privateReceiptsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function checkPrivateStorageHealth(): {
  configured: boolean;
  outsidePublic: boolean;
  writable: boolean;
  issue?: string;
} {
  const outsidePublic =
    isStrictlyOutsidePublicDirs(privateStorageDir) && isStrictlyOutsidePublicDirs(privateReceiptsDir);
  if (!outsidePublic) {
    return {
      configured: false,
      outsidePublic: false,
      writable: false,
      issue: 'PRIVATE_STORAGE_DIR must point outside public/ and dist/ so receipts stay private.'
    };
  }
  try {
    if (!fs.existsSync(privateStorageDir)) {
      fs.mkdirSync(privateStorageDir, { recursive: true });
    }
    if (!fs.existsSync(privateReceiptsDir)) {
      fs.mkdirSync(privateReceiptsDir, { recursive: true });
    }
    fs.accessSync(privateStorageDir, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(privateReceiptsDir, fs.constants.R_OK | fs.constants.W_OK);
    return { configured: true, outsidePublic: true, writable: true };
  } catch {
    return {
      configured: false,
      outsidePublic: true,
      writable: false,
      issue: 'Private storage directory is not writable on the server.'
    };
  }
}

// Shared product & bundle pricing configuration in integer sen
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

interface StoreGalleryImage {
  id: string;
  category: string;
  title: string;
  description: string;
  image: string;
  tag: string;
}

interface EditableStoreSettings {
  logoUrl: string;
  heroImageUrl: string;
  productImages: {
    keychain: string;
    magnet: string;
    bundle: string;
  };
  galleryItems: StoreGalleryImage[];
  deliveryRatesSen: {
    peninsular: number;
    eastMalaysia: number;
  };
  whatsappSupportNumber: string;
  qrOverrides: {
    tng: {
      enabled: boolean | null;
      recipientName: string;
      qrImage: string;
    };
    duitnow: {
      enabled: boolean | null;
      recipientName: string;
      qrImage: string;
    };
  };
}

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

interface PrivateReceiptRecord {
  id: string;
  storageFileName: string;
  originalFilename: string;
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  uploadedAt: string;
}

type PaymentStatus =
  | 'Awaiting payment'
  | 'Pending verification'
  | 'Receipt correction needed'
  | 'Paid';

interface OrderRecord {
  reference: string;
  accessToken: string;
  productId: string;
  bundleId?: string;
  productName: string;
  itemQuantity: number;
  subtotalSen: number;
  regularSubtotalSen?: number;
  savingsSen?: number;
  deliveryFeeSen: number;
  totalSen: number;
  photoUrl: string;
  customer: {
    fullName: string;
    email: string;
    mobile: string;
    address: string;
    postcode: string;
    city: string;
    state: string;
  };
  paymentStatus: PaymentStatus;
  paymentMethod?: 'tng' | 'duitnow' | 'card' | null;
  transactionReference?: string;
  privateReceipt?: PrivateReceiptRecord;
  stripeSessionId?: string;
  stripeSessionIds?: string[];
  stripePaymentIntentId?: string;
  paidAt?: string;
  verifiedByStaff?: boolean;
  verificationNote?: string;
  correctionReason?: string;
  lastCardAttemptMessage?: string;
  confirmationEmailStatus?: 'sent' | 'not_configured' | 'failed' | null;
  confirmationEmailSentAt?: string;
  confirmationEmailId?: string;
  confirmationEmailError?: string;
  confirmationEmailLastAttemptAt?: string;
  createdAt: string;
}

interface AdminCredentialHash {
  salt: string;
  hash: string;
  claimedAt: string;
}

interface PersistedStoreData {
  orders: Record<string, OrderRecord>;
  processedStripeEvents: string[];
  adminCredential?: AdminCredentialHash;
  storeSettings?: EditableStoreSettings;
}

const ordersStore: Map<string, OrderRecord> = new Map();
const processedStripeEvents: Set<string> = new Set();
const inFlightConfirmationEmails: Set<string> = new Set();
let claimedAdminCredential: AdminCredentialHash | null = null;
let storeSettings: EditableStoreSettings = getDefaultStoreSettings();

// In-memory admin sessions & login rate-limiting
const adminSessions: Map<string, { expiresAt: number }> = new Map();
const failedLoginTracker: Map<string, { count: number; resetAt: number }> = new Map();

function mergeStoreSettings(saved?: Partial<EditableStoreSettings>): EditableStoreSettings {
  const defaults = getDefaultStoreSettings();
  if (!saved || typeof saved !== 'object') return defaults;
  return {
    logoUrl: typeof saved.logoUrl === 'string' && saved.logoUrl.trim() ? saved.logoUrl.trim() : defaults.logoUrl,
    heroImageUrl:
      typeof saved.heroImageUrl === 'string' && saved.heroImageUrl.trim()
        ? saved.heroImageUrl.trim()
        : defaults.heroImageUrl,
    productImages: {
      keychain:
        typeof saved.productImages?.keychain === 'string' && saved.productImages.keychain.trim()
          ? saved.productImages.keychain.trim()
          : defaults.productImages.keychain,
      magnet:
        typeof saved.productImages?.magnet === 'string' && saved.productImages.magnet.trim()
          ? saved.productImages.magnet.trim()
          : defaults.productImages.magnet,
      bundle:
        typeof saved.productImages?.bundle === 'string' && saved.productImages.bundle.trim()
          ? saved.productImages.bundle.trim()
          : defaults.productImages.bundle
    },
    galleryItems:
      Array.isArray(saved.galleryItems) && saved.galleryItems.length > 0
        ? saved.galleryItems.slice(0, 6).map((item, idx) => {
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
        typeof saved.deliveryRatesSen?.peninsular === 'number' &&
        Number.isInteger(saved.deliveryRatesSen.peninsular) &&
        saved.deliveryRatesSen.peninsular >= 0
          ? saved.deliveryRatesSen.peninsular
          : defaults.deliveryRatesSen.peninsular,
      eastMalaysia:
        typeof saved.deliveryRatesSen?.eastMalaysia === 'number' &&
        Number.isInteger(saved.deliveryRatesSen.eastMalaysia) &&
        saved.deliveryRatesSen.eastMalaysia >= 0
          ? saved.deliveryRatesSen.eastMalaysia
          : defaults.deliveryRatesSen.eastMalaysia
    },
    whatsappSupportNumber:
      typeof saved.whatsappSupportNumber === 'string'
        ? saved.whatsappSupportNumber.replace(/\D/g, '').slice(0, 20)
        : defaults.whatsappSupportNumber,
    qrOverrides: {
      tng: {
        enabled:
          typeof saved.qrOverrides?.tng?.enabled === 'boolean' ? saved.qrOverrides.tng.enabled : null,
        recipientName:
          typeof saved.qrOverrides?.tng?.recipientName === 'string'
            ? saved.qrOverrides.tng.recipientName.trim().slice(0, 140)
            : '',
        qrImage:
          typeof saved.qrOverrides?.tng?.qrImage === 'string'
            ? saved.qrOverrides.tng.qrImage.trim()
            : ''
      },
      duitnow: {
        enabled:
          typeof saved.qrOverrides?.duitnow?.enabled === 'boolean'
            ? saved.qrOverrides.duitnow.enabled
            : null,
        recipientName:
          typeof saved.qrOverrides?.duitnow?.recipientName === 'string'
            ? saved.qrOverrides.duitnow.recipientName.trim().slice(0, 140)
            : '',
        qrImage:
          typeof saved.qrOverrides?.duitnow?.qrImage === 'string'
            ? saved.qrOverrides.duitnow.qrImage.trim()
            : ''
      }
    }
  };
}

function loadStoreFromDisk(): void {
  try {
    if (!fs.existsSync(storeFilePath)) return;
    const raw = fs.readFileSync(storeFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedStoreData>;
    let migrated = false;
    if (parsed.orders && typeof parsed.orders === 'object') {
      for (const [ref, record] of Object.entries(parsed.orders)) {
        if (record && typeof record.reference === 'string') {
          if (!record.accessToken || typeof record.accessToken !== 'string') {
            record.accessToken = crypto.randomBytes(24).toString('base64url');
            migrated = true;
          }
          ordersStore.set(ref, record);
        }
      }
    }
    if (Array.isArray(parsed.processedStripeEvents)) {
      for (const id of parsed.processedStripeEvents) {
        if (typeof id === 'string') processedStripeEvents.add(id);
      }
    }
    if (
      parsed.adminCredential &&
      typeof parsed.adminCredential.salt === 'string' &&
      typeof parsed.adminCredential.hash === 'string'
    ) {
      claimedAdminCredential = parsed.adminCredential;
    }
    if (parsed.storeSettings) {
      storeSettings = mergeStoreSettings(parsed.storeSettings);
    }
    if (migrated) {
      saveStoreToDisk();
    }
  } catch (err) {
    console.error('Failed to load persisted store from disk:', err);
  }
}

function saveStoreToDisk(): void {
  const storageHealth = checkPrivateStorageHealth();
  if (!storageHealth.configured) {
    throw new Error(storageHealth.issue || 'Private storage is not writable.');
  }
  const payload: PersistedStoreData = {
    orders: Object.fromEntries(ordersStore.entries()),
    processedStripeEvents: Array.from(processedStripeEvents.values()),
    adminCredential: claimedAdminCredential ?? undefined,
    storeSettings
  };
  const tempPath = `${storeFilePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tempPath, storeFilePath);
}

loadStoreFromDisk();

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

function getDeliveryConfigForState(state: string): { zone: string; rateSen: number } | null {
  const normalized = state.trim().toLowerCase();
  if (PENINSULAR_STATES.has(normalized)) {
    return { zone: 'Peninsular Malaysia', rateSen: storeSettings.deliveryRatesSen.peninsular };
  }
  if (EAST_MALAYSIA_STATES.has(normalized)) {
    return { zone: 'Sabah & Sarawak', rateSen: storeSettings.deliveryRatesSen.eastMalaysia };
  }
  return null;
}

function getAdminAuthMode(): 'env' | 'claimed' | 'bootstrap_required' {
  const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
  if (envPasscode.length > 0) return 'env';
  if (claimedAdminCredential) return 'claimed';
  return 'bootstrap_required';
}

function verifyAdminPasscode(inputPasscode: string): boolean {
  const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
  if (envPasscode.length > 0) {
    return safeEqualStrings(inputPasscode, envPasscode);
  }
  if (claimedAdminCredential) {
    const candidate = hashPasscode(inputPasscode, claimedAdminCredential.salt);
    return safeEqualStrings(candidate.hash, claimedAdminCredential.hash);
  }
  return false;
}

function createAdminSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return token;
}

function getPaymentMethodDisplayLabel(method?: 'tng' | 'duitnow' | 'card' | null): string | null {
  if (method === 'tng') return 'Touch ’n Go eWallet QR';
  if (method === 'duitnow') return 'Public Bank QR Pay';
  if (method === 'card') return 'Credit or Debit Card (Stripe)';
  return null;
}

// Sanitize order for public client response (never expose private filesystem paths or secret IDs)
function toPublicOrder(order: OrderRecord) {
  return {
    reference: order.reference,
    accessToken: order.accessToken,
    productId: order.productId,
    bundleId: order.bundleId,
    productName: order.productName,
    itemQuantity: order.itemQuantity,
    subtotalSen: order.subtotalSen,
    regularSubtotalSen: order.regularSubtotalSen,
    savingsSen: order.savingsSen,
    deliveryFeeSen: order.deliveryFeeSen,
    totalSen: order.totalSen,
    photoUrl: order.photoUrl,
    customer: order.customer,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod ?? null,
    paymentMethodLabel: getPaymentMethodDisplayLabel(order.paymentMethod),
    transactionReference: order.transactionReference,
    receiptSubmitted: Boolean(order.privateReceipt),
    receiptFileName: order.privateReceipt?.originalFilename,
    receiptMimeType: order.privateReceipt?.mimeType,
    receiptUploadedAt: order.privateReceipt?.uploadedAt,
    paidAt: order.paidAt,
    verifiedByStaff: Boolean(order.verifiedByStaff),
    verificationNote: order.verificationNote,
    correctionReason: order.correctionReason,
    lastCardAttemptMessage: order.lastCardAttemptMessage,
    confirmationEmailStatus: order.confirmationEmailStatus ?? null,
    confirmationEmailSentAt: order.confirmationEmailSentAt,
    createdAt: order.createdAt
  };
}

// Admin order serializer: includes sanitized email delivery error details for authorised staff only
function toAdminOrder(order: OrderRecord) {
  return {
    ...toPublicOrder(order),
    confirmationEmailError: order.confirmationEmailError,
    confirmationEmailLastAttemptAt: order.confirmationEmailLastAttemptAt
  };
}

function extractOrderToken(req: express.Request): string {
  const headerToken = typeof req.headers['x-order-token'] === 'string' ? req.headers['x-order-token'] : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const bodyToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken : '';
  return (headerToken || queryToken || bodyToken).trim();
}

function isOrderAuthorized(req: express.Request, order: OrderRecord): boolean {
  const token = extractOrderToken(req);
  if (!token || !order.accessToken) return false;
  return safeEqualStrings(token, order.accessToken);
}

// Validate that an asset/QR image path is an existing local asset (/payments/, /uploads/, /assets/, /src/assets/) or an https:// URL
function validateImageSource(
  rawUrl: string,
  allowedPrefixes: Array<'/payments/' | '/uploads/' | '/assets/' | '/src/assets/'>
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
  else if (normalized.startsWith('/public/uploads/')) normalized = normalized.slice('/public'.length);
  else if (normalized.startsWith('public/uploads/')) normalized = '/' + normalized.slice('public/'.length);
  else if (normalized.startsWith('uploads/')) normalized = '/' + normalized;
  else if (normalized.startsWith('/public/assets/')) normalized = normalized.slice('/public'.length);
  else if (normalized.startsWith('public/assets/')) normalized = '/' + normalized.slice('public/'.length);
  else if (normalized.startsWith('assets/')) normalized = '/' + normalized;
  else if (normalized.startsWith('src/assets/')) normalized = '/' + normalized;

  const prefixToDir: Record<string, string> = {
    '/payments/': publicPaymentsDir,
    '/uploads/': publicUploadsDir,
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

function validateQrImageSource(qrImage: string): { valid: boolean; normalizedUrl?: string; reason?: string } {
  return validateImageSource(qrImage, ['/payments/', '/assets/', '/src/assets/']);
}

function validateStorefrontAssetSource(imagePath: string): {
  valid: boolean;
  normalizedUrl?: string;
  reason?: string;
} {
  return validateImageSource(imagePath, ['/uploads/', '/assets/', '/src/assets/', '/payments/']);
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
  privateStorageReady: boolean;
  privateStorageIssue?: string;
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

  if (!opts.privateStorageReady) {
    issues.push(opts.privateStorageIssue || 'Private receipt storage is not configured.');
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

function getStripeConfig(): {
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
  const storageHealth = checkPrivateStorageHealth();

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

  if (!storageHealth.configured) {
    return {
      client: null,
      mode,
      webhookConfigured,
      livePaymentsEnabled,
      error: storageHealth.issue || 'Private storage must be configured before enabling payments.'
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

function getEmailConfig(): {
  configured: boolean;
  provider: 'resend' | 'smtp' | 'none';
  fromAddress: string | null;
  issue?: string;
} {
  const fromAddress = (process.env.EMAIL_FROM || '').trim();
  const hasValidFrom = isValidEmailFromHeader(fromAddress);
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const explicitProvider = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();

  // Primary provider: Resend API (SMTP variables are completely ignored when Resend is selected)
  if (resendKey || explicitProvider === 'resend') {
    if (!resendKey) {
      return {
        configured: false,
        provider: 'resend',
        fromAddress: hasValidFrom ? fromAddress : null,
        issue: 'RESEND_API_KEY is missing on the server.'
      };
    }
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

  // Optional legacy SMTP fallback: only used when Resend is not configured AND all SMTP vars are explicitly provided
  const smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  if (smtpHost && smtpUser && smtpPass && hasValidFrom) {
    return { configured: true, provider: 'smtp', fromAddress };
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

function evaluateAllPaymentMethods() {
  const privateStorage = checkPrivateStorageHealth();

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
    override: storeSettings.qrOverrides.tng,
    privateStorageReady: privateStorage.configured,
    privateStorageIssue: privateStorage.issue
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
    override: storeSettings.qrOverrides.duitnow,
    privateStorageReady: privateStorage.configured,
    privateStorageIssue: privateStorage.issue
  });

  // 3. Credit or Debit Card (Stripe) — evaluated independently
  const stripeInfo = getStripeConfig();
  const emailInfo = getEmailConfig();

  return {
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
      privateStorage
    }
  };
}

function getPublicStorefrontConfig() {
  const digits = storeSettings.whatsappSupportNumber.replace(/\D/g, '');
  const whatsappUrl = digits.length >= 8 ? `https://wa.me/${digits}` : null;
  return {
    logoUrl: storeSettings.logoUrl,
    heroImageUrl: storeSettings.heroImageUrl,
    productImages: storeSettings.productImages,
    galleryItems: storeSettings.galleryItems,
    deliveryRatesSen: storeSettings.deliveryRatesSen,
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

function sanitizeDisplayFilename(raw: unknown, fallbackExt: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return `receipt.${fallbackExt}`;
  }
  const base = path.basename(raw.trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || `receipt.${fallbackExt}`;
}

function buildConfirmationEmailContent(order: OrderRecord, originUrl: string) {
  const orderLink = `${originUrl}/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.accessToken)}`;
  const methodLabel = getPaymentMethodDisplayLabel(order.paymentMethod) || 'Confirmed payment';
  const totalPaid = formatRM(order.totalSen);
  const subject = `Order Confirmed — Little Pixel Keepsakes (${order.reference})`;

  const text = [
    PAID_CONFIRMATION_HEADING,
    '',
    `Hi ${order.customer.fullName},`,
    '',
    `Order Reference: ${order.reference}`,
    `Items: ${order.productName} (Qty ${order.itemQuantity})`,
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
      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Hi ${escapeHtml(order.customer.fullName)},</p>
      <div style="background: #FFFFFF; border: 1px solid rgba(20,35,60,0.12); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Order Reference:</strong> <span style="font-family: monospace;">${escapeHtml(order.reference)}</span></p>
        <p style="margin: 0 0 8px; font-size: 13px;"><strong>Items:</strong> ${escapeHtml(order.productName)} (Qty ${order.itemQuantity})</p>
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

// Guaranteed at-most-once confirmation email per paid order.
// Never mutates order.paymentStatus or blocks payment/storage availability.
async function sendOrderConfirmationEmailOnce(
  order: OrderRecord,
  req?: express.Request
): Promise<{
  sent: boolean;
  skipped?: boolean;
  status: 'sent' | 'not_configured' | 'failed';
  error?: string;
}> {
  if (order.paymentStatus !== 'Paid') {
    return { sent: false, skipped: true, status: 'not_configured' };
  }
  if (order.confirmationEmailSentAt) {
    return { sent: false, skipped: true, status: 'sent' };
  }
  if (inFlightConfirmationEmails.has(order.reference)) {
    return { sent: false, skipped: true, status: 'sent' };
  }

  const emailCfg = getEmailConfig();
  if (!emailCfg.configured || !emailCfg.fromAddress) {
    const notConfiguredMsg =
      emailCfg.issue || 'Set RESEND_API_KEY and EMAIL_FROM on the server to send confirmation emails via Resend.';
    order.confirmationEmailStatus = 'not_configured';
    order.confirmationEmailError = sanitizeEmailError(notConfiguredMsg);
    order.confirmationEmailLastAttemptAt = new Date().toISOString();
    ordersStore.set(order.reference, order);
    saveStoreToDisk();
    return { sent: false, status: 'not_configured', error: order.confirmationEmailError };
  }

  inFlightConfirmationEmails.add(order.reference);
  const attemptTime = new Date().toISOString();
  try {
    const originUrl = resolveTrustedOrigin(req);
    const { subject, text, html } = buildConfirmationEmailContent(order, originUrl);

    if (emailCfg.provider === 'resend') {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: emailCfg.fromAddress,
          to: [order.customer.email],
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
          if (parsedErr?.message) {
            detail = parsedErr.message;
          }
        } catch {
          // Use raw response text
        }
        throw new Error(`Resend HTTP ${response.status}: ${detail || response.statusText || 'Request failed'}`);
      }
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      order.confirmationEmailStatus = 'sent';
      order.confirmationEmailSentAt = new Date().toISOString();
      order.confirmationEmailLastAttemptAt = attemptTime;
      order.confirmationEmailId = data.id || `resend_${Date.now()}`;
      order.confirmationEmailError = undefined;
      ordersStore.set(order.reference, order);
      saveStoreToDisk();
      return { sent: true, status: 'sent' };
    }

    if (emailCfg.provider === 'smtp') {
      const port = Number.parseInt((process.env.SMTP_PORT || '587').trim(), 10) || 587;
      const secureEnv = (process.env.SMTP_SECURE || '').trim().toLowerCase();
      const secure = secureEnv ? secureEnv === 'true' || secureEnv === '1' : port === 465;

      const transporter = nodemailer.createTransport({
        host: (process.env.SMTP_HOST || '').trim(),
        port,
        secure,
        auth: {
          user: (process.env.SMTP_USER || '').trim(),
          pass: (process.env.SMTP_PASS || '').trim()
        }
      });

      const info = await transporter.sendMail({
        from: emailCfg.fromAddress,
        to: order.customer.email,
        subject,
        text,
        html
      });

      order.confirmationEmailStatus = 'sent';
      order.confirmationEmailSentAt = new Date().toISOString();
      order.confirmationEmailLastAttemptAt = attemptTime;
      order.confirmationEmailId = info.messageId || `smtp_${Date.now()}`;
      order.confirmationEmailError = undefined;
      ordersStore.set(order.reference, order);
      saveStoreToDisk();
      return { sent: true, status: 'sent' };
    }

    return { sent: false, status: 'not_configured' };
  } catch (err: any) {
    const safeError = sanitizeEmailError(err?.message || err || 'Email delivery failed');
    console.error(`Confirmation email failed for order ${order.reference}: ${safeError}`);
    order.confirmationEmailStatus = 'failed';
    order.confirmationEmailError = safeError;
    order.confirmationEmailLastAttemptAt = attemptTime;
    ordersStore.set(order.reference, order);
    try {
      saveStoreToDisk();
    } catch (saveErr) {
      console.error(`Failed to persist email error for order ${order.reference}:`, saveErr);
    }
    return { sent: false, status: 'failed', error: safeError };
  } finally {
    inFlightConfirmationEmails.delete(order.reference);
  }
}

function requireAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
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
  return next();
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  const PORT = 3000;

  // Stripe webhook route MUST receive the raw request body before express.json()
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    const stripeInfo = getStripeConfig();

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

    // Safe-to-repeat idempotency check
    if (processedStripeEvents.has(event.id)) {
      return res.json({ received: true, duplicate: true });
    }

    const markEventProcessed = () => {
      processedStripeEvents.add(event.id);
      saveStoreToDisk();
    };

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      const reference = session.client_reference_id || session.metadata?.orderReference || session.metadata?.reference;

      if (!reference || !ORDER_REF_REGEX.test(reference) || !ordersStore.has(reference)) {
        markEventProcessed();
        return res.json({ received: true, ignored: 'order_not_found' });
      }

      const order = ordersStore.get(reference)!;

      // Already confirmed paid — idempotent no-op (never sends a duplicate confirmation email)
      if (order.paymentStatus === 'Paid') {
        markEventProcessed();
        return res.json({ received: true, duplicate: true });
      }

      // Strictly verify this Stripe session was created by this server for this saved order
      const knownSessionIds = order.stripeSessionIds || (order.stripeSessionId ? [order.stripeSessionId] : []);
      const sessionMatchesOrder = knownSessionIds.includes(session.id);

      const amountTotal = session.amount_total;
      const currency = (session.currency || '').toLowerCase();
      const paymentStatus = session.payment_status;

      if (
        sessionMatchesOrder &&
        typeof amountTotal === 'number' &&
        amountTotal === order.totalSen &&
        currency === 'myr' &&
        paymentStatus === 'paid'
      ) {
        order.paymentStatus = 'Paid';
        order.paymentMethod = 'card';
        order.stripeSessionId = session.id;
        order.stripePaymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;
        order.paidAt = new Date().toISOString();
        order.correctionReason = undefined;
        order.lastCardAttemptMessage = undefined;
        ordersStore.set(reference, order);
        markEventProcessed();

        try {
          await sendOrderConfirmationEmailOnce(order, req);
        } catch (emailErr) {
          console.error(`Unexpected confirmation email error for order ${reference}:`, emailErr);
        }
        console.log(`Order ${reference} confirmed Paid via verified Stripe webhook (${event.id}).`);
        return res.json({ received: true });
      } else {
        console.warn(`Stripe webhook mismatch for order ${reference}`, {
          eventId: event.id,
          sessionMatchesOrder,
          expectedAmount: order.totalSen,
          receivedAmount: amountTotal,
          receivedCurrency: currency,
          paymentStatus
        });
      }

      markEventProcessed();
      return res.json({ received: true });
    }

    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const reference = session.client_reference_id || session.metadata?.orderReference || session.metadata?.reference;

      if (reference && ordersStore.has(reference)) {
        const order = ordersStore.get(reference)!;
        if (order.paymentStatus === 'Awaiting payment' || order.paymentStatus === 'Receipt correction needed') {
          order.lastCardAttemptMessage =
            event.type === 'checkout.session.expired'
              ? 'Your previous card checkout session expired. You can try again below without re-uploading your photo.'
              : 'Your card payment failed. You can retry with another card or choose a QR payment method below.';
          ordersStore.set(reference, order);
        }
      }

      markEventProcessed();
      return res.json({ received: true });
    }

    markEventProcessed();
    return res.json({ received: true });
  });

  app.use(express.json({ limit: '16mb' }));

  // Public Storefront & Merchant Config Endpoint
  app.get('/api/store-config', (_req, res) => {
    const { merchantConfig, diagnostics } = evaluateAllPaymentMethods();
    return res.json({
      success: true,
      storefront: getPublicStorefrontConfig(),
      merchantConfig,
      configIssues: {
        tng: diagnostics.tng.issues,
        duitnow: diagnostics.duitnow.issues
      }
    });
  });

  // Backwards-compatible Merchant Payment Configuration Endpoint
  app.get('/api/merchant-config', (_req, res) => {
    const { merchantConfig, diagnostics } = evaluateAllPaymentMethods();
    return res.json({
      success: true,
      merchantConfig,
      configIssues: {
        tng: diagnostics.tng.issues,
        duitnow: diagnostics.duitnow.issues
      }
    });
  });

  // Photo Upload Endpoint
  app.post('/api/upload-photo', (req, res) => {
    try {
      const { imageBase64 } = req.body || {};
      if (typeof imageBase64 !== 'string' || !imageBase64) {
        return res.status(400).json({ error: 'No image data provided.' });
      }

      const matches = imageBase64.match(/^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid image format. Please upload a JPG or PNG image.' });
      }

      const mimeType = matches[1].toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');

      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'Photo must be smaller than 10 MB.' });
      }
      if (!verifyMagicBytes(buffer, mimeType)) {
        return res.status(400).json({ error: 'Uploaded file does not match a valid JPG or PNG image.' });
      }

      const uniqueName = `lpk_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
      const filePath = path.resolve(publicUploadsDir, uniqueName);
      if (!filePath.startsWith(publicUploadsDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid file destination.' });
      }

      fs.writeFileSync(filePath, buffer);
      return res.json({ success: true, photoUrl: `/uploads/${uniqueName}` });
    } catch {
      return res.status(500).json({ error: 'Failed to save uploaded photo.' });
    }
  });

  // Validate Delivery Endpoint (uses live editable delivery rates)
  app.post('/api/validate-delivery', (req, res) => {
    try {
      const { state } = req.body || {};
      if (typeof state !== 'string' || !state.trim()) {
        return res.status(400).json({ error: 'State is required.' });
      }

      const deliveryConfig = getDeliveryConfigForState(state);
      if (!deliveryConfig) {
        return res.status(400).json({
          valid: false,
          error: `Delivery rate not configured for state "${state}". Please select a valid Malaysian state.`
        });
      }

      return res.json({ valid: true, zone: deliveryConfig.zone, deliveryFeeSen: deliveryConfig.rateSen });
    } catch {
      return res.status(500).json({ error: 'Delivery validation error.' });
    }
  });

  // Create Order Endpoint
  app.post('/api/create-order', (req, res) => {
    try {
      const { productId, bundleId, photoUrl, customer } = req.body || {};
      if (typeof productId !== 'string' || typeof photoUrl !== 'string' || !customer || typeof customer !== 'object') {
        return res.status(400).json({ error: 'Missing required order details.' });
      }

      if (!/^\/uploads\/[a-zA-Z0-9._-]+\.(jpg|jpeg|png)$/.test(photoUrl)) {
        return res.status(400).json({ error: 'Invalid uploaded photo reference.' });
      }
      const photoFilePath = path.resolve(publicUploadsDir, path.basename(photoUrl));
      if (!photoFilePath.startsWith(publicUploadsDir + path.sep) || !fs.existsSync(photoFilePath)) {
        return res.status(400).json({ error: 'Uploaded photo not found. Please upload your photo again.' });
      }

      let key = productId;
      if (productId === 'bundle') {
        if (typeof bundleId !== 'string' || !PRODUCT_CONFIG[bundleId]) {
          return res.status(400).json({ error: 'Invalid bundle selection.' });
        }
        key = bundleId;
      }

      const productConfig = PRODUCT_CONFIG[key];
      if (!productConfig) return res.status(400).json({ error: 'Invalid product.' });

      const cleanCustomer = {
        fullName: String(customer.fullName || '').trim().slice(0, 120),
        email: String(customer.email || '').trim().slice(0, 160),
        mobile: String(customer.mobile || '').trim().slice(0, 40),
        address: String(customer.address || '').trim().slice(0, 300),
        postcode: String(customer.postcode || '').trim().slice(0, 20),
        city: String(customer.city || '').trim().slice(0, 80),
        state: String(customer.state || '').trim().slice(0, 60)
      };

      if (
        !cleanCustomer.fullName ||
        !cleanCustomer.email ||
        !cleanCustomer.mobile ||
        !cleanCustomer.address ||
        !cleanCustomer.postcode ||
        !cleanCustomer.city ||
        !cleanCustomer.state
      ) {
        return res.status(400).json({ error: 'Please complete all required customer and delivery fields.' });
      }

      const deliveryConfig = getDeliveryConfigForState(cleanCustomer.state);
      if (!deliveryConfig) {
        return res.status(400).json({ error: `Delivery rate not configured for state "${cleanCustomer.state}".` });
      }

      const itemQuantity = productId === 'bundle' ? 2 : 1;
      const subtotalSen = productConfig.priceSen;
      const regularSubtotalSen = productConfig.regularSen;
      const savingsSen = regularSubtotalSen ? regularSubtotalSen - subtotalSen : undefined;
      const deliveryFeeSen = deliveryConfig.rateSen;
      const totalSen = subtotalSen + deliveryFeeSen;

      const randomCode = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      const reference = `LPK-${new Date().getFullYear()}-${randomCode}`;
      const accessToken = crypto.randomBytes(24).toString('base64url');

      const orderRecord: OrderRecord = {
        reference,
        accessToken,
        productId,
        bundleId: productId === 'bundle' ? bundleId : undefined,
        productName: productConfig.name,
        itemQuantity,
        subtotalSen,
        regularSubtotalSen,
        savingsSen,
        deliveryFeeSen,
        totalSen,
        photoUrl,
        customer: cleanCustomer,
        paymentStatus: 'Awaiting payment',
        paymentMethod: null,
        stripeSessionIds: [],
        createdAt: new Date().toISOString()
      };

      ordersStore.set(reference, orderRecord);
      saveStoreToDisk();

      return res.json({
        success: true,
        reference,
        accessToken,
        order: toPublicOrder(orderRecord)
      });
    } catch {
      return res.status(500).json({ error: 'Failed to create order.' });
    }
  });

  // Upload or Replace Payment Receipt Endpoint (Manual QR — requires secure order token, stores privately outside public/)
  app.post('/api/upload-receipt', (req, res) => {
    try {
      const { reference, paymentMethod, transactionReference, receiptBase64, filename } = req.body || {};

      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      const order = ordersStore.get(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({ error: 'Valid secure order link token is required to submit a receipt.' });
      }
      if (order.paymentStatus === 'Paid') {
        return res.status(409).json({ error: 'This order has already been paid.' });
      }
      if (order.paymentStatus === 'Pending verification') {
        return res.status(409).json({
          error: 'A payment receipt has already been submitted for this order and is pending verification.'
        });
      }

      if (paymentMethod !== 'tng' && paymentMethod !== 'duitnow') {
        return res.status(400).json({ error: 'Please select a valid manual QR payment method.' });
      }
      const qrMethod: 'tng' | 'duitnow' = paymentMethod;

      const { merchantConfig } = evaluateAllPaymentMethods();
      if (!merchantConfig[qrMethod]) {
        return res.status(400).json({ error: 'Selected QR payment method is not currently configured.' });
      }

      const storageHealth = checkPrivateStorageHealth();
      if (!storageHealth.configured) {
        return res.status(503).json({ error: 'Private receipt storage is not configured on the server.' });
      }

      const cleanTxRef = typeof transactionReference === 'string' ? transactionReference.trim() : '';
      if (cleanTxRef.length < 3 || cleanTxRef.length > 100) {
        return res.status(400).json({ error: 'Please enter a valid transaction reference (3–100 characters).' });
      }

      if (typeof receiptBase64 !== 'string' || !receiptBase64) {
        return res.status(400).json({ error: 'Please upload your payment receipt (JPG, PNG, or PDF).' });
      }

      const matches = receiptBase64.match(/^data:(image\/(?:jpeg|jpg|png)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid receipt file format. Please upload a JPG, PNG, or PDF file.' });
      }

      const rawMime = matches[1].toLowerCase();
      const normalizedMime: PrivateReceiptRecord['mimeType'] =
        rawMime === 'application/pdf'
          ? 'application/pdf'
          : rawMime === 'image/png'
            ? 'image/png'
            : 'image/jpeg';
      const ext = normalizedMime === 'application/pdf' ? 'pdf' : normalizedMime === 'image/png' ? 'png' : 'jpg';

      const buffer = Buffer.from(matches[2], 'base64');
      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'Receipt file must be smaller than 10 MB.' });
      }
      if (!verifyMagicBytes(buffer, normalizedMime)) {
        return res.status(400).json({ error: 'Receipt file content does not match a valid JPG, PNG, or PDF file.' });
      }

      // If replacing a previously rejected receipt, remove the superseded private file cleanly
      if (order.privateReceipt?.storageFileName) {
        const oldPath = path.resolve(privateReceiptsDir, path.basename(order.privateReceipt.storageFileName));
        if (oldPath.startsWith(privateReceiptsDir + path.sep) && fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch {
            // Best-effort cleanup
          }
        }
      }

      const receiptId = crypto.randomUUID();
      const storageFileName = `receipt_${receiptId}.${ext}`;
      const privatePath = path.resolve(privateReceiptsDir, storageFileName);

      if (!privatePath.startsWith(privateReceiptsDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid receipt storage path.' });
      }

      fs.writeFileSync(privatePath, buffer, { mode: 0o600 });

      order.paymentStatus = 'Pending verification';
      order.paymentMethod = qrMethod;
      order.transactionReference = cleanTxRef;
      order.lastCardAttemptMessage = undefined;
      order.correctionReason = undefined;
      order.verificationNote = undefined;
      order.privateReceipt = {
        id: receiptId,
        storageFileName,
        originalFilename: sanitizeDisplayFilename(filename, ext),
        mimeType: normalizedMime,
        sizeBytes: buffer.length,
        uploadedAt: new Date().toISOString()
      };
      ordersStore.set(reference, order);
      saveStoreToDisk();

      return res.json({
        success: true,
        message: 'We’ve received your receipt. We’ll confirm your order once we verify your payment.',
        order: toPublicOrder(order)
      });
    } catch {
      return res.status(500).json({ error: 'Failed to store payment receipt.' });
    }
  });

  // Create Stripe Checkout Session Endpoint (MYR, server-side saved order total, requires secure order token)
  app.post('/api/create-stripe-session', async (req, res) => {
    try {
      const { reference } = req.body || {};
      if (typeof reference !== 'string' || !ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference.' });
      }

      const order = ordersStore.get(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({ error: 'Valid secure order link token is required to start card payment.' });
      }
      if (order.paymentStatus === 'Paid') {
        return res.status(409).json({ error: 'This order is already paid. A new payment session cannot be created.' });
      }
      if (order.paymentStatus === 'Pending verification') {
        return res.status(409).json({
          error: 'A QR receipt is pending verification for this order. Starting another payment is disabled.'
        });
      }

      const stripeInfo = getStripeConfig();
      if (!stripeInfo.client) {
        return res.status(503).json({
          code: 'STRIPE_NOT_CONFIGURED',
          error:
            stripeInfo.error ||
            'Card payment is temporarily unavailable. Please use an enabled QR payment method.'
        });
      }

      const baseUrl = resolveTrustedOrigin(req);
      const tokenQuery = `&token=${encodeURIComponent(order.accessToken)}`;

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        {
          price_data: {
            currency: 'myr',
            product_data: {
              name: `Little Pixel Keepsakes — ${order.productName}`,
              description: order.savingsSen
                ? `Order ${order.reference} · Includes bundle savings of ${formatRM(order.savingsSen)}`
                : `Order ${order.reference}`
            },
            unit_amount: order.subtotalSen
          },
          quantity: 1
        },
        {
          price_data: {
            currency: 'myr',
            product_data: {
              name: `Delivery (${order.customer.state})`,
              description: `Courier delivery to ${order.customer.city}, ${order.customer.state}`
            },
            unit_amount: order.deliveryFeeSen
          },
          quantity: 1
        }
      ];

      const session = await stripeInfo.client.checkout.sessions.create({
        mode: 'payment',
        customer_email: order.customer.email,
        client_reference_id: order.reference,
        line_items: lineItems,
        success_url: `${baseUrl}/?order=${encodeURIComponent(order.reference)}${tokenQuery}&payment=success`,
        cancel_url: `${baseUrl}/?order=${encodeURIComponent(order.reference)}${tokenQuery}&payment=cancelled`,
        metadata: {
          orderReference: order.reference
        },
        payment_intent_data: {
          metadata: {
            orderReference: order.reference
          }
        }
      });

      if (!session.url) {
        return res.status(502).json({ error: 'Stripe did not return a checkout URL.' });
      }

      order.paymentMethod = 'card';
      order.stripeSessionId = session.id;
      order.stripeSessionIds = Array.from(new Set([...(order.stripeSessionIds || []), session.id]));
      ordersStore.set(reference, order);
      saveStoreToDisk();

      return res.json({ success: true, url: session.url, sessionId: session.id, mode: stripeInfo.mode });
    } catch (err: any) {
      console.error('Failed to create Stripe Checkout session:', err?.message || err);
      return res.status(502).json({
        error: 'Unable to start Stripe Checkout right now. Please try again or use a QR payment method.'
      });
    }
  });

  // Get Saved Order Status Endpoint (requires secure order link token)
  app.get('/api/orders/:reference', (req, res) => {
    try {
      const { reference } = req.params;
      if (!ORDER_REF_REGEX.test(reference)) {
        return res.status(400).json({ error: 'Invalid order reference format.' });
      }
      const order = ordersStore.get(reference);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (!isOrderAuthorized(req, order)) {
        return res.status(403).json({
          error: 'This order requires its secure order link. Please open the full link provided when you placed your order.'
        });
      }
      return res.json({ success: true, order: toPublicOrder(order) });
    } catch {
      return res.status(500).json({ error: 'Failed to retrieve order.' });
    }
  });

  // =========================================================================
  // PROTECTED STAFF ADMIN AUTH, ORDER VERIFICATION & STORE SETTINGS ROUTES
  // =========================================================================

  app.get('/api/admin/auth-status', (_req, res) => {
    const mode = getAdminAuthMode();
    return res.json({ success: true, mode });
  });

  // One-time first-run admin setup when ADMIN_PASSCODE is unset and no hash has been claimed yet
  app.post('/api/admin/bootstrap', (req, res) => {
    if (getAdminAuthMode() !== 'bootstrap_required') {
      return res.status(403).json({ error: 'Admin passcode is already configured.' });
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 8 || passcode.length > 128) {
      return res.status(400).json({ error: 'Choose an admin passcode between 8 and 128 characters.' });
    }

    const { salt, hash } = hashPasscode(passcode);
    claimedAdminCredential = { salt, hash, claimedAt: new Date().toISOString() };
    saveStoreToDisk();

    const token = createAdminSession();
    return res.json({ success: true, token });
  });

  app.post('/api/admin/login', (req, res) => {
    const mode = getAdminAuthMode();
    if (mode === 'bootstrap_required') {
      return res.status(400).json({ error: 'Complete first-run admin passcode setup first.' });
    }

    const ip = req.ip || 'unknown';
    const tracker = failedLoginTracker.get(ip);
    if (tracker && tracker.resetAt > Date.now() && tracker.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!passcode || !verifyAdminPasscode(passcode)) {
      const currentCount = tracker && tracker.resetAt > Date.now() ? tracker.count + 1 : 1;
      failedLoginTracker.set(ip, { count: currentCount, resetAt: Date.now() + LOGIN_WINDOW_MS });
      return res.status(401).json({ error: 'Incorrect staff passcode.' });
    }

    failedLoginTracker.delete(ip);
    const token = createAdminSession();
    return res.json({ success: true, token });
  });

  app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
    const token = (req.headers.authorization || '').slice(7).trim();
    adminSessions.delete(token);
    return res.json({ success: true });
  });

  // Protected: List all orders, payment/email/storage diagnostics & editable store settings
  app.get('/api/admin/orders', requireAdminAuth, (_req, res) => {
    const orders = Array.from(ordersStore.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(toAdminOrder);
    const { diagnostics } = evaluateAllPaymentMethods();
    return res.json({ success: true, orders, diagnostics, settings: storeSettings });
  });

  // Protected: Read editable store & merchant QR settings
  app.get('/api/admin/settings', requireAdminAuth, (_req, res) => {
    const { merchantConfig, diagnostics } = evaluateAllPaymentMethods();
    return res.json({
      success: true,
      settings: storeSettings,
      merchantConfig,
      diagnostics
    });
  });

  // Protected: Update editable logo, product images, delivery rates, WhatsApp number, merchant QR images & recipient names
  app.put('/api/admin/settings', requireAdminAuth, (req, res) => {
    try {
      const incoming = req.body?.settings as Partial<EditableStoreSettings> | undefined;
      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'Settings payload is required.' });
      }

      const next: EditableStoreSettings = JSON.parse(JSON.stringify(storeSettings));

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

      storeSettings = next;
      saveStoreToDisk();

      const { merchantConfig, diagnostics } = evaluateAllPaymentMethods();
      return res.json({
        success: true,
        settings: storeSettings,
        storefront: getPublicStorefrontConfig(),
        merchantConfig,
        diagnostics
      });
    } catch {
      return res.status(500).json({ error: 'Failed to save store settings.' });
    }
  });

  // Protected: Upload a logo, product/gallery image, or merchant QR image from Admin Settings
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

      const baseDir = target === 'qr' ? publicPaymentsDir : publicUploadsDir;
      const prefix = target === 'qr' ? 'qr' : 'asset';
      const publicPrefix = target === 'qr' ? '/payments/' : '/uploads/';
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

  // Protected: Stream private receipt file for staff verification
  app.get('/api/admin/orders/:reference/receipt', requireAdminAuth, (req, res) => {
    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }
    const order = ordersStore.get(reference);
    if (!order || !order.privateReceipt) {
      return res.status(404).json({ error: 'No payment receipt attached to this order.' });
    }

    const resolvedPath = path.resolve(privateReceiptsDir, path.basename(order.privateReceipt.storageFileName));
    if (!resolvedPath.startsWith(privateReceiptsDir + path.sep) || !fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Stored receipt file not found.' });
    }

    res.setHeader('Content-Type', order.privateReceipt.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${order.privateReceipt.originalFilename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(resolvedPath);
  });

  // Protected: Staff confirms incoming TNG or Public Bank transfer, marks order Paid, and sends one confirmation email
  app.post('/api/admin/orders/:reference/verify-payment', requireAdminAuth, async (req, res) => {
    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }
    const order = ordersStore.get(reference);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.paymentStatus === 'Paid') {
      return res.status(409).json({ error: 'Order is already marked as Paid.' });
    }
    if (
      order.paymentStatus !== 'Pending verification' ||
      !order.privateReceipt ||
      (order.paymentMethod !== 'tng' && order.paymentMethod !== 'duitnow')
    ) {
      return res.status(400).json({
        error: 'Only orders with a submitted TNG or Public Bank QR receipt pending verification can be marked paid by staff.'
      });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 240) : '';
    order.paymentStatus = 'Paid';
    order.paidAt = new Date().toISOString();
    order.verifiedByStaff = true;
    order.correctionReason = undefined;
    order.verificationNote =
      note || `Verified incoming ${getPaymentMethodDisplayLabel(order.paymentMethod)} transfer.`;
    ordersStore.set(reference, order);
    saveStoreToDisk();

    try {
      await sendOrderConfirmationEmailOnce(order, req);
    } catch (emailErr) {
      console.error(`Unexpected confirmation email error for order ${reference}:`, emailErr);
    }

    return res.json({ success: true, order: toAdminOrder(order) });
  });

  // Protected: Retry sending confirmation email for a Paid order without changing its Paid status
  app.post('/api/admin/orders/:reference/retry-email', requireAdminAuth, async (req, res) => {
    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }
    const order = ordersStore.get(reference);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.paymentStatus !== 'Paid') {
      return res.status(400).json({ error: 'Only paid orders can send a confirmation email.' });
    }
    if (order.confirmationEmailSentAt) {
      return res.status(409).json({
        error: 'Confirmation email has already been sent for this order.',
        order: toAdminOrder(order)
      });
    }

    const result = await sendOrderConfirmationEmailOnce(order, req);
    if (result.sent) {
      return res.json({ success: true, order: toAdminOrder(order) });
    }
    if (result.skipped && result.status === 'sent') {
      return res.status(409).json({
        error: 'Confirmation email has already been sent or is currently being sent.',
        order: toAdminOrder(order)
      });
    }
    const statusCode = result.status === 'not_configured' ? 503 : 502;
    return res.status(statusCode).json({
      success: false,
      error: result.error || 'Could not send confirmation email. Order remains Paid.',
      order: toAdminOrder(order)
    });
  });

  // Protected: Staff requests a corrected receipt (sets status to "Receipt correction needed")
  app.post('/api/admin/orders/:reference/reject-payment', requireAdminAuth, (req, res) => {
    const { reference } = req.params;
    if (!ORDER_REF_REGEX.test(reference)) {
      return res.status(400).json({ error: 'Invalid order reference.' });
    }
    const order = ordersStore.get(reference);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (order.paymentStatus !== 'Pending verification') {
      return res
        .status(400)
        .json({ error: 'Only orders pending verification can request a corrected receipt.' });
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 240)
        : 'We could not match your uploaded receipt to an incoming transaction. Please verify the recipient name and exact amount, then upload a corrected receipt.';

    order.paymentStatus = 'Receipt correction needed';
    order.correctionReason = reason;
    order.verificationNote = reason;
    order.lastCardAttemptMessage = undefined;
    ordersStore.set(reference, order);
    saveStoreToDisk();

    return res.json({ success: true, order: toAdminOrder(order) });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.use('/uploads', express.static(publicUploadsDir));
    app.use('/payments', express.static(publicPaymentsDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
