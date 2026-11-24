export type PaymentStatus =
  | 'Awaiting payment'
  | 'Pending verification'
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
  lastCardAttemptMessage?: string;
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

export interface AdminConfigDiagnostics {
  tng: QrConfigDiagnostic;
  duitnow: QrConfigDiagnostic;
  stripe: {
    configured: boolean;
    mode: 'test' | 'live' | 'unconfigured';
    issue?: string;
  };
}
