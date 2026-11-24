import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Private storage directories (strictly outside public/ and dist/)
const privateStorageDir = path.resolve(__dirname, 'private_storage');
const privateReceiptsDir = path.resolve(privateStorageDir, 'receipts');
const storeFilePath = path.resolve(privateStorageDir, 'store.json');
const publicUploadsDir = path.resolve(__dirname, 'public/uploads');
const publicPaymentsDir = path.resolve(__dirname, 'public/payments');

for (const dir of [privateStorageDir, privateReceiptsDir, publicUploadsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

// Configurable delivery rates by region / state (in integer sen)
const DELIVERY_RATES: Record<string, { zone: string; rateSen: number }> = {
  'johor': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kedah': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kelantan': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'melaka': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'negeri sembilan': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'pahang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'perak': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'perlis': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'penang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'pulau pinang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'selangor': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'terengganu': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kuala lumpur': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'putrajaya': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'sabah': { zone: 'Sabah & Sarawak', rateSen: 1500 },
  'sarawak': { zone: 'Sabah & Sarawak', rateSen: 1500 },
  'labuan': { zone: 'Sabah & Sarawak', rateSen: 1500 }
};

const ORDER_REF_REGEX = /^LPK-\d{4}-[A-Z0-9]{6,10}$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_LOGIN_ATTEMPTS = 10;

interface PrivateReceiptRecord {
  id: string;
  storageFileName: string;
  originalFilename: string;
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  uploadedAt: string;
}

interface OrderRecord {
  reference: string;
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
  paymentStatus: 'Awaiting payment' | 'Pending verification' | 'Paid';
  paymentMethod?: 'tng' | 'duitnow' | 'card' | null;
  transactionReference?: string;
  privateReceipt?: PrivateReceiptRecord;
  stripeSessionId?: string;
  stripeSessionIds?: string[];
  stripePaymentIntentId?: string;
  paidAt?: string;
  verifiedByStaff?: boolean;
  verificationNote?: string;
  lastCardAttemptMessage?: string;
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
}

const ordersStore: Map<string, OrderRecord> = new Map();
const processedStripeEvents: Set<string> = new Set();
let claimedAdminCredential: AdminCredentialHash | null = null;

// In-memory admin sessions & login rate-limiting
const adminSessions: Map<string, { expiresAt: number }> = new Map();
const failedLoginTracker: Map<string, { count: number; resetAt: number }> = new Map();

function loadStoreFromDisk(): void {
  try {
    if (!fs.existsSync(storeFilePath)) return;
    const raw = fs.readFileSync(storeFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedStoreData>;
    if (parsed.orders && typeof parsed.orders === 'object') {
      for (const [ref, record] of Object.entries(parsed.orders)) {
        if (record && typeof record.reference === 'string') {
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
  } catch (err) {
    console.error('Failed to load persisted store from disk:', err);
  }
}

function saveStoreToDisk(): void {
  const payload: PersistedStoreData = {
    orders: Object.fromEntries(ordersStore.entries()),
    processedStripeEvents: Array.from(processedStripeEvents.values()),
    adminCredential: claimedAdminCredential ?? undefined
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
    lastCardAttemptMessage: order.lastCardAttemptMessage,
    createdAt: order.createdAt
  };
}

// Validate that a QR image path is an existing local asset (/payments/, /assets/, /src/assets/) or an https:// URL
function validateQrImageSource(qrImage: string): { valid: boolean; normalizedUrl?: string; reason?: string } {
  const trimmed = qrImage.trim();
  if (!trimmed) {
    return { valid: false, reason: 'QR image path is empty.' };
  }
  if (trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') {
        return { valid: true, normalizedUrl: trimmed };
      }
      return { valid: false, reason: 'QR image URL must use https://.' };
    } catch {
      return { valid: false, reason: 'QR image URL is not a valid URL.' };
    }
  }

  // Normalize common local public/ prefixes (e.g. "payments/..." or "/public/payments/...")
  let normalized = trimmed;
  if (normalized.startsWith('/public/payments/')) {
    normalized = normalized.slice('/public'.length);
  } else if (normalized.startsWith('public/payments/')) {
    normalized = '/' + normalized.slice('public/'.length);
  } else if (normalized.startsWith('payments/')) {
    normalized = '/' + normalized;
  } else if (normalized.startsWith('/public/assets/')) {
    normalized = normalized.slice('/public'.length);
  } else if (normalized.startsWith('public/assets/')) {
    normalized = '/' + normalized.slice('public/'.length);
  } else if (normalized.startsWith('assets/')) {
    normalized = '/' + normalized;
  } else if (normalized.startsWith('src/assets/')) {
    normalized = '/' + normalized;
  }

  if (normalized.startsWith('/payments/')) {
    const resolved = path.resolve(__dirname, 'public', normalized.slice(1));
    if (!resolved.startsWith(publicPaymentsDir + path.sep)) {
      return { valid: false, reason: 'QR image path escapes /payments/.' };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { valid: false, reason: `QR image file not found at ${normalized}.` };
    }
    return { valid: true, normalizedUrl: normalized };
  }
  if (normalized.startsWith('/assets/')) {
    const resolved = path.resolve(__dirname, 'public', normalized.slice(1));
    const allowedDir = path.resolve(__dirname, 'public/assets');
    if (!resolved.startsWith(allowedDir + path.sep)) {
      return { valid: false, reason: 'QR image path escapes /assets/.' };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { valid: false, reason: `QR image file not found at ${normalized}.` };
    }
    return { valid: true, normalizedUrl: normalized };
  }
  if (normalized.startsWith('/src/assets/')) {
    const resolved = path.resolve(__dirname, normalized.slice(1));
    const allowedDir = path.resolve(__dirname, 'src/assets');
    if (!resolved.startsWith(allowedDir + path.sep)) {
      return { valid: false, reason: 'QR image path escapes /src/assets/.' };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { valid: false, reason: `QR image file not found at ${normalized}.` };
    }
    return { valid: true, normalizedUrl: normalized };
  }
  return {
    valid: false,
    reason: 'QR image must be a local path under /payments/, /assets/, /src/assets/, or an https:// URL.'
  };
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
}): QrMethodEvaluation {
  const issues: string[] = [];

  const rawEnabled = (opts.enabledEnv ?? '').trim().toLowerCase();
  let enabled = false;
  if (!rawEnabled) {
    issues.push(`${opts.enabledVarName} is missing or empty. Set to true to enable.`);
  } else if (rawEnabled === 'true' || rawEnabled === '1' || rawEnabled === 'yes') {
    enabled = true;
  } else if (rawEnabled === 'false' || rawEnabled === '0' || rawEnabled === 'no') {
    issues.push(`${opts.enabledVarName} is disabled (${opts.enabledEnv?.trim()}).`);
  } else {
    issues.push(`${opts.enabledVarName} has invalid boolean value "${opts.enabledEnv?.trim()}". Use true or false.`);
  }

  const recipientName = (opts.recipientEnv ?? '').trim();
  const rawQrImage = (opts.imageEnv ?? '').trim();
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

function getStripeConfig(): { client: Stripe | null; mode: 'test' | 'live' | 'unconfigured'; error?: string } {
  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) {
    return {
      client: null,
      mode: 'unconfigured',
      error: 'Stripe test mode is not configured yet. Add STRIPE_SECRET_KEY (sk_test_...) on the server to enable card payments.'
    };
  }

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction && secretKey.startsWith('sk_live_')) {
    return {
      client: null,
      mode: 'live',
      error: 'Live Stripe keys are blocked during development. Please configure a Stripe test secret key (sk_test_...).'
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
      error: 'Invalid STRIPE_SECRET_KEY format configured on the server.'
    };
  }

  const mode = secretKey.includes('_test_') ? 'test' : 'live';
  const client = new Stripe(secretKey);
  return { client, mode };
}

function evaluateAllPaymentMethods() {
  // 1. Touch 'n Go eWallet QR — evaluated independently from TNG_* environment variables
  const tngEval = evaluateQrMethod({
    key: 'tng',
    label: 'Touch ’n Go eWallet QR',
    shortAccountName: 'TNG (Touch ’n Go eWallet)',
    enabledVarName: 'TNG_ENABLED',
    recipientVarName: 'TNG_RECIPIENT_NAME',
    imageVarName: 'TNG_QR_IMAGE',
    enabledEnv: process.env.TNG_ENABLED,
    recipientEnv: process.env.TNG_RECIPIENT_NAME,
    imageEnv: process.env.TNG_QR_IMAGE
  });

  // 2. Public Bank QR Pay — evaluated independently from DUITNOW_* environment variables
  const duitnowEval = evaluateQrMethod({
    key: 'duitnow',
    label: 'Public Bank QR Pay',
    shortAccountName: 'Public Bank (QR Pay)',
    enabledVarName: 'DUITNOW_ENABLED',
    recipientVarName: 'DUITNOW_RECIPIENT_NAME',
    imageVarName: 'DUITNOW_QR_IMAGE',
    enabledEnv: process.env.DUITNOW_ENABLED,
    recipientEnv: process.env.DUITNOW_RECIPIENT_NAME,
    imageEnv: process.env.DUITNOW_QR_IMAGE
  });

  // 3. Credit or Debit Card (Stripe) — evaluated independently
  const stripeInfo = getStripeConfig();

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
        issue: stripeInfo.error
      }
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

function resolveTrustedOrigin(req: express.Request): string {
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
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const rawHost = forwardedHost || req.headers.host || 'localhost:3000';
  const safeHost = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost:3000';
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : (req.protocol === 'https' ? 'https' : 'http');
  return `${proto}://${safeHost}`;
}

function sanitizeDisplayFilename(raw: unknown, fallbackExt: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return `receipt.${fallbackExt}`;
  }
  const base = path.basename(raw.trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || `receipt.${fallbackExt}`;
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
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
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

      // Already confirmed paid — idempotent no-op
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
        order.stripePaymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
        order.paidAt = new Date().toISOString();
        order.lastCardAttemptMessage = undefined;
        ordersStore.set(reference, order);
        console.log(`Order ${reference} confirmed Paid via verified Stripe webhook (${event.id}).`);
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
        if (order.paymentStatus === 'Awaiting payment') {
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

  // Validate Delivery Endpoint
  app.post('/api/validate-delivery', (req, res) => {
    try {
      const { state } = req.body || {};
      if (typeof state !== 'string' || !state.trim()) {
        return res.status(400).json({ error: 'State is required.' });
      }

      const normalizedState = state.trim().toLowerCase();
      const deliveryConfig = DELIVERY_RATES[normalizedState];

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

      // Validate uploaded photo path stays strictly inside /uploads/
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

      const deliveryConfig = DELIVERY_RATES[cleanCustomer.state.toLowerCase()];
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

      const orderRecord: OrderRecord = {
        reference,
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

      return res.json({ success: true, reference, order: toPublicOrder(orderRecord) });
    } catch {
      return res.status(500).json({ error: 'Failed to create order.' });
    }
  });

  // Get Merchant Payment Configuration Endpoint (evaluates TNG, Public Bank QR Pay, and Stripe independently)
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

  // Upload Payment Receipt Endpoint (Manual QR — stores receipt PRIVATELY outside public/)
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

      // Ensure the chosen QR method is actually configured on the server (independent of Stripe)
      const { merchantConfig } = evaluateAllPaymentMethods();
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

  // Create Stripe Checkout Session Endpoint (MYR, server-side saved order total)
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
          error: stripeInfo.error || 'Card payment is temporarily unavailable. Please use a QR payment method or configure Stripe test mode.'
        });
      }

      const baseUrl = resolveTrustedOrigin(req);

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        {
          price_data: {
            currency: 'myr',
            product_data: {
              name: `Little Pixel Keepsakes — ${order.productName}`,
              description: order.savingsSen
                ? `Order ${order.reference} · Includes bundle savings of RM ${(order.savingsSen / 100).toFixed(2)}`
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
        success_url: `${baseUrl}/?order=${encodeURIComponent(order.reference)}&payment=success`,
        cancel_url: `${baseUrl}/?order=${encodeURIComponent(order.reference)}&payment=cancelled`,
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

  // Get Saved Order Details Endpoint
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
      return res.json({ success: true, order: toPublicOrder(order) });
    } catch {
      return res.status(500).json({ error: 'Failed to retrieve order.' });
    }
  });

  // =========================================================================
  // PROTECTED STAFF ADMIN AUTH & ORDER VERIFICATION ROUTES
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

  // Protected: List all orders & payment configuration diagnostics
  app.get('/api/admin/orders', requireAdminAuth, (_req, res) => {
    const orders = Array.from(ordersStore.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(toPublicOrder);
    const { diagnostics } = evaluateAllPaymentMethods();
    return res.json({ success: true, orders, diagnostics });
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

  // Protected: Staff confirms incoming TNG or Public Bank transfer and marks order Paid
  app.post('/api/admin/orders/:reference/verify-payment', requireAdminAuth, (req, res) => {
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
    order.verificationNote = note || `Verified incoming ${getPaymentMethodDisplayLabel(order.paymentMethod)} transfer.`;
    ordersStore.set(reference, order);
    saveStoreToDisk();

    return res.json({ success: true, order: toPublicOrder(order) });
  });

  // Protected: Staff rejects an unverified receipt so customer can re-submit
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
      return res.status(400).json({ error: 'Only orders pending verification can be returned for resubmission.' });
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 240)
        : 'We could not match your uploaded receipt. Please verify the recipient name and exact amount, then upload a clear receipt.';

    // Remove rejected receipt file from private storage
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

    order.paymentStatus = 'Awaiting payment';
    order.paymentMethod = null;
    order.lastCardAttemptMessage = reason;
    order.privateReceipt = undefined;
    order.transactionReference = undefined;
    order.verificationNote = reason;
    ordersStore.set(reference, order);
    saveStoreToDisk();

    return res.json({ success: true, order: toPublicOrder(order) });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use('/uploads', express.static(publicUploadsDir));
    app.use('/payments', express.static(publicPaymentsDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
