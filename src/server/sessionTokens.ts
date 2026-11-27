import crypto from 'crypto';

// Process-level fallback signing key ONLY used if no persistent server secret env var is set in local dev.
const ephemeralFallbackKey = crypto.randomBytes(32);

function getSigningKey(): Buffer {
  const explicitSecret = (process.env.SESSION_SECRET || '').trim();
  if (explicitSecret.length >= 16) {
    return crypto.createHash('sha256').update(`lpk-session-v1:explicit:${explicitSecret}`).digest();
  }

  // Deterministic across all Netlify serverless instances sharing the same production env vars
  const supabaseSecret = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const adminPasscode = (process.env.ADMIN_PASSCODE || '').trim();
  const stripeSecret = (process.env.STRIPE_SECRET_KEY || '').trim();
  const compositeSeed = [supabaseSecret, adminPasscode, stripeSecret].filter(Boolean).join('|');

  if (compositeSeed.length > 0) {
    return crypto.createHash('sha256').update(`lpk-session-v1:env:${compositeSeed}`).digest();
  }

  return ephemeralFallbackKey;
}

export function computePasscodeVersion(secretMaterial: string): string {
  return crypto
    .createHmac('sha256', getSigningKey())
    .update(`pv:${secretMaterial}`)
    .digest('base64url')
    .slice(0, 16);
}

export interface PhotoSessionPayload {
  typ: 'photo_session';
  sid: string;
  iat: number;
  exp: number;
}

export interface PhotoIntentPayload {
  typ: 'photo_intent';
  sid: string;
  path: string;
  mime: 'image/jpeg' | 'image/png';
  name: string;
  prevPath?: string | null;
  iat: number;
  exp: number;
}

export interface PhotoVerifiedPayload {
  typ: 'photo_verified';
  sid: string;
  path: string;
  mime: 'image/jpeg' | 'image/png';
  name: string;
  size: number;
  iat: number;
  exp: number;
}

export interface ReceiptIntentPayload {
  typ: 'receipt_intent';
  ref: string;
  method: 'tng' | 'duitnow';
  path: string;
  mime: 'image/jpeg' | 'image/png' | 'application/pdf';
  name: string;
  iat: number;
  exp: number;
}

export interface AdminSessionPayload {
  typ: 'admin_session';
  sid: string;
  staffId: string | null;
  username: string;
  pv: string;
  iat: number;
  exp: number;
}

export type SignedTokenPayload =
  | PhotoSessionPayload
  | PhotoIntentPayload
  | PhotoVerifiedPayload
  | ReceiptIntentPayload
  | AdminSessionPayload;

export function signServerToken<T extends SignedTokenPayload>(payload: T): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningKey())
    .update(`v1.${encodedPayload}`)
    .digest('base64url');
  return `v1.${encodedPayload}.${sig}`;
}

export function verifyServerToken<T extends SignedTokenPayload>(
  token: string,
  expectedTypes: T['typ'] | readonly T['typ'][]
): T | null {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const [, encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSigningKey())
    .update(`v1.${encodedPayload}`)
    .digest('base64url');

  const bufProvided = Buffer.from(providedSig, 'utf-8');
  const bufExpected = Buffer.from(expectedSig, 'utf-8');
  if (bufProvided.length !== bufExpected.length || !crypto.timingSafeEqual(bufProvided, bufExpected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as SignedTokenPayload;
  const allowed = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
  if (!allowed.includes(candidate.typ as T['typ'])) return null;
  if (typeof candidate.exp !== 'number' || !Number.isFinite(candidate.exp) || candidate.exp < Date.now()) {
    return null;
  }

  return candidate as T;
}
