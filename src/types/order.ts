export const DELIVERY_PROMISE_TEXT =
  'Your order will be delivered within 14 days after your payment is confirmed and we receive a usable photo.';

export const PAID_CONFIRMATION_HEADING = 'Thank you! Your order is confirmed.';

export type PaymentStatus =
  | 'Awaiting payment'
  | 'Pending verification'
  | 'Receipt correction needed'
  | 'Paid';

export type PaymentMethodKey = 'tng' | 'duitnow' | 'card';

export interface OrderCustomer {
  fullName: string;
  email: string;
  mobile: string;
  address: string;
  postcode: string;
  city: string;
  state: string;
}

export interface OrderPublic {
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
  photoFileName?: string;
  customer: OrderCustomer;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethodKey | null;
  paymentMethodLabel?: string | null;
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
  createdAt: string;
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

export interface PublicStorefrontConfig {
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
  whatsappUrl: string | null;
  deliveryPromiseText: string;
}

export interface SupabaseHealthDiagnostic {
  configured: boolean;
  databaseReady: boolean;
  photosBucketReady: boolean;
  receiptsBucketReady: boolean;
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
  email: {
    configured: boolean;
    provider: 'resend' | 'none';
    fromAddress: string | null;
    issue?: string;
  };
  supabase: SupabaseHealthDiagnostic;
}
