import type {
  DeliveryCountry,
  MarketPricingConfig,
  OrderCustomer,
  OrderPricingBreakdown,
  PaymentMethodKey,
  PortraitFrameConfig,
  SupportedCurrency
} from '../types/order';

export const SUPPORTED_COUNTRIES: readonly DeliveryCountry[] = ['MY', 'SG'] as const;
export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = ['MYR', 'SGD'] as const;

export const COUNTRY_CURRENCY_MAP: Record<DeliveryCountry, SupportedCurrency> = {
  MY: 'MYR',
  SG: 'SGD'
};

export const COUNTRY_LABELS: Record<DeliveryCountry, string> = {
  MY: 'Malaysia',
  SG: 'Singapore'
};

export const CURRENCY_NAMES: Record<SupportedCurrency, string> = {
  MYR: 'Malaysian Ringgit (MYR)',
  SGD: 'Singapore Dollars (SGD)'
};

export const COUNTRY_UPDATE_NOTICE =
  'Your order total has been updated based on your delivery country.';

export const MALAYSIAN_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'Kuala Lumpur',
  'Putrajaya',
  'Labuan'
] as const;

export const PENINSULAR_STATES = new Set([
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

export const EAST_MALAYSIA_STATES = new Set(['sabah', 'sarawak', 'labuan']);

export const BUNDLE_DISCOUNT_PERCENT = 20;

export const PORTRAIT_FRAME_PRODUCT_ID = 'portrait_frame' as const;
export const PORTRAIT_FRAME_DIMENSIONS = '20 cm x 17 cm';
export const PORTRAIT_FRAME_MAX_PERSONALISATION_LENGTH = 60;

export const DEFAULT_PORTRAIT_FRAME_CONFIG: PortraitFrameConfig = {
  priceMySen: 19990, // RM 199.90
  priceSgCents: 7990, // S$ 79.90
  deliveryPeninsularSen: 1200, // RM 12.00
  deliveryEastMalaysiaSen: 2000, // RM 20.00
  deliverySingaporeCents: 1200, // S$ 12.00
  deliveryDays: 14
};

export const DEFAULT_MARKET_PRODUCT_BASE_PRICES: Record<
  DeliveryCountry,
  { keychain: number; magnet: number; portrait_frame: number }
> = {
  MY: {
    keychain: 2990, // RM 29.90
    magnet: 3190, // RM 31.90
    portrait_frame: DEFAULT_PORTRAIT_FRAME_CONFIG.priceMySen // RM 199.90
  },
  SG: {
    keychain: 1290, // S$ 12.90
    magnet: 1390, // S$ 13.90
    portrait_frame: DEFAULT_PORTRAIT_FRAME_CONFIG.priceSgCents // S$ 79.90
  }
};

export function resolvePortraitFrameConfig(
  input?: Partial<PortraitFrameConfig> | null
): PortraitFrameConfig {
  const priceMySen =
    typeof input?.priceMySen === 'number' && Number.isInteger(input.priceMySen) && input.priceMySen >= 200
      ? input.priceMySen
      : DEFAULT_PORTRAIT_FRAME_CONFIG.priceMySen;
  const priceSgCents =
    typeof input?.priceSgCents === 'number' && Number.isInteger(input.priceSgCents) && input.priceSgCents >= 50
      ? input.priceSgCents
      : DEFAULT_PORTRAIT_FRAME_CONFIG.priceSgCents;
  const deliveryPeninsularSen =
    typeof input?.deliveryPeninsularSen === 'number' &&
    Number.isInteger(input.deliveryPeninsularSen) &&
    input.deliveryPeninsularSen >= 0
      ? input.deliveryPeninsularSen
      : DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryPeninsularSen;
  const deliveryEastMalaysiaSen =
    typeof input?.deliveryEastMalaysiaSen === 'number' &&
    Number.isInteger(input.deliveryEastMalaysiaSen) &&
    input.deliveryEastMalaysiaSen >= 0
      ? input.deliveryEastMalaysiaSen
      : DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryEastMalaysiaSen;
  const deliverySingaporeCents =
    input && 'deliverySingaporeCents' in input
      ? input.deliverySingaporeCents === null
        ? null
        : typeof input.deliverySingaporeCents === 'number' &&
            Number.isInteger(input.deliverySingaporeCents) &&
            input.deliverySingaporeCents >= 0
          ? input.deliverySingaporeCents
          : DEFAULT_PORTRAIT_FRAME_CONFIG.deliverySingaporeCents
      : DEFAULT_PORTRAIT_FRAME_CONFIG.deliverySingaporeCents;
  const deliveryDays =
    typeof input?.deliveryDays === 'number' &&
    Number.isInteger(input.deliveryDays) &&
    input.deliveryDays >= 1 &&
    input.deliveryDays <= 90
      ? input.deliveryDays
      : DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryDays;

  return {
    priceMySen,
    priceSgCents,
    deliveryPeninsularSen,
    deliveryEastMalaysiaSen,
    deliverySingaporeCents,
    deliveryDays
  };
}

export function sanitizePersonalisationText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PORTRAIT_FRAME_MAX_PERSONALISATION_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

export const STRIPE_MIN_AMOUNT_MINOR: Record<SupportedCurrency, number> = {
  MYR: 200, // RM 2.00
  SGD: 50 // S$ 0.50
};

export interface MarketCatalogItem {
  key:
    | 'keychain'
    | 'magnet'
    | 'bundle_2_keychains'
    | 'bundle_kc_magnet'
    | 'bundle_2_magnets'
    | 'portrait_frame';
  productId: 'keychain' | 'magnet' | 'bundle' | 'portrait_frame';
  bundleId?: 'bundle_2_keychains' | 'bundle_kc_magnet' | 'bundle_2_magnets';
  name: string;
  shortName: string;
  itemQuantity: number;
  priceMinor: number;
  regularMinor?: number;
  savingsMinor?: number;
}

export function buildMarketCatalog(
  country: DeliveryCountry,
  basePrices?: { keychain?: number; magnet?: number; portrait_frame?: number }
): Record<MarketCatalogItem['key'], MarketCatalogItem> {
  const defaults = DEFAULT_MARKET_PRODUCT_BASE_PRICES[country];
  const keychain =
    basePrices && typeof basePrices.keychain === 'number' && Number.isInteger(basePrices.keychain) && basePrices.keychain > 0
      ? basePrices.keychain
      : defaults.keychain;
  const magnet =
    basePrices && typeof basePrices.magnet === 'number' && Number.isInteger(basePrices.magnet) && basePrices.magnet > 0
      ? basePrices.magnet
      : defaults.magnet;
  const portraitFrame =
    basePrices &&
    typeof basePrices.portrait_frame === 'number' &&
    Number.isInteger(basePrices.portrait_frame) &&
    basePrices.portrait_frame > 0
      ? basePrices.portrait_frame
      : defaults.portrait_frame;

  const reg2Kc = keychain * 2;
  const disc2Kc = Math.round((reg2Kc * (100 - BUNDLE_DISCOUNT_PERCENT)) / 100);

  const regKcMag = keychain + magnet;
  const discKcMag = Math.round((regKcMag * (100 - BUNDLE_DISCOUNT_PERCENT)) / 100);

  const reg2Mag = magnet * 2;
  const disc2Mag = Math.round((reg2Mag * (100 - BUNDLE_DISCOUNT_PERCENT)) / 100);

  return {
    keychain: {
      key: 'keychain',
      productId: 'keychain',
      name: 'Keychain',
      shortName: 'Keychain',
      itemQuantity: 1,
      priceMinor: keychain
    },
    magnet: {
      key: 'magnet',
      productId: 'magnet',
      name: 'Fridge Magnet',
      shortName: 'Fridge Magnet',
      itemQuantity: 1,
      priceMinor: magnet
    },
    bundle_2_keychains: {
      key: 'bundle_2_keychains',
      productId: 'bundle',
      bundleId: 'bundle_2_keychains',
      name: '2-Piece Bundle (2 Keychains)',
      shortName: '2 Keychains',
      itemQuantity: 2,
      priceMinor: disc2Kc,
      regularMinor: reg2Kc,
      savingsMinor: reg2Kc - disc2Kc
    },
    bundle_kc_magnet: {
      key: 'bundle_kc_magnet',
      productId: 'bundle',
      bundleId: 'bundle_kc_magnet',
      name: '2-Piece Bundle (1 Keychain + 1 Fridge Magnet)',
      shortName: '1 Keychain + 1 Fridge Magnet',
      itemQuantity: 2,
      priceMinor: discKcMag,
      regularMinor: regKcMag,
      savingsMinor: regKcMag - discKcMag
    },
    bundle_2_magnets: {
      key: 'bundle_2_magnets',
      productId: 'bundle',
      bundleId: 'bundle_2_magnets',
      name: '2-Piece Bundle (2 Fridge Magnets)',
      shortName: '2 Fridge Magnets',
      itemQuantity: 2,
      priceMinor: disc2Mag,
      regularMinor: reg2Mag,
      savingsMinor: reg2Mag - disc2Mag
    },
    portrait_frame: {
      key: 'portrait_frame',
      productId: 'portrait_frame',
      name: 'Custom Perler Bead Portrait Frame (20 cm x 17 cm)',
      shortName: 'Custom Portrait Frame',
      itemQuantity: 1,
      priceMinor: portraitFrame
    }
  };
}

export function buildMarketPricingConfig(
  sgBasePrices?: {
    keychain: number;
    magnet: number;
  },
  portraitFrameConfig?: Partial<PortraitFrameConfig>
): MarketPricingConfig {
  const resolvedFrame = resolvePortraitFrameConfig(portraitFrameConfig);
  const myCatalog = buildMarketCatalog('MY', {
    ...DEFAULT_MARKET_PRODUCT_BASE_PRICES.MY,
    portrait_frame: resolvedFrame.priceMySen
  });
  const sgCatalog = buildMarketCatalog('SG', {
    ...(sgBasePrices || DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG),
    portrait_frame: resolvedFrame.priceSgCents
  });

  const toMarketEntry = (
    country: DeliveryCountry,
    catalog: Record<MarketCatalogItem['key'], MarketCatalogItem>
  ) => ({
    country,
    currency: COUNTRY_CURRENCY_MAP[country],
    products: {
      keychain: catalog.keychain.priceMinor,
      magnet: catalog.magnet.priceMinor,
      portrait_frame: catalog.portrait_frame.priceMinor
    },
    bundles: {
      bundle_2_keychains: {
        priceMinor: catalog.bundle_2_keychains.priceMinor,
        regularMinor: catalog.bundle_2_keychains.regularMinor!,
        savingsMinor: catalog.bundle_2_keychains.savingsMinor!
      },
      bundle_kc_magnet: {
        priceMinor: catalog.bundle_kc_magnet.priceMinor,
        regularMinor: catalog.bundle_kc_magnet.regularMinor!,
        savingsMinor: catalog.bundle_kc_magnet.savingsMinor!
      },
      bundle_2_magnets: {
        priceMinor: catalog.bundle_2_magnets.priceMinor,
        regularMinor: catalog.bundle_2_magnets.regularMinor!,
        savingsMinor: catalog.bundle_2_magnets.savingsMinor!
      }
    }
  });

  return {
    MY: toMarketEntry('MY', myCatalog),
    SG: toMarketEntry('SG', sgCatalog)
  };
}

export function formatCurrencyAmount(
  amountMinor: number,
  currency: SupportedCurrency = 'MYR'
): string {
  const safe = Number.isFinite(amountMinor) ? amountMinor : 0;
  const formatted = (safe / 100).toFixed(2);
  return currency === 'SGD' ? `S$ ${formatted}` : `RM ${formatted}`;
}

export function formatCurrencyWithCode(
  amountMinor: number,
  currency: SupportedCurrency = 'MYR'
): string {
  return `${formatCurrencyAmount(amountMinor, currency)} (${currency})`;
}

export function formatCountryLabel(country: DeliveryCountry): string {
  return `${COUNTRY_LABELS[country]} (${country})`;
}

export function normalizeDeliveryCountry(raw: unknown): DeliveryCountry | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed === 'MY' || trimmed === 'MALAYSIA') return 'MY';
  if (trimmed === 'SG' || trimmed === 'SINGAPORE') return 'SG';
  return null;
}

