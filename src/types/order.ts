export const DELIVERY_PROMISE_TEXT =
  'Your order will be delivered within 14 days after your payment is confirmed and we receive a usable photo.';

export const PORTRAIT_FRAME_DEFAULT_DELIVERY_DAYS = 14;

export function buildDeliveryPromiseText(days: number = 14, isPortraitFrame = false): string {
  const safeDays = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 14;
  return isPortraitFrame
    ? `Your custom portrait frame will be delivered within ${safeDays} days after your payment is confirmed and we receive a usable photo.`
    : `Your order will be delivered within ${safeDays} days after your payment is confirmed and we receive a usable photo.`;
}

export const PAID_CONFIRMATION_HEADING = 'Thank you! Your order is confirmed.';

export type PaymentStatus =
  | 'Awaiting payment'
  | 'Pending verification'
  | 'Receipt correction needed'
  | 'Paid';

export type PaymentMethodKey = 'tng' | 'duitnow' | 'card';

export type DeliveryCountry = 'MY' | 'SG';
export type SupportedCurrency = 'MYR' | 'SGD';

export interface OrderPricingBreakdown {
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  productKey: string;
  productName: string;
  itemQuantity: number;
  unitSubtotalMinor: number;
  regularSubtotalMinor: number | null;
  bundleDiscountPercent: number;
  bundleSavingsMinor: number | null;
  deliveryZone: string;
  deliveryFeeMinor: number;
  totalMinor: number;
  deliveryDays?: number;
}

export interface PortraitFrameConfig {
  priceMySen: number;
  priceSgCents: number;
  deliveryPeninsularSen: number;
  deliveryEastMalaysiaSen: number;
  deliverySingaporeCents: number | null;
  deliveryDays: number;
}

export interface MarketPriceTable {
  country: DeliveryCountry;
  currency: SupportedCurrency;
  products: {
    keychain: number;
    magnet: number;
    portrait_frame: number;
  };
  bundles: {
    bundle_2_keychains: { priceMinor: number; regularMinor: number; savingsMinor: number };
    bundle_kc_magnet: { priceMinor: number; regularMinor: number; savingsMinor: number };
    bundle_2_magnets: { priceMinor: number; regularMinor: number; savingsMinor: number };
  };
}

export interface MarketPricingConfig {
  MY: MarketPriceTable;
  SG: MarketPriceTable;
}

export interface OrderCustomer {
  fullName: string;
  email: string;
  mobile: string;
  address: string;
  postcode: string;
  city: string;
  state: string;
  country: DeliveryCountry;
}

export interface OrderPublic {
  reference: string;
  accessToken: string;
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  allowedPaymentMethods: PaymentMethodKey[];
  pricingBreakdown?: OrderPricingBreakdown;
  productId: string;
  bundleId?: string;
  productName: string;
  itemQuantity: number;
  subtotalSen: number;
  regularSubtotalSen?: number;
  savingsSen?: number;
  deliveryFeeSen: number;
  totalSen: number;
  personalisationText?: string;
  deliveryDays?: number;
  photoUrl: string;
  photoFileName?: string;
  customer: OrderCustomer;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethodKey | null;
  paymentMethodLabel?: string | null;
  latestPaymentCurrency?: SupportedCurrency | null;
  transactionReference?: string;
  receiptSubmitted: boolean;
  receiptFileName?: string;
  receiptMimeType?: 'image/jpeg' | 'image/png' | 'application/pdf';
  receiptUploadedAt?: string;
  paidAt?: string;
  verifiedByStaff?: boolean;
  verificationNote?: string;
  correctionReason?: string;
  lastCardAttemptMessage?: string;
  confirmationEmailStatus?: 'sent' | 'not_configured' | 'failed' | null;
  confirmationEmailSentAt?: string;
  confirmationEmailError?: string;
  confirmationEmailLastAttemptAt?: string;
  metaPurchaseStatus?: MetaConversionEventStatus | null;
  metaPurchaseEventId?: string;
  metaPurchaseSentAt?: string;
  metaPurchaseError?: string;
  metaPurchaseAttemptCount?: number;
  metaPurchaseTestMode?: boolean;
  createdAt: string;
}

export type MetaConversionEventStatus =
  | 'sent'
  | 'failed'
  | 'not_configured'
  | 'skipped_consent';

export interface PublicMetaTrackingConfig {
  pixelId: string | null;
  pixelConfigured: boolean;
  testMode: boolean;
}

export interface MetaConversionEventPublic {
  orderReference: string;
  eventName: string;
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
}

export interface MetaConnectionCheckResult {
  checkedAt: string;
  ok: boolean;
  status: 'connected' | 'error' | 'not_configured';
  datasetName?: string | null;
  message: string;
}

