import {
  buildPurchaseEventId,
  isValidMetaPixelId,
  type MetaEcommerceParams,
  type MetaStandardEventName
} from '../shared/metaTracking';

export type MarketingConsentState = 'granted' | 'denied';

export interface BrowserMetaAttribution {
  fbp: string | null;
  fbc: string | null;
  eventSourceUrl: string;
  marketingConsent: boolean;
}

declare global {
  interface Window {
    fbq?: ((...args: any[]) => void) & {
      callMethod?: (...args: any[]) => void;
      queue?: any[];
      loaded?: boolean;
      version?: string;
      push?: (...args: any[]) => void;
    };
    _fbq?: any;
  }
}

const CONSENT_STORAGE_KEY = 'lpk_marketing_consent';
const FIRED_PURCHASES_STORAGE_KEY = 'lpk_meta_fired_purchases';
const META_COOKIE_REGEX = /^fb\.\d+\.\d+\.[A-Za-z0-9._-]{1,120}$/;

let initializedPixelId: string | null = null;
const firedPurchaseEventIdsInMemory = new Set<string>();

function isBrowserEnv(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Excludes Staff Admin and internal testing pages from all marketing tracking.
 */
export function isExcludedMarketingRoute(): boolean {
  if (!isBrowserEnv()) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'admin') return true;
    if (params.get('internal_test') === '1' || params.get('no_track') === '1') return true;
    const pathname = (window.location.pathname || '').toLowerCase();
    if (pathname.startsWith('/admin') || pathname.startsWith('/internal')) return true;
  } catch {
    return false;
  }
  return false;
}

export function hasBrowserPrivacyOptOut(): boolean {
  if (!isBrowserEnv()) return false;
  try {
    const nav = navigator as Navigator & {
      globalPrivacyControl?: boolean;
      msDoNotTrack?: string;
    };
    if (nav.globalPrivacyControl === true) return true;
    const dnt = nav.doNotTrack || (window as any).doNotTrack || nav.msDoNotTrack;
    if (dnt === '1' || dnt === 'yes') return true;
  } catch {
    // Ignore restricted navigator access
  }
  return false;
}

export function getSavedConsentPreference(): MarketingConsentState | null {
  if (!isBrowserEnv()) return null;
  try {
    const val = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (val === 'granted' || val === 'denied') return val;
  } catch {
    // Storage restricted
  }
  return null;
}

export function getEffectiveMarketingConsent(): MarketingConsentState {
  const saved = getSavedConsentPreference();
  if (saved) return saved;
  return hasBrowserPrivacyOptOut() ? 'denied' : 'granted';
}

export function setMarketingConsentPreference(state: MarketingConsentState): void {
  if (!isBrowserEnv()) return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, state);
  } catch {
    // Ignore storage errors
  }

  if (typeof window.fbq === 'function') {
    try {
      window.fbq('consent', state === 'granted' ? 'grant' : 'revoke');
    } catch {
      // Non-fatal
    }
  }
}

function readCookie(name: string): string | null {
  if (!isBrowserEnv()) return null;
  try {
    const prefix = `${name}=`;
    const parts = document.cookie.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        const value = decodeURIComponent(trimmed.slice(prefix.length)).trim();
        return value || null;
      }
    }
  } catch {
    // Ignore malformed cookies
  }
  return null;
}

function readSanitizedMetaCookie(name: '_fbp' | '_fbc'): string | null {
  const raw = readCookie(name);
  if (!raw) return null;
  return META_COOKIE_REGEX.test(raw) ? raw : null;
}

/**
 * Derives _fbc from URL fbclid parameter if cookie isn't set yet (per Meta CAPI spec:
 * fb.1.<creationTimeMs>.<fbclid>). Strictly sanitizes fbclid to safe characters.
 */
function deriveFbcFromUrl(): string | null {
  if (!isBrowserEnv()) return null;
  try {
    const fbclid = new URLSearchParams(window.location.search).get('fbclid')?.trim();
    if (!fbclid || !/^[A-Za-z0-9._-]{4,120}$/.test(fbclid)) return null;
    return `fb.1.${Date.now()}.${fbclid}`;
  } catch {
    return null;
  }
}

/**
 * Returns a clean event_source_url stripped of sensitive query params (such as order access tokens).
 */
export function getCleanEventSourceUrl(): string {
  if (!isBrowserEnv()) return '';
  try {
    return `${window.location.origin}${window.location.pathname || '/'}`;
  } catch {
    return '';
  }
}

export function collectBrowserMetaAttribution(): BrowserMetaAttribution {
  const consentGranted = getEffectiveMarketingConsent() === 'granted' && !isExcludedMarketingRoute();
  return {
    fbp: consentGranted ? readSanitizedMetaCookie('_fbp') : null,
    fbc: consentGranted ? readSanitizedMetaCookie('_fbc') || deriveFbcFromUrl() : null,
    eventSourceUrl: getCleanEventSourceUrl(),
    marketingConsent: consentGranted
  };
}

