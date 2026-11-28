import crypto from 'crypto';
import type { DeliveryCountry, SupportedCurrency } from '../types/order';
import {
  buildMetaEcommerceParams,
  buildPurchaseEventId,
  isValidMetaPixelId,
  type MetaProductContentId
} from '../shared/metaTracking';

const META_GRAPH_API_VERSION = 'v21.0';
const META_COOKIE_REGEX = /^fb\.\d+\.\d+\.[A-Za-z0-9._-]{1,120}$/;

export interface MetaEnvConfig {
  pixelId: string | null;
  pixelConfigured: boolean;
  capiAccessToken: string | null;
  capiConfigured: boolean;
  testEventCode: string | null;
  testMode: boolean;
  issues: string[];
}

function stripQuotes(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Redacts Meta CAPI access tokens and secrets from any error message before logging or saving to DB.
 */
export function sanitizeMetaError(raw: unknown): string {
  const message =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message?: unknown }).message || '')
        : String(raw || 'Meta Conversions API request failed');
  return message
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[REDACTED]')
    .replace(/\bEAA[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_META_TOKEN]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export function getMetaEnvConfig(): MetaEnvConfig {
  const rawPixelId = stripQuotes(process.env.META_PIXEL_ID || '');
  const rawCapiToken = stripQuotes(process.env.META_CAPI_ACCESS_TOKEN || '');
  const rawTestCode = stripQuotes(process.env.META_TEST_EVENT_CODE || '');

  const issues: string[] = [];
  let pixelId: string | null = null;
  if (!rawPixelId) {
    issues.push('META_PIXEL_ID is not set.');
  } else if (!isValidMetaPixelId(rawPixelId)) {
    issues.push('META_PIXEL_ID must be a valid numeric Meta Pixel ID.');
  } else {
    pixelId = rawPixelId;
  }

  const capiAccessToken = rawCapiToken.length >= 20 ? rawCapiToken : null;
  if (!rawCapiToken) {
    issues.push('META_CAPI_ACCESS_TOKEN is not set on the server.');
  } else if (!capiAccessToken) {
    issues.push('META_CAPI_ACCESS_TOKEN appears too short to be a valid Meta Conversions API token.');
  }

  // Test event code is strictly optional and used only during testing/staging
  const testEventCode =
    rawTestCode && /^[A-Za-z0-9_-]{3,64}$/.test(rawTestCode) ? rawTestCode : null;

  return {
    pixelId,
    pixelConfigured: Boolean(pixelId),
    capiAccessToken,
    capiConfigured: Boolean(pixelId && capiAccessToken),
    testEventCode,
    testMode: Boolean(testEventCode),
    issues
  };
}

function sha256Hex(normalized: string): string {
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Meta CAPI email normalization: trim whitespace, lowercase, then SHA-256 hex.
 */
export function hashMetaEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return null;
  return sha256Hex(normalized);
}

/**
 * Meta CAPI phone normalization: strip non-digits, normalize local leading zero using
 * delivery country dial code (MY -> 60, SG -> 65), strip leading zeros, then SHA-256 hex.
 */
export function hashMetaPhone(
  phone: string | null | undefined,
  country: DeliveryCountry
): string | null {
  if (typeof phone !== 'string') return null;
  let digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    const dialCode = country === 'SG' ? '65' : '60';
    digits = `${dialCode}${digits.replace(/^0+/, '')}`;
  } else if (country === 'SG' && digits.length === 8 && /^[689]/.test(digits)) {
    digits = `65${digits}`;
  } else if (country === 'MY' && digits.length >= 9 && digits.length <= 10 && digits.startsWith('1')) {
    digits = `60${digits}`;
  }

  digits = digits.replace(/^0+/, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return sha256Hex(digits);
}

/**
 * Meta CAPI country normalization: 2-letter lowercase ISO-3166-1 alpha-2 hashed with SHA-256.
 */
export function hashMetaCountry(country: DeliveryCountry): string {
  return sha256Hex(country.toLowerCase());
}

export function sanitizeMetaCookie(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return META_COOKIE_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * Sanitizes an event_source_url so it NEVER leaks order access tokens, photo URLs,
 * receipts, or query parameters to Meta.
 */
export function sanitizeEventSourceUrl(rawUrl: unknown, fallbackOrigin: string): string {
  const tryParse = (candidate: string): string | null => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      // Strip all query params & fragments so ?order=...&token=... is NEVER transmitted to Meta
      return `${parsed.origin}${parsed.pathname || '/'}`;
    } catch {
      return null;
    }
  };

  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    const clean = tryParse(rawUrl.trim());
    if (clean) return clean;
  }
  return tryParse(fallbackOrigin) || 'https://localhost/';
}

export interface SendMetaPurchaseInput {
  orderReference: string;
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  productId: string;
  bundleId?: string | null;
  productName: string;
  itemQuantity: number;
  subtotalMinor: number;
  totalMinor: number;
  paidAtIso: string;
  customerEmail: string;
  customerPhone: string;
  fbp?: string | null;
  fbc?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  eventSourceUrl: string;
}