export function normalizeCurrency(raw: unknown): SupportedCurrency | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed === 'MYR' || trimmed === 'RM') return 'MYR';
  if (trimmed === 'SGD') return 'SGD';
  return null;
}

export function getCurrencyForCountry(country: DeliveryCountry): SupportedCurrency {
  return COUNTRY_CURRENCY_MAP[country];
}

export function getAllowedPaymentMethodsForCountry(
  country: DeliveryCountry
): PaymentMethodKey[] {
  return country === 'SG' ? ['card'] : ['tng', 'duitnow', 'card'];
}

export function validateCountryCurrencyPair(
  country: DeliveryCountry,
  submittedCurrency?: unknown
):
  | { valid: true; currency: SupportedCurrency }
  | { valid: false; code: 'UNSUPPORTED_CURRENCY' | 'COUNTRY_CURRENCY_MISMATCH'; error: string } {
  const expected = COUNTRY_CURRENCY_MAP[country];
  if (submittedCurrency === undefined || submittedCurrency === null || submittedCurrency === '') {
    return { valid: true, currency: expected };
  }
  const normalized = normalizeCurrency(submittedCurrency);
  if (!normalized) {
    return {
      valid: false,
      code: 'UNSUPPORTED_CURRENCY',
      error: `Unsupported currency. Supported currencies are MYR (Malaysia) and SGD (Singapore).`
    };
  }
  if (normalized !== expected) {
    return {
      valid: false,
      code: 'COUNTRY_CURRENCY_MISMATCH',
      error: `${COUNTRY_LABELS[country]} (${country}) delivery orders must be priced and paid in ${expected}, not ${normalized}.`
    };
  }
  return { valid: true, currency: expected };
}