export function createMetaEventId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${randomPart}`;
}

/**
 * Loads Meta Pixel (fbevents.js) at most once and initializes it for the given numeric Pixel ID.
 * Prevents duplicate initialisation, respects consent, and strictly skips Staff Admin routes.
 */
export function initMetaPixel(pixelId: string | null | undefined): boolean {
  if (!isBrowserEnv()) return false;
  if (!isValidMetaPixelId(pixelId)) return false;
  if (isExcludedMarketingRoute()) return false;
  if (getEffectiveMarketingConsent() !== 'granted') return false;

  const cleanPixelId = pixelId!.trim();
  if (initializedPixelId === cleanPixelId) {
    return true;
  }

  // Install official Meta Pixel command queue shim once
  if (!window.fbq) {
    const fbqShim: any = function (...args: any[]) {
      if (fbqShim.callMethod) {
        fbqShim.callMethod.apply(fbqShim, args);
      } else {
        fbqShim.queue.push(args);
      }
    };
    if (!window._fbq) window._fbq = fbqShim;
    fbqShim.push = fbqShim;
    fbqShim.loaded = true;
    fbqShim.version = '2.0';
    fbqShim.queue = [];
    window.fbq = fbqShim;
  }

  if (!document.getElementById('meta-pixel-fbevents')) {
    const script = document.createElement('script');
    script.id = 'meta-pixel-fbevents';
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript?.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else {
      document.head.appendChild(script);
    }
  }

  try {
    const fbq = window.fbq;
    if (!fbq) return false;
    fbq('consent', 'grant');
    fbq('init', cleanPixelId);
    initializedPixelId = cleanPixelId;
    return true;
  } catch {
    return false;
  }
}

export function isMetaPixelReady(): boolean {
  return (
    isBrowserEnv() &&
    Boolean(initializedPixelId) &&
    typeof window.fbq === 'function' &&
    !isExcludedMarketingRoute() &&
    getEffectiveMarketingConsent() === 'granted'
  );
}

function dispatchStandardEvent(
  eventName: MetaStandardEventName,
  params?: Record<string, any>,
  eventId?: string
): string | null {
  if (!isMetaPixelReady()) return null;
  const resolvedEventId = eventId || createMetaEventId(eventName.toLowerCase());
  try {
    if (params) {
      window.fbq!('track', eventName, params, { eventID: resolvedEventId });
    } else {
      window.fbq!('track', eventName, {}, { eventID: resolvedEventId });
    }
    return resolvedEventId;
  } catch {
    return null;
  }
}

export function trackMetaPageView(eventId?: string): string | null {
  return dispatchStandardEvent('PageView', undefined, eventId || createMetaEventId('pv'));
}

export function trackMetaViewContent(params: MetaEcommerceParams, eventId?: string): string | null {
  return dispatchStandardEvent('ViewContent', params, eventId || createMetaEventId('vc'));
}

export function trackMetaAddToCart(params: MetaEcommerceParams, eventId?: string): string | null {
  return dispatchStandardEvent('AddToCart', params, eventId || createMetaEventId('atc'));
}

export function trackMetaInitiateCheckout(
  params: MetaEcommerceParams,
  eventId?: string
): string | null {
  return dispatchStandardEvent('InitiateCheckout', params, eventId || createMetaEventId('ic'));
}

export function trackMetaAddPaymentInfo(
  params: MetaEcommerceParams,
  eventId?: string
): string | null {
  return dispatchStandardEvent('AddPaymentInfo', params, eventId || createMetaEventId('api'));
}

function loadFiredPurchasesFromStorage(): Set<string> {
  const result = new Set<string>(firedPurchaseEventIdsInMemory);
  if (!isBrowserEnv()) return result;
  try {
    const raw = window.localStorage.getItem(FIRED_PURCHASES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id) result.add(id);
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return result;
}

function persistFiredPurchaseId(eventId: string): void {
  firedPurchaseEventIdsInMemory.add(eventId);
  if (!isBrowserEnv()) return;
  try {
    const all = Array.from(loadFiredPurchasesFromStorage()).slice(-100);
    window.localStorage.setItem(FIRED_PURCHASES_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Tracks a browser Purchase event ONLY for backend-confirmed Paid orders using the exact
 * deterministic event_id (`purchase_<ORDER_REF>`) shared with server-side Conversions API.
 * Prevents duplicate browser fires on payment page refreshes and customer revisits.
 */
export function trackMetaPurchaseOnce(
  orderReference: string,
  params: MetaEcommerceParams
): { fired: boolean; eventId: string } {
  const eventId = buildPurchaseEventId(orderReference);
  if (!isMetaPixelReady()) {
    return { fired: false, eventId };
  }

  const alreadyFired = loadFiredPurchasesFromStorage();
  if (alreadyFired.has(eventId)) {
    return { fired: false, eventId };
  }

  const dispatched = dispatchStandardEvent(
    'Purchase',
    {
      ...params,
      order_id: orderReference
    },
    eventId
  );

  if (dispatched) {
    persistFiredPurchaseId(eventId);
    return { fired: true, eventId };
  }
  return { fired: false, eventId };
}