export interface MetaTrackingDiagnostic {
  pixelConfigured: boolean;
  pixelId: string | null;
  capiConfigured: boolean;
  capiConnectionStatus: 'connected' | 'configured' | 'error' | 'not_configured';
  capiConnectionMessage: string;
  testEventConfigured: boolean;
  testMode: boolean;
  schemaReady: boolean;
  lastSuccessAt: string | null;
  lastConnectionCheck?: MetaConnectionCheckResult | null;
  summary: {
    sent: number;
    failed: number;
    notConfigured: number;
    skippedConsent: number;
  };
  recentEvents: MetaConversionEventPublic[];
  issue?: string;
}

export interface QrMethodConfig {
  configured: boolean;
  key: 'tng' | 'duitnow';
  label: string;
  shortAccountName: string;
  recipientName: string;
  qrImage: string;
}

export interface QrConfigDiagnostic {
  key: 'tng' | 'duitnow';
  label: string;
  configured: boolean;
  enabled: boolean;
  issues: string[];
  recipientName: string | null;
  qrImage: string | null;
}

export interface MerchantPaymentConfig {
  tng: QrMethodConfig | null;
  duitnow: QrMethodConfig | null;
  stripe: {
    configured: boolean;
    mode: 'test' | 'live' | 'unconfigured';
  };
}

export interface StoreGalleryImage {
  id: string;
  category: string;
  title: string;
  description: string;
  image: string;
  tag: string;
}

export interface EditableStoreSettings {
  logoUrl: string;
  heroImageUrl: string;
  productImages: {
    keychain: string;
    magnet: string;
    bundle: string;
    portrait_frame: string;
  };
  galleryItems: StoreGalleryImage[];
  deliveryRatesSen: {
    peninsular: number;
    eastMalaysia: number;
  };
  deliveryRateSingaporeCents: number | null;
  sgProductPricesCents: {
    keychain: number;
    magnet: number;
  };
  portraitFrameConfig: PortraitFrameConfig;
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

export interface PublicStorefrontConfig {
  logoUrl: string;
  heroImageUrl: string;
  productImages: {
    keychain: string;
    magnet: string;
    bundle: string;
    portrait_frame: string;
  };
  galleryItems: StoreGalleryImage[];
  deliveryRatesSen: {
    peninsular: number;
    eastMalaysia: number;
  };
  deliveryRateSingaporeCents: number | null;
  singaporeShippingConfigured: boolean;
  marketPricing: MarketPricingConfig;
  portraitFrameConfig: PortraitFrameConfig & {
    singaporeShippingConfigured: boolean;
    deliveryPromiseText: string;
  };
  whatsappSupportNumber: string;
  whatsappUrl: string | null;
  deliveryPromiseText: string;
  metaTracking?: PublicMetaTrackingConfig;
}

export interface SupabaseHealthDiagnostic {
  configured: boolean;
  databaseReady: boolean;
  photosBucketReady: boolean;
  receiptsBucketReady: boolean;
  countryPricingSchemaReady?: boolean;
  metaConversionsSchemaReady?: boolean;
  portraitFrameSchemaReady?: boolean;
  photosBucket: string | null;
  receiptsBucket: string | null;
  issues: string[];
  issue?: string;
}

export interface StripeCheckoutDiagnostic {
  timestamp: string;
  stage: 'config' | 'order_lookup' | 'redirect_url' | 'stripe_api' | 'save_payment';
  code: string;
  mode: 'test' | 'live' | 'unconfigured';
  httpStatus: number;
  stripeType?: string;
  stripeCode?: string;
  originSource?: 'app_url' | 'request_headers' | 'fallback_localhost';
  message: string;
}

export interface AdminConfigDiagnostics {
  tng: QrConfigDiagnostic;
  duitnow: QrConfigDiagnostic;
  stripe: {
    configured: boolean;
    mode: 'test' | 'live' | 'unconfigured';
    webhookConfigured: boolean;
    livePaymentsEnabled: boolean;
    redirectOrigin?: string;
    redirectOriginSource?: 'app_url' | 'request_headers' | 'fallback_localhost';
    issue?: string;
    lastCheckoutError?: StripeCheckoutDiagnostic | null;
  };
  singaporeShipping: {
    configured: boolean;
    feeCents: number | null;
    source: 'settings' | 'env' | 'unconfigured';
    issue?: string;
  };
  email: {
    configured: boolean;
    provider: 'resend' | 'none';
    fromAddress: string | null;
    issue?: string;
  };
  metaTracking?: MetaTrackingDiagnostic;
  supabase: SupabaseHealthDiagnostic;
}