export function validatePostalCodeForCountry(
  country: DeliveryCountry,
  postcode: string
): { valid: boolean; normalized: string; error?: string } {
  const cleaned = postcode.trim().replace(/\s+/g, '');
  if (country === 'MY') {
    if (!/^\d{5}$/.test(cleaned)) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'Malaysian postcodes must be exactly 5 digits (e.g. 47500 or 50450).'
      };
    }
    return { valid: true, normalized: cleaned };
  }
  if (!/^\d{6}$/.test(cleaned)) {
    return {
      valid: false,
      normalized: cleaned,
      error: 'Singapore postal codes must be exactly 6 digits (e.g. 238801).'
    };
  }
  return { valid: true, normalized: cleaned };
}

export function canonicalizeMalaysianState(state: string): string | null {
  const normalized = state.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'penang') return 'Pulau Pinang';
  const found = MALAYSIAN_STATES.find(s => s.toLowerCase() === normalized);
  return found ?? null;
}

export interface DeliveryAddressValidationResult {
  valid: boolean;
  code?: string;
  error?: string;
  normalized?: OrderCustomer;
}

export function validateCustomerDeliveryAddress(
  input: Partial<OrderCustomer> & { country?: unknown },
  options: { requireContactFields?: boolean } = { requireContactFields: true }
): DeliveryAddressValidationResult {
  const country = normalizeDeliveryCountry(input.country);
  if (!country) {
    return {
      valid: false,
      code: 'UNSUPPORTED_COUNTRY',
      error: 'Please select a supported delivery country: Malaysia (MY) or Singapore (SG).'
    };
  }

  const fullName = String(input.fullName || '').trim().slice(0, 120);
  const email = String(input.email || '').trim().slice(0, 160);
  const mobile = String(input.mobile || '').trim().slice(0, 40);
  const address = String(input.address || '').trim().slice(0, 300);
  const rawPostcode = String(input.postcode || '').trim().slice(0, 16);
  const rawCity = String(input.city || '').trim().slice(0, 80);
  const rawState = String(input.state || '').trim().slice(0, 60);

  if (options.requireContactFields !== false) {
    if (!fullName || fullName.length < 2) {
      return { valid: false, code: 'INVALID_FULL_NAME', error: 'Please enter the recipient full name.' };
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { valid: false, code: 'INVALID_EMAIL', error: 'Please enter a valid email address.' };
    }
    const phoneDigits = mobile.replace(/\D/g, '');
    if (!mobile || phoneDigits.length < 8 || phoneDigits.length > 16) {
      return {
        valid: false,
        code: 'INVALID_MOBILE',
        error: 'Please enter a valid mobile phone number (8–16 digits).'
      };
    }
    if (!address || address.length < 5) {
      return {
        valid: false,
        code: 'INVALID_ADDRESS',
        error:
          country === 'SG'
            ? 'Please enter your Singapore block, street name, and unit number.'
            : 'Please enter your complete street address.'
      };
    }
  }

  const postalCheck = validatePostalCodeForCountry(country, rawPostcode);
  if (!postalCheck.valid) {
    return {
      valid: false,
      code: 'INVALID_POSTCODE',
      error: postalCheck.error
    };
  }

  if (country === 'MY') {
    if (!rawCity || rawCity.length < 2) {
      return {
        valid: false,
        code: 'INVALID_CITY',
        error: 'Please enter your city for Malaysia delivery.'
      };
    }
    const canonicalState = canonicalizeMalaysianState(rawState);
    if (!canonicalState) {
      return {
        valid: false,
        code: 'INVALID_MY_STATE',
        error: 'Please select a valid Malaysian state.'
      };
    }
    return {
      valid: true,
      normalized: {
        fullName,
        email,
        mobile,
        address,
        postcode: postalCheck.normalized,
        city: rawCity,
        state: canonicalState,
        country: 'MY'
      }
    };
  }

  // Singapore (SG): city-state — reject Malaysian state values if spoofed
  if (rawState && rawState.toLowerCase() !== 'singapore') {
    if (canonicalizeMalaysianState(rawState)) {
      return {
        valid: false,
        code: 'INVALID_SG_ADDRESS',
        error: 'A Singapore delivery address cannot use a Malaysian state. Please check your delivery country.'
      };
    }
  }

  return {
    valid: true,
    normalized: {
      fullName,
      email,
      mobile,
      address,
      postcode: postalCheck.normalized,
      city: 'Singapore',
      state: 'Singapore',
      country: 'SG'
    }
  };
}