export interface MetaCapiSendResult {
  ok: boolean;
  eventId: string;
  eventTime: number;
  contentIds: MetaProductContentId[];
  numItems: number;
  testMode: boolean;
  eventsReceived?: number | null;
  fbtraceId?: string | null;
  error?: string;
  notConfigured?: boolean;
}

/**
 * Sends a single verified server-side Purchase event to Meta Conversions API (Graph API v21.0).
 * Never sends photos, receipts, access tokens, private storage URLs, or payment credentials.
 */
export async function sendMetaCapiPurchaseEvent(
  input: SendMetaPurchaseInput
): Promise<MetaCapiSendResult> {
  const cfg = getMetaEnvConfig();
  const eventId = buildPurchaseEventId(input.orderReference);
  const parsedPaidMs = Date.parse(input.paidAtIso);
  const eventTime = Math.floor((Number.isFinite(parsedPaidMs) ? parsedPaidMs : Date.now()) / 1000);

  const ecommerceParams = buildMetaEcommerceParams({
    productId: input.productId,
    bundleId: input.bundleId,
    productName: input.productName,
    itemQuantity: input.itemQuantity,
    valueMinor: input.totalMinor,
    itemPriceMinor: input.subtotalMinor,
    currency: input.currency,
    orderReference: input.orderReference
  });

  if (!cfg.capiConfigured || !cfg.pixelId || !cfg.capiAccessToken) {
    return {
      ok: false,
      notConfigured: true,
      eventId,
      eventTime,
      contentIds: ecommerceParams.content_ids,
      numItems: ecommerceParams.num_items,
      testMode: cfg.testMode,
      error: cfg.issues.join(' ') || 'META_PIXEL_ID and META_CAPI_ACCESS_TOKEN are required on the server.'
    };
  }

  const userData: Record<string, any> = {
    country: [hashMetaCountry(input.deliveryCountry)]
  };

  const hashedEmail = hashMetaEmail(input.customerEmail);
  if (hashedEmail) userData.em = [hashedEmail];

  const hashedPhone = hashMetaPhone(input.customerPhone, input.deliveryCountry);
  if (hashedPhone) userData.ph = [hashedPhone];

  const cleanFbp = sanitizeMetaCookie(input.fbp);
  if (cleanFbp) userData.fbp = cleanFbp;

  const cleanFbc = sanitizeMetaCookie(input.fbc);
  if (cleanFbc) userData.fbc = cleanFbc;

  if (typeof input.clientIpAddress === 'string' && input.clientIpAddress.trim()) {
    const cleanIp = input.clientIpAddress.trim().slice(0, 64);
    if (/^[0-9a-fA-F:.]+$/.test(cleanIp)) {
      userData.client_ip_address = cleanIp;
    }
  }
  if (typeof input.clientUserAgent === 'string' && input.clientUserAgent.trim()) {
    userData.client_user_agent = input.clientUserAgent.trim().slice(0, 400);
  }

  const eventPayload: Record<string, any> = {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    event_source_url: input.eventSourceUrl,
    user_data: userData,
    custom_data: {
      content_ids: ecommerceParams.content_ids,
      contents: ecommerceParams.contents,
      content_type: ecommerceParams.content_type,
      content_name: ecommerceParams.content_name,
      value: ecommerceParams.value,
      currency: ecommerceParams.currency,
      num_items: ecommerceParams.num_items,
      order_id: input.orderReference
    }
  };

  const requestBody: Record<string, any> = {
    data: [eventPayload],
    // Send token in POST body (never in URL query string) so it never leaks into HTTP logs
    access_token: cfg.capiAccessToken
  };

  if (cfg.testEventCode) {
    requestBody.test_event_code = cfg.testEventCode;
  }

  const endpoint = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(cfg.pixelId)}/events`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000)
    });

    const rawText = await response.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const apiMsg =
        parsed?.error?.error_user_msg ||
        parsed?.error?.message ||
        rawText ||
        response.statusText ||
        'Meta CAPI request failed';
      return {
        ok: false,
        eventId,
        eventTime,
        contentIds: ecommerceParams.content_ids,
        numItems: ecommerceParams.num_items,
        testMode: cfg.testMode,
        fbtraceId: typeof parsed?.error?.fbtrace_id === 'string' ? parsed.error.fbtrace_id : null,
        error: sanitizeMetaError(`Meta Graph HTTP ${response.status}: ${apiMsg}`)
      };
    }

    return {
      ok: true,
      eventId,
      eventTime,
      contentIds: ecommerceParams.content_ids,
      numItems: ecommerceParams.num_items,
      testMode: cfg.testMode,
      eventsReceived:
        typeof parsed?.events_received === 'number' ? parsed.events_received : 1,
      fbtraceId: typeof parsed?.fbtrace_id === 'string' ? parsed.fbtrace_id : null
    };
  } catch (err) {
    return {
      ok: false,
      eventId,
      eventTime,
      contentIds: ecommerceParams.content_ids,
      numItems: ecommerceParams.num_items,
      testMode: cfg.testMode,
      error: sanitizeMetaError(err)
    };
  }
}