export interface DeliveryRateSettingsInput {
  peninsularSen: number;
  eastMalaysiaSen: number;
  singaporeCents: number | null;
}

export function resolveDeliveryZoneAndFee(params: {
  country: DeliveryCountry;
  state?: string;
  deliveryRates: DeliveryRateSettingsInput;
}):
  | {
      ok: true;
      country: DeliveryCountry;
      currency: SupportedCurrency;
      zone: string;
      deliveryFeeMinor: number;
    }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      error: string;
    } {
  if (params.country === 'MY') {
    const normalizedState = (params.state || '').trim().toLowerCase();
    if (PENINSULAR_STATES.has(normalizedState)) {
      return {
        ok: true,
        country: 'MY',
        currency: 'MYR',
        zone: 'Peninsular Malaysia',
        deliveryFeeMinor: params.deliveryRates.peninsularSen
      };
    }
    if (EAST_MALAYSIA_STATES.has(normalizedState)) {
      return {
        ok: true,
        country: 'MY',
        currency: 'MYR',
        zone: 'Sabah & Sarawak',
        deliveryFeeMinor: params.deliveryRates.eastMalaysiaSen
      };
    }
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_MY_STATE',
      error: 'Please select a valid Malaysian state for Malaysia delivery.'
    };
  }

  // Singapore (SG) — MUST have explicit configured shipping rate (never fall back to 0 or MYR rate!)
  const sgFee = params.deliveryRates.singaporeCents;
  if (typeof sgFee !== 'number' || !Number.isInteger(sgFee) || sgFee < 0) {
    return {
      ok: false,
      httpStatus: 503,
      code: 'SG_SHIPPING_NOT_CONFIGURED',
      error:
        'Singapore shipping is currently unavailable because Singapore delivery rates have not been configured yet. Please select Malaysia delivery or contact support.'
    };
  }

  return {
    ok: true,
    country: 'SG',
    currency: 'SGD',
    zone: 'Singapore',
    deliveryFeeMinor: sgFee
  };
}

export interface AuthoritativePricingResult {
  ok: true;
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  productKey: MarketCatalogItem['key'];
  productId: 'keychain' | 'magnet' | 'bundle' | 'portrait_frame';
  bundleId: string | null;
  productName: string;
  itemQuantity: number;
  subtotalMinor: number;
  regularSubtotalMinor: number | null;
  savingsMinor: number | null;
  deliveryZone: string;
  deliveryFeeMinor: number;
  totalMinor: number;
  deliveryDays: number;
  allowedPaymentMethods: PaymentMethodKey[];
  breakdown: OrderPricingBreakdown;
}

export interface AuthoritativePricingError {
  ok: false;
  httpStatus: number;
  code: string;
  error: string;
}

export function calculateAuthoritativeOrderPricing(params: {
  country: DeliveryCountry;
  productId: unknown;
  bundleId?: unknown;
  state?: string;
  deliveryRates: DeliveryRateSettingsInput;
  sgProductPricesCents?: { keychain: number; magnet: number };
  portraitFrameConfig?: Partial<PortraitFrameConfig> | null;
}): AuthoritativePricingResult | AuthoritativePricingError {
  const resolvedFrame = resolvePortraitFrameConfig(params.portraitFrameConfig);
  const catalog = buildMarketCatalog(
    params.country,
    params.country === 'SG'
      ? {
          ...(params.sgProductPricesCents || DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG),
          portrait_frame: resolvedFrame.priceSgCents
        }
      : {
          ...DEFAULT_MARKET_PRODUCT_BASE_PRICES.MY,
          portrait_frame: resolvedFrame.priceMySen
        }
  );

  const resolvedKey = params.productId === 'bundle' ? params.bundleId : params.productId;
  const item =
    typeof resolvedKey === 'string' && resolvedKey in catalog
      ? catalog[resolvedKey as MarketCatalogItem['key']]
      : undefined;

  if (!item || (params.productId === 'bundle' && item.productId !== 'bundle')) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_PRODUCT_SELECTION',
      error: 'Invalid product or bundle selection.'
    };
  }

  const isPortraitFrame = item.productId === PORTRAIT_FRAME_PRODUCT_ID;
  const effectiveDeliveryRates: DeliveryRateSettingsInput = isPortraitFrame
    ? {
        peninsularSen: resolvedFrame.deliveryPeninsularSen,
        eastMalaysiaSen: resolvedFrame.deliveryEastMalaysiaSen,
        singaporeCents: resolvedFrame.deliverySingaporeCents
      }
    : params.deliveryRates;

  const shipping = resolveDeliveryZoneAndFee({
    country: params.country,
    state: params.state,
    deliveryRates: effectiveDeliveryRates
  });
  if (!shipping.ok) {
    return shipping;
  }

  const currency = COUNTRY_CURRENCY_MAP[params.country];
  const subtotalMinor = item.priceMinor;
  const regularSubtotalMinor = item.regularMinor ?? null;
  const savingsMinor = item.savingsMinor ?? null;
  const deliveryFeeMinor = shipping.deliveryFeeMinor;
  const totalMinor = subtotalMinor + deliveryFeeMinor;
  const deliveryDays = isPortraitFrame ? resolvedFrame.deliveryDays : 14;

  const breakdown: OrderPricingBreakdown = {
    deliveryCountry: params.country,
    currency,
    productKey: item.key,
    productName: item.name,
    itemQuantity: item.itemQuantity,
    unitSubtotalMinor: subtotalMinor,
    regularSubtotalMinor,
    bundleDiscountPercent: savingsMinor ? BUNDLE_DISCOUNT_PERCENT : 0,
    bundleSavingsMinor: savingsMinor,
    deliveryZone: shipping.zone,
    deliveryFeeMinor,
    totalMinor,
    deliveryDays
  };

  return {
    ok: true,
    deliveryCountry: params.country,
    currency,
    productKey: item.key,
    productId: item.productId,
    bundleId: item.bundleId ?? null,
    productName: item.name,
    itemQuantity: item.itemQuantity,
    subtotalMinor,
    regularSubtotalMinor,
    savingsMinor,
    deliveryZone: shipping.zone,
    deliveryFeeMinor,
    totalMinor,
    deliveryDays,
    allowedPaymentMethods: getAllowedPaymentMethodsForCountry(params.country),
    breakdown
  };
}

export function verifySavedOrderPricingIntegrity(params: {
  order: {
    reference: string;
    product_id: string;
    bundle_id: string | null;
    subtotal_sen: number;
    regular_subtotal_sen: number | null;
    savings_sen: number | null;
    delivery_fee_sen: number;
    total_sen: number;
    customer_state: string;
    delivery_country?: string | null;
    currency?: string | null;
    pricing_breakdown?: OrderPricingBreakdown | null;
  };
  deliveryRates: DeliveryRateSettingsInput;
  sgProductPricesCents?: { keychain: number; magnet: number };
  portraitFrameConfig?: Partial<PortraitFrameConfig> | null;
}):
  | {
      valid: true;
      deliveryCountry: DeliveryCountry;
      currency: SupportedCurrency;
      expected: AuthoritativePricingResult;
    }
  | {
      valid: false;
      code: string;
      error: string;
      httpStatus: number;
    } {
  const { order } = params;
  const deliveryCountry = normalizeDeliveryCountry(order.delivery_country ?? 'MY');
  if (!deliveryCountry) {
    return {
      valid: false,
      code: 'UNSUPPORTED_COUNTRY',
      httpStatus: 400,
      error: 'Saved order has an unsupported delivery country.'
    };
  }

  const currencyPair = validateCountryCurrencyPair(deliveryCountry, order.currency ?? 'MYR');
  if (!currencyPair.valid) {
    return {
      valid: false,
      code: currencyPair.code,
      httpStatus: 400,
      error: currencyPair.error
    };
  }
  const currency = currencyPair.currency;

  const expected = calculateAuthoritativeOrderPricing({
    country: deliveryCountry,
    productId: order.product_id,
    bundleId: order.bundle_id,
    state: order.customer_state,
    deliveryRates: params.deliveryRates,
    sgProductPricesCents: params.sgProductPricesCents,
    portraitFrameConfig: params.portraitFrameConfig
  });

  if (!expected.ok) {
    return {
      valid: false,
      code: expected.code,
      httpStatus: expected.httpStatus,
      error: expected.error
    };
  }

  // Verify saved product subtotal, bundle discount, shipping, and total match authoritative pricing
  if (
    !Number.isInteger(order.subtotal_sen) ||
    !Number.isInteger(order.delivery_fee_sen) ||
    !Number.isInteger(order.total_sen) ||
    order.subtotal_sen < 0 ||
    order.delivery_fee_sen < 0 ||
    order.subtotal_sen + order.delivery_fee_sen !== order.total_sen
  ) {
    return {
      valid: false,
      code: 'INVALID_ORDER_AMOUNT',
      httpStatus: 400,
      error: 'Saved order pricing breakdown is inconsistent. Please review your delivery details and try again.'
    };
  }

  if (order.subtotal_sen !== expected.subtotalMinor) {
    return {
      valid: false,
      code: 'ORDER_PRICE_MISMATCH',
      httpStatus: 409,
      error: `Saved product price does not match authoritative ${COUNTRY_LABELS[deliveryCountry]} (${currency}) pricing. Please review your delivery details to refresh the order total.`
    };
  }

  const savedRegular = order.regular_subtotal_sen ?? null;
  const savedSavings = order.savings_sen ?? null;
  if (savedRegular !== expected.regularSubtotalMinor || savedSavings !== expected.savingsMinor) {
    return {
      valid: false,
      code: 'ORDER_DISCOUNT_MISMATCH',
      httpStatus: 409,
      error: `Saved bundle discount does not match authoritative ${COUNTRY_LABELS[deliveryCountry]} (${currency}) pricing.`
    };
  }

  if (order.delivery_fee_sen !== expected.deliveryFeeMinor) {
    return {
      valid: false,
      code: 'ORDER_SHIPPING_MISMATCH',
      httpStatus: 409,
      error: `Saved delivery fee does not match configured ${COUNTRY_LABELS[deliveryCountry]} (${currency}) shipping charges. Please review your delivery details to refresh the order total.`
    };
  }

  if (order.total_sen !== expected.totalMinor) {
    return {
      valid: false,
      code: 'ORDER_TOTAL_MISMATCH',
      httpStatus: 409,
      error: `Saved order total does not match authoritative ${COUNTRY_LABELS[deliveryCountry]} (${currency}) total.`
    };
  }

  const minAmount = STRIPE_MIN_AMOUNT_MINOR[currency];
  if (order.total_sen < minAmount) {
    return {
      valid: false,
      code: 'INVALID_ORDER_AMOUNT',
      httpStatus: 400,
      error: `Order total is below the minimum card payment amount for ${currency}.`
    };
  }

  return {
    valid: true,
    deliveryCountry,
    currency,
    expected
  };
}
