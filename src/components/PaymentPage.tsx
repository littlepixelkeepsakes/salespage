import React, { useState, useEffect, useMemo } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Download,
  Edit3,
  FileText,
  Globe,
  Link2,
  Lock,
  MessageCircle,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Upload
} from 'lucide-react';
import {
  DELIVERY_PROMISE_TEXT,
  PAID_CONFIRMATION_HEADING,
  type DeliveryCountry,
  type MerchantPaymentConfig,
  type OrderCustomer,
  type OrderPublic,
  type PaymentMethodKey,
  type SupportedCurrency
} from '../types/order';
import {
  COUNTRY_LABELS,
  COUNTRY_UPDATE_NOTICE,
  CURRENCY_NAMES,
  MALAYSIAN_STATES,
  formatCountryLabel,
  formatCurrencyAmount,
  formatCurrencyWithCode,
  getAllowedPaymentMethodsForCountry,
  getCurrencyForCountry,
  validateCustomerDeliveryAddress
} from '../shared/pricing';
import { buildMetaEcommerceParams } from '../shared/metaTracking';
import { trackMetaAddPaymentInfo, trackMetaPurchaseOnce } from '../lib/metaPixel';

interface PaymentPageProps {
  order: OrderPublic;
  merchantConfig: MerchantPaymentConfig | null;
  merchantConfigLoading: boolean;
  singaporeShippingConfigured?: boolean;
  whatsappUrl: string | null;
  returnNotice: 'success_pending' | 'cancelled' | 'failed' | null;
  excludeTracking?: boolean;
  onOrderUpdated: (updated: OrderPublic) => void;
  onRefreshOrder: () => Promise<OrderPublic | null>;
  onReturnHome: () => void;
}

const MAX_RECEIPT_SIZE_BYTES = 10 * 1024 * 1024;
const RECEIPT_UPLOAD_TIMEOUT_MS = 90_000;

const formatReceiptSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const resolveReceiptMimeType = (
  file: File
): 'image/jpeg' | 'image/png' | 'application/pdf' | null => {
  const type = (file.type || '').trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/png') return 'image/png';
  if (type === 'application/pdf') return 'application/pdf';
  const name = (file.name || '').trim().toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return null;
};

const isSafeHttpsUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

async function parseReceiptApiJson<T extends Record<string, any>>(
  res: Response,
  fallbackError: string
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  let rawText = '';
  try {
    rawText = await res.text();
  } catch {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: 'Connection interrupted while reading the server response. Please try again.'
    };
  }
  const trimmed = rawText.trim();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!trimmed) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: 'The server returned an empty response while processing your receipt. Please try again.'
    };
  }
  if (contentType.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(trimmed)) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: 'The server returned an unexpected response while processing your receipt. Please try again.'
    };
  }

  let parsed: T | null = null;
  try {
    parsed = JSON.parse(trimmed) as T;
  } catch {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: 'The server returned an incomplete response. Please check your connection and try again.'
    };
  }

  if (!res.ok) {
    const serverErr =
      parsed && typeof parsed.error === 'string' && parsed.error.trim()
        ? parsed.error.trim()
        : fallbackError;
    return { ok: false, status: res.status, data: parsed, error: serverErr };
  }

  return { ok: true, status: res.status, data: parsed, error: null };
}

function uploadReceiptBinaryWithProgress(params: {
  url: string;
  file: File;
  contentType: string;
  onProgress?: (percent: number) => void;
}): Promise<{ status: number; networkError?: 'network' | 'timeout' | 'aborted' }> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', params.url, true);
    xhr.timeout = RECEIPT_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', params.contentType);

    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0 && params.onProgress) {
        params.onProgress(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
      }
    };
    xhr.onload = () => resolve({ status: xhr.status });
    xhr.onerror = () => resolve({ status: 0, networkError: 'network' });
    xhr.ontimeout = () => resolve({ status: 0, networkError: 'timeout' });
    xhr.onabort = () => resolve({ status: 0, networkError: 'aborted' });
    xhr.send(params.file);
  });
}

const formatPaymentMethodLabel = (method?: PaymentMethodKey | null) => {
  if (method === 'tng') return 'Touch ’n Go eWallet QR';
  if (method === 'duitnow') return 'Public Bank QR Pay';
  if (method === 'card') return 'Credit or Debit Card (Stripe)';
  return 'Not selected';
};

export default function PaymentPage({
  order,
  merchantConfig,
  merchantConfigLoading,
  singaporeShippingConfigured = true,
  whatsappUrl,
  returnNotice,
  excludeTracking = false,
  onOrderUpdated,
  onRefreshOrder,
  onReturnHome
}: PaymentPageProps) {
  const orderCountry: DeliveryCountry = order.deliveryCountry || order.customer?.country || 'MY';
  const orderCurrency: SupportedCurrency = order.currency || getCurrencyForCountry(orderCountry);
  const allowedByCountry: PaymentMethodKey[] =
    order.allowedPaymentMethods && order.allowedPaymentMethods.length > 0
      ? order.allowedPaymentMethods
      : getAllowedPaymentMethodsForCountry(orderCountry);

  // Evaluate each payment option strictly within the country's allowed methods
  // Singapore (SG) -> Stripe card only. Malaysia (MY) -> TNG, Public Bank QR, Stripe card.
  const availableMethods = useMemo<PaymentMethodKey[]>(() => {
    const methods: PaymentMethodKey[] = [];
    if (orderCountry === 'MY') {
      if (allowedByCountry.includes('tng') && merchantConfig?.tng?.configured) {
        methods.push('tng');
      }
      if (allowedByCountry.includes('duitnow') && merchantConfig?.duitnow?.configured) {
        methods.push('duitnow');
      }
    }
    if (allowedByCountry.includes('card') && merchantConfig?.stripe?.configured) {
      methods.push('card');
    }
    return methods;
  }, [merchantConfig, orderCountry, allowedByCountry]);

  const [activeMethod, setActiveMethod] = useState<PaymentMethodKey | null>(() => {
    if (
      (returnNotice === 'cancelled' || returnNotice === 'failed') &&
      availableMethods.includes('card')
    ) {
      return 'card';
    }
    if (
      order.paymentStatus === 'Receipt correction needed' &&
      order.paymentMethod &&
      availableMethods.includes(order.paymentMethod)
    ) {
      return order.paymentMethod;
    }
    return availableMethods[0] ?? null;
  });
  const methodInitializedRef = React.useRef(false);
  const [copiedField, setCopiedField] = useState<'ref' | 'amount' | 'link' | null>(null);

  // Manual QR form state
  const [transactionRef, setTransactionRef] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptSubmitting, setReceiptSubmitting] = useState(false);
  const [receiptUploadProgress, setReceiptUploadProgress] = useState(0);
  const [receiptUploadStage, setReceiptUploadStage] = useState('');
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [qrImageFailed, setQrImageFailed] = useState<Record<string, boolean>>({});
  const [savingQr, setSavingQr] = useState(false);

  // Stripe card checkout state
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [stripeCheckoutUrl, setStripeCheckoutUrl] = useState<string | null>(null);

  // Delivery country/address update state (for unpaid orders before payment)
  const [editingDelivery, setEditingDelivery] = useState(false);
  const [deliveryDraft, setDeliveryDraft] = useState<OrderCustomer>({
    fullName: order.customer.fullName,
    email: order.customer.email,
    mobile: order.customer.mobile,
    address: order.customer.address,
    postcode: order.customer.postcode,
    city: order.customer.city,
    state: order.customer.state,
    country: orderCountry
  });
  const [updatingDelivery, setUpdatingDelivery] = useState(false);
  const [deliveryUpdateError, setDeliveryUpdateError] = useState<string | null>(null);
  const [countryUpdatedNotice, setCountryUpdatedNotice] = useState<string | null>(null);
  const [requiresReviewConfirmation, setRequiresReviewConfirmation] = useState(false);

  // Webhook confirmation polling when returning from Stripe ?payment=success
  const [waitingForWebhook, setWaitingForWebhook] = useState(
    returnNotice === 'success_pending' &&
      (order.paymentStatus === 'Awaiting payment' ||
        order.paymentStatus === 'Receipt correction needed')
  );
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [pollAttempts, setPollAttempts] = useState(0);

  // Keep draft synced when order updates externally
  useEffect(() => {
    setDeliveryDraft({
      fullName: order.customer.fullName,
      email: order.customer.email,
      mobile: order.customer.mobile,
      address: order.customer.address,
      postcode: order.customer.postcode,
      city: order.customer.city,
      state: order.customer.state,
      country: orderCountry
    });
  }, [
    order.reference,
    order.customer.fullName,
    order.customer.email,
    order.customer.mobile,
    order.customer.address,
    order.customer.postcode,
    order.customer.city,
    order.customer.state,
    orderCountry
  ]);

  // Initialize active method once merchantConfig finishes loading; keep user selection afterwards
  useEffect(() => {
    if (merchantConfigLoading) return;
    if (!methodInitializedRef.current) {
      methodInitializedRef.current = true;
      if (
        (returnNotice === 'cancelled' || returnNotice === 'failed') &&
        availableMethods.includes('card')
      ) {
        setActiveMethod('card');
        return;
      }
      if (
        order.paymentStatus === 'Receipt correction needed' &&
        order.paymentMethod &&
        availableMethods.includes(order.paymentMethod)
      ) {
        setActiveMethod(order.paymentMethod);
        return;
      }
      setActiveMethod(availableMethods[0] ?? null);
      return;
    }
    if (!activeMethod || !availableMethods.includes(activeMethod)) {
      setActiveMethod(availableMethods[0] ?? null);
    }
  }, [
    merchantConfigLoading,
    availableMethods,
    activeMethod,
    returnNotice,
    order.paymentStatus,
    order.paymentMethod
  ]);

  // Keep polling briefly if returning from Stripe Checkout while webhook completes
  useEffect(() => {
    if (
      order.paymentStatus !== 'Awaiting payment' &&
      order.paymentStatus !== 'Receipt correction needed'
    ) {
      setWaitingForWebhook(false);
      return;
    }
    if (!waitingForWebhook || pollAttempts >= 12) return;

    const timer = window.setTimeout(async () => {
      const latest = await onRefreshOrder();
      setPollAttempts(prev => prev + 1);
      if (latest && latest.paymentStatus === 'Paid') {
        setWaitingForWebhook(false);
      }
    }, 2500);

    return () => window.clearTimeout(timer);
  }, [waitingForWebhook, pollAttempts, order.paymentStatus, onRefreshOrder]);

  // Browser Meta Pixel Purchase event — strictly gated on backend-verified Paid status.
  // NEVER fires for Awaiting payment, Pending verification, Receipt correction needed, or Staff Admin previews.
  // Deduplicates with server-side Conversions API via exact matching event_id (`purchase_<REF>`),
  // and prevents duplicate fires across page refreshes and order link revisits.
  useEffect(() => {
    if (excludeTracking) return;
    if (order.paymentStatus !== 'Paid') return;
    trackMetaPurchaseOnce(
      order.reference,
      buildMetaEcommerceParams({
        productId: order.productId,
        bundleId: order.bundleId,
        productName: order.productName,
        itemQuantity: order.itemQuantity,
        valueMinor: order.totalSen,
        itemPriceMinor: order.subtotalSen,
        currency: orderCurrency,
        orderReference: order.reference
      })
    );
  }, [
    excludeTracking,
    order.paymentStatus,
    order.reference,
    order.productId,
    order.bundleId,
    order.productName,
    order.itemQuantity,
    order.totalSen,
    order.subtotalSen,
    orderCurrency
  ]);

  const secureOrderUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.accessToken)}`
      : `/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.accessToken)}`;

  const handleCopy = async (text: string, field: 'ref' | 'amount' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Clipboard API unavailable in restricted frame
    }
  };

  const handleSaveQrImage = async (methodKey: 'tng' | 'duitnow', imageUrl: string) => {
    const isSafeUrl = imageUrl.startsWith('/') || imageUrl.startsWith('https://');
    if (!isSafeUrl) return;
    setSavingQr(true);
    const filenamePrefix =
      methodKey === 'tng'
        ? 'LittlePixelKeepsakes-TouchNGo-QR'
        : 'LittlePixelKeepsakes-PublicBank-QR';
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const extension = blob.type.includes('svg')
        ? 'svg'
        : blob.type.includes('png')
          ? 'png'
          : 'jpg';
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${filenamePrefix}.${extension}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
    } catch {
      const link = document.createElement('a');
      link.href = imageUrl;
      link.download = `${filenamePrefix}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setSavingQr(false);
    }
  };

  const handleReceiptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    e.target.value = '';
    setReceiptError(null);
    if (!file) {
      setReceiptFile(null);
      return;
    }

    const mimeType = resolveReceiptMimeType(file);
    if (!mimeType) {
      setReceiptError('Please upload a JPG, PNG, or PDF receipt file.');
      setReceiptFile(null);
      return;
    }

    if (file.size <= 0) {
      setReceiptError('Selected receipt file appears to be empty. Please choose another file.');
      setReceiptFile(null);
      return;
    }

    if (file.size > MAX_RECEIPT_SIZE_BYTES) {
      setReceiptError('Receipt file must be smaller than 10 MB.');
      setReceiptFile(null);
      return;
    }

    setReceiptFile(file);
  };

  const canSubmitPayment =
    order.paymentStatus === 'Awaiting payment' ||
    order.paymentStatus === 'Receipt correction needed';

  const handleDraftCountryChange = (nextCountry: DeliveryCountry) => {
    setDeliveryUpdateError(null);
    setDeliveryDraft(prev => {
      if (nextCountry === 'SG') {
        return {
          ...prev,
          country: 'SG',
          postcode: prev.country === 'MY' ? '' : prev.postcode,
          city: 'Singapore',
          state: 'Singapore'
        };
      }
      return {
        ...prev,
        country: 'MY',
        postcode: prev.country === 'SG' ? '' : prev.postcode,
        city: prev.city === 'Singapore' ? '' : prev.city,
        state: prev.state && prev.state !== 'Singapore' ? prev.state : 'Selangor'
      };
    });
  };

  const handleSaveDeliveryUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitPayment) return;
    setDeliveryUpdateError(null);

    const validated = validateCustomerDeliveryAddress(deliveryDraft, {
      requireContactFields: true
    });
    if (!validated.valid || !validated.normalized) {
      setDeliveryUpdateError(validated.error || 'Please check your delivery address details.');
      return;
    }

    setUpdatingDelivery(true);
    try {
      const targetCurrency = getCurrencyForCountry(validated.normalized.country);
      const res = await fetch(`/api/orders/${encodeURIComponent(order.reference)}/delivery`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-order-token': order.accessToken
        },
        body: JSON.stringify({
          accessToken: order.accessToken,
          customer: validated.normalized,
          currency: targetCurrency
        })
      });

      const parsed = await parseReceiptApiJson<{
        success?: boolean;
        order?: OrderPublic;
        countryChanged?: boolean;
        totalChanged?: boolean;
        notice?: string | null;
        error?: string;
        code?: string;
      }>(res, 'Could not update delivery details.');

      if (parsed.ok && parsed.data?.success && parsed.data.order) {
        setStripeCheckoutUrl(null);
        setCardError(null);
        setReceiptError(null);
        setEditingDelivery(false);
        onOrderUpdated(parsed.data.order);
        if (parsed.data.countryChanged || parsed.data.totalChanged) {
          setCountryUpdatedNotice(parsed.data.notice || COUNTRY_UPDATE_NOTICE);
          setRequiresReviewConfirmation(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } else {
        setDeliveryUpdateError(parsed.error || 'Could not update delivery details.');
        if (parsed.status === 409) {
          await onRefreshOrder();
          setEditingDelivery(false);
        }
      }
    } catch {
      setDeliveryUpdateError('Network error while updating delivery details. Please try again.');
    } finally {
      setUpdatingDelivery(false);
    }
  };

  const handleManualQrSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitPayment || requiresReviewConfirmation) return;
    if (orderCountry !== 'MY') return;
    if (activeMethod !== 'tng' && activeMethod !== 'duitnow') return;

    const cleanRef = transactionRef.trim();
    if (cleanRef.length < 3) {
      setReceiptError('Please enter the transaction reference from your payment receipt.');
      return;
    }
    if (!receiptFile) {
      setReceiptError('Please upload a JPG, PNG, or PDF copy of your payment receipt.');
      return;
    }

    const mimeType = resolveReceiptMimeType(receiptFile);
    if (!mimeType) {
      setReceiptError('Please upload a JPG, PNG, or PDF receipt file.');
      return;
    }
    if (receiptFile.size <= 0 || receiptFile.size > MAX_RECEIPT_SIZE_BYTES) {
      setReceiptError('Receipt file must be smaller than 10 MB.');
      return;
    }

    setReceiptSubmitting(true);
    setReceiptError(null);
    setReceiptUploadProgress(8);
    setReceiptUploadStage('Authorising private receipt upload…');

    try {
      // Step 1: Request a scoped Supabase signed upload URL for the private payment-receipts bucket
      const urlRes = await fetch('/api/upload-receipt-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-order-token': order.accessToken
        },
        body: JSON.stringify({
          reference: order.reference,
          accessToken: order.accessToken,
          paymentMethod: activeMethod,
          filename: receiptFile.name,
          mimeType,
          sizeBytes: receiptFile.size
        })
      });

      const urlParsed = await parseReceiptApiJson<{
        success?: boolean;
        signedUploadUrl?: string;
        receiptStoragePath?: string;
        receiptUploadToken?: string;
        error?: string;
      }>(urlRes, 'Could not authorise secure receipt upload. Please try again.');

      if (
        !urlParsed.ok ||
        !urlParsed.data?.success ||
        !urlParsed.data.signedUploadUrl ||
        !urlParsed.data.receiptStoragePath ||
        !urlParsed.data.receiptUploadToken ||
        !isSafeHttpsUrl(urlParsed.data.signedUploadUrl)
      ) {
        setReceiptError(urlParsed.error || 'Could not authorise secure receipt upload. Please try again.');
        if (urlParsed.status === 409) {
          await onRefreshOrder();
        }
        return;
      }

      // Step 2: Upload original binary JPG, PNG, or PDF directly to private Supabase Storage
      setReceiptUploadStage('Uploading receipt directly to private storage…');
      setReceiptUploadProgress(15);

      const putResult = await uploadReceiptBinaryWithProgress({
        url: urlParsed.data.signedUploadUrl,
        file: receiptFile,
        contentType: mimeType,
        onProgress: pct => {
          setReceiptUploadProgress(Math.min(88, 15 + Math.round(pct * 0.73)));
        }
      });

      if (putResult.networkError === 'timeout') {
        setReceiptError('Receipt upload timed out. Please check your connection and try again.');
        return;
      }
      if (putResult.networkError) {
        setReceiptError('Network error while uploading your receipt. Please check your connection and try again.');
        return;
      }
      if (putResult.status < 200 || putResult.status >= 300) {
        setReceiptError('Direct storage upload was rejected. Please retry submitting your receipt.');
        return;
      }

      // Step 3: Verify uploaded receipt file server-side & save payment record
      setReceiptUploadStage('Verifying receipt and updating order…');
      setReceiptUploadProgress(93);

      const confirmRes = await fetch('/api/upload-receipt/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-order-token': order.accessToken
        },
        body: JSON.stringify({
          reference: order.reference,
          accessToken: order.accessToken,
          paymentMethod: activeMethod,
          transactionReference: cleanRef,
          receiptStoragePath: urlParsed.data.receiptStoragePath,
          receiptUploadToken: urlParsed.data.receiptUploadToken
        })
      });

      const confirmParsed = await parseReceiptApiJson<{
        success?: boolean;
        order?: OrderPublic;
        error?: string;
      }>(confirmRes, 'Could not verify your receipt. Please try again.');

      if (confirmParsed.ok && confirmParsed.data?.success && confirmParsed.data.order) {
        setReceiptUploadProgress(100);
        // Track standard AddPaymentInfo ONLY (never Purchase — QR orders require staff verification first)
        if (!excludeTracking) {
          const updated = confirmParsed.data.order;
          trackMetaAddPaymentInfo(
            buildMetaEcommerceParams({
              productId: updated.productId,
              bundleId: updated.bundleId,
              productName: updated.productName,
              itemQuantity: updated.itemQuantity,
              valueMinor: updated.totalSen,
              itemPriceMinor: updated.subtotalSen,
              currency: updated.currency || orderCurrency,
              orderReference: updated.reference
            })
          );
        }
        onOrderUpdated(confirmParsed.data.order);
        setTransactionRef('');
        setReceiptFile(null);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setReceiptError(confirmParsed.error || 'Could not verify your receipt. Please try again.');
        if (confirmParsed.status === 409) {
          await onRefreshOrder();
        }
      }
    } catch {
      setReceiptError('Connection error while uploading your receipt. Please try again.');
    } finally {
      setReceiptSubmitting(false);
      setReceiptUploadProgress(0);
      setReceiptUploadStage('');
    }
  };

  const handleStartStripeCheckout = async () => {
    if (!canSubmitPayment || requiresReviewConfirmation) return;
    setCardLoading(true);
    setCardError(null);
    setStripeCheckoutUrl(null);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 25_000);

    let res: Response;
    try {
      res = await fetch('/api/create-stripe-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-order-token': order.accessToken
        },
        body: JSON.stringify({
          reference: order.reference,
          accessToken: order.accessToken
        }),
        signal: controller.signal
      });
    } catch (err: any) {
      window.clearTimeout(timeoutId);
      if (err?.name === 'AbortError') {
        setCardError(
          'Connecting to Stripe Checkout timed out. Please try again or choose a QR payment method.'
        );
      } else {
        setCardError(
          'Unable to reach the payment server. Please check your internet connection and try again.'
        );
      }
      setCardLoading(false);
      return;
    } finally {
      window.clearTimeout(timeoutId);
    }

    let rawBody = '';
    try {
      rawBody = await res.text();
    } catch {
      setCardError(
        'Connection was interrupted while reading the checkout response. Please try again.'
      );
      setCardLoading(false);
      return;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    let data: { success?: boolean; url?: string; error?: string; code?: string } | null = null;

    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object') {
          data = parsed as { success?: boolean; url?: string; error?: string; code?: string };
        }
      } catch {
        data = null;
      }
    }

    if (!data) {
      const looksHtml = contentType.includes('text/html') || /^\s*</.test(rawBody);
      if (!res.ok) {
        setCardError(
          looksHtml
            ? `The payment service returned an unexpected server error (HTTP ${res.status}). Please try again or choose a QR payment method.`
            : `The payment server returned an invalid error response (HTTP ${res.status}). Please try again or choose a QR payment method.`
        );
      } else {
        setCardError(
          'Received an invalid response format from the payment server. Please try again or choose a QR payment method.'
        );
      }
      setCardLoading(false);
      return;
    }

    if (!res.ok) {
      setCardError(
        data.error ||
          `Unable to start Stripe Checkout (HTTP ${res.status}). Please retry or choose a QR payment method.`
      );
      setCardLoading(false);
      if (res.status === 409) {
        await onRefreshOrder();
      }
      return;
    }

    if (!data.success || typeof data.url !== 'string' || !data.url.trim()) {
      setCardError(
        data.error ||
          'The payment server did not return a valid Stripe Checkout link. Please try again or choose a QR payment method.'
      );
      setCardLoading(false);
      return;
    }

    let checkoutUrl: URL;
    try {
      checkoutUrl = new URL(data.url);
      if (checkoutUrl.protocol !== 'https:') {
        throw new Error('Checkout URL must use HTTPS.');
      }
    } catch {
      setCardError(
        'Received an invalid Stripe Checkout redirect link from the server. Please try again or choose a QR payment method.'
      );
      setCardLoading(false);
      return;
    }

    // Track standard AddPaymentInfo when Stripe Checkout session is created (never Purchase until webhook confirms Paid)
    if (!excludeTracking) {
      trackMetaAddPaymentInfo(
        buildMetaEcommerceParams({
          productId: order.productId,
          bundleId: order.bundleId,
          productName: order.productName,
          itemQuantity: order.itemQuantity,
          valueMinor: order.totalSen,
          itemPriceMinor: order.subtotalSen,
          currency: orderCurrency,
          orderReference: order.reference
        })
      );
    }

    const isEmbeddedFrame = (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })();

    if (isEmbeddedFrame) {
      setStripeCheckoutUrl(checkoutUrl.toString());
      setCardLoading(false);
      return;
    }

    try {
      window.location.assign(checkoutUrl.toString());
    } catch {
      setStripeCheckoutUrl(checkoutUrl.toString());
      setCardError(
        'Automatic redirect was blocked by your browser. Click the button below to continue to Stripe Checkout.'
      );
      setCardLoading(false);
    }
  };

  const handleManualStatusCheck = async () => {
    setCheckingStatus(true);
    try {
      const latest = await onRefreshOrder();
      if (latest && latest.paymentStatus === 'Paid') {
        setWaitingForWebhook(false);
      }
    } finally {
      setCheckingStatus(false);
    }
  };

  const activeQrConfig =
    activeMethod === 'tng'
      ? merchantConfig?.tng
      : activeMethod === 'duitnow'
        ? merchantConfig?.duitnow
        : null;

  const isPaid = order.paymentStatus === 'Paid';
  const isPendingVerification = order.paymentStatus === 'Pending verification';
  const isCorrectionNeeded = order.paymentStatus === 'Receipt correction needed';
  const isLocked = isPaid || isPendingVerification;

  return (
    <main className="py-10 sm:py-14 px-4 sm:px-8 max-w-6xl mx-auto">
      {/* Page Heading */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-[#14233C]/10 pb-6">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-[#14233C]/65">
            <span>Customer Order Status</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono font-semibold text-[#14233C]">{order.reference}</span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-bold ${
                isPaid
                  ? 'text-emerald-800'
                  : isPendingVerification
                    ? 'text-amber-800'
                    : isCorrectionNeeded
                      ? 'text-red-700'
                      : 'text-[#E05A40]'
              }`}
            >
              {order.paymentStatus}
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-[#14233C] [text-wrap:balance]">
            {isPaid
              ? PAID_CONFIRMATION_HEADING
              : isPendingVerification
                ? 'Pending Verification'
                : isCorrectionNeeded
                  ? 'Receipt Correction Needed'
                  : 'Complete Your Payment'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => handleCopy(secureOrderUrl, 'link')}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-[#14233C] bg-white border border-[#14233C]/15 rounded-xl hover:border-[#14233C]/35 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C]"
          >
            {copiedField === 'link' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-700" />
                <span>Order Link Copied</span>
              </>
            ) : (
              <>
                <Link2 className="w-3.5 h-3.5 text-[#14233C]/65" />
                <span>Copy Secure Order Link</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => handleCopy(order.reference, 'ref')}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-[#14233C] bg-white border border-[#14233C]/15 rounded-xl hover:border-[#14233C]/35 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C]"
          >
            {copiedField === 'ref' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-700" />
                <span>Reference Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-[#14233C]/65" />
                <span>Copy Reference</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 2-Column Balanced Checkout / Status Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* LEFT COLUMN: Saved Order Summary (5 cols) */}
        <aside className="lg:col-span-5 bg-white rounded-2xl border border-[#14233C]/12 p-6 sm:p-7 space-y-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold text-[#14233C]">Order Summary</h2>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14233C]">
              {isPaid && <CheckCircle2 className="w-4 h-4 text-emerald-700" />}
              {isPendingVerification && <Clock className="w-4 h-4 text-amber-700" />}
              {isCorrectionNeeded && <AlertCircle className="w-4 h-4 text-red-700" />}
              {!isLocked && !isCorrectionNeeded && <AlertCircle className="w-4 h-4 text-[#E05A40]" />}
              <span
                className={
                  isPaid
                    ? 'text-emerald-800'
                    : isPendingVerification
                      ? 'text-amber-800'
                      : isCorrectionNeeded
                        ? 'text-red-700'
                        : 'text-[#14233C]'
                }
              >
                {order.paymentStatus}
              </span>
            </span>
          </div>

          {/* Saved Keepsake Photo + Selected Item */}
          <div className="flex items-center gap-4 pt-5 border-t border-[#14233C]/10">
            <div className="w-20 h-20 rounded-xl overflow-hidden bg-[#FAF6EE] border border-[#14233C]/10 shrink-0 flex items-center justify-center">
              {order.photoUrl ? (
                <img
                  src={order.photoUrl}
                  alt="Uploaded keepsake photo"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-[11px] font-medium text-[#14233C]/50">Photo</span>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-bold text-[#14233C] leading-snug">
                {order.productName}
              </p>
              <p className="text-xs text-[#14233C]/65">
                Quantity: <span className="tabular-nums font-medium">{order.itemQuantity}</span>
                <span aria-hidden="true"> · </span>
                <span>Photo saved</span>
              </p>
              <p className="text-xs font-mono text-[#14233C]/60 truncate">
                Ref: {order.reference}
              </p>
            </div>
          </div>

          {/* Itemized Country-Based Pricing Breakdown */}
          <dl className="space-y-3 pt-5 border-t border-[#14233C]/10 text-sm">
            <div className="flex items-center justify-between gap-4 text-xs text-[#14233C]/70 pb-1">
              <dt className="inline-flex items-center gap-1.5 font-semibold text-[#14233C]">
                <Globe className="w-3.5 h-3.5 text-[#E05A40]" />
                <span>Delivery Country & Currency</span>
              </dt>
              <dd className="font-bold text-[#14233C]">
                {formatCountryLabel(orderCountry)} · {orderCurrency}
              </dd>
            </div>

            {order.regularSubtotalSen && order.savingsSen ? (
              <>
                <div className="flex items-center justify-between gap-4 text-[#14233C]/75">
                  <dt>Regular item total</dt>
                  <dd className="tabular-nums font-medium line-through text-[#14233C]/50">
                    {formatCurrencyAmount(order.regularSubtotalSen, orderCurrency)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-emerald-800 font-semibold">
                  <dt>Bundle savings (20% off)</dt>
                  <dd className="tabular-nums">
                    - {formatCurrencyAmount(order.savingsSen, orderCurrency)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-[#14233C]">
                  <dt className="font-medium">Bundle subtotal</dt>
                  <dd className="tabular-nums font-semibold">
                    {formatCurrencyAmount(order.subtotalSen, orderCurrency)}
                  </dd>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-4 text-[#14233C]">
                <dt className="font-medium">Item subtotal</dt>
                <dd className="tabular-nums font-semibold">
                  {formatCurrencyAmount(order.subtotalSen, orderCurrency)}
                </dd>
              </div>
            )}

            <div className="flex items-center justify-between gap-4 text-[#14233C]/75">
              <dt>
                Delivery fee ({orderCountry === 'SG' ? 'Singapore' : order.customer.state})
              </dt>
              <dd className="tabular-nums font-medium">
                {formatCurrencyAmount(order.deliveryFeeSen, orderCurrency)}
              </dd>
            </div>

            <div className="flex items-baseline justify-between gap-4 pt-4 border-t border-[#14233C]/12">
              <dt className="text-sm font-bold text-[#14233C]">
                {isPaid ? `Total Paid (${orderCurrency})` : `Exact Amount Due (${orderCurrency})`}
              </dt>
              <dd className="text-2xl font-extrabold tabular-nums text-[#E05A40]">
                {formatCurrencyAmount(order.totalSen, orderCurrency)}
              </dd>
            </div>
          </dl>

          {/* Delivery Details Summary + Unpaid Country/Address Editor */}
          <div className="pt-5 border-t border-[#14233C]/10 space-y-2 text-xs text-[#14233C]/75">
            <div className="flex items-center justify-between gap-2">
              <p className="font-bold text-[#14233C]">Delivery Recipient</p>
              {canSubmitPayment && !editingDelivery && (
                <button
                  type="button"
                  onClick={() => {
                    setDeliveryUpdateError(null);
                    setEditingDelivery(true);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-[#E05A40] hover:underline"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>Change Country / Address</span>
                </button>
              )}
            </div>

            {!editingDelivery ? (
              <div className="space-y-1">
                <p className="font-medium text-[#14233C]">{order.customer.fullName}</p>
                <p>
                  {order.customer.email} · {order.customer.mobile}
                </p>
                <p>
                  {order.customer.address}, {order.customer.postcode}{' '}
                  {orderCountry === 'SG'
                    ? 'Singapore'
                    : `${order.customer.city}, ${order.customer.state}, Malaysia`}
                </p>
                <p className="font-semibold text-[#14233C]">
                  Country: {formatCountryLabel(orderCountry)}
                </p>
                {isPaid && (
                  <p className="text-[11px] text-emerald-800 font-medium pt-1">
                    Delivery country, currency, and pricing are locked after payment confirmation.
                  </p>
                )}
              </div>
            ) : (
              <form
                onSubmit={handleSaveDeliveryUpdate}
                className="space-y-3 p-3.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/15"
              >
                <p className="text-[11px] font-bold text-[#14233C]">
                  Update Delivery Country or Address (Recalculates Total)
                </p>
                <div>
                  <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                    Delivery Country *
                  </label>
                  <select
                    required
                    value={deliveryDraft.country}
                    onChange={e => handleDraftCountryChange(e.target.value as DeliveryCountry)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs font-semibold text-[#14233C]"
                  >
                    <option value="MY">Malaysia (MY) — MYR</option>
                    <option value="SG">
                      Singapore (SG) — SGD (Stripe Card only)
                      {!singaporeShippingConfigured ? ' — Rate Not Configured' : ''}
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                    {deliveryDraft.country === 'SG'
                      ? 'Block, Street & Unit Number'
                      : 'Street Address'}
                  </label>
                  <textarea
                    required
                    rows={2}
                    value={deliveryDraft.address}
                    onChange={e => setDeliveryDraft({ ...deliveryDraft, address: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs text-[#14233C]"
                  />
                </div>

                {deliveryDraft.country === 'MY' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                        Postcode (5d)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="\d{5}"
                        maxLength={5}
                        required
                        value={deliveryDraft.postcode}
                        onChange={e =>
                          setDeliveryDraft({
                            ...deliveryDraft,
                            postcode: e.target.value.replace(/\D/g, '').slice(0, 5)
                          })
                        }
                        className="w-full px-2.5 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs font-mono text-[#14233C]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        required
                        value={deliveryDraft.city}
                        onChange={e =>
                          setDeliveryDraft({ ...deliveryDraft, city: e.target.value })
                        }
                        className="w-full px-2.5 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs text-[#14233C]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                        State
                      </label>
                      <select
                        required
                        value={deliveryDraft.state}
                        onChange={e =>
                          setDeliveryDraft({ ...deliveryDraft, state: e.target.value })
                        }
                        className="w-full px-2.5 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs text-[#14233C]"
                      >
                        {MALAYSIAN_STATES.map(st => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                        Postal Code (6 digits)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="\d{6}"
                        maxLength={6}
                        required
                        placeholder="238801"
                        value={deliveryDraft.postcode}
                        onChange={e =>
                          setDeliveryDraft({
                            ...deliveryDraft,
                            postcode: e.target.value.replace(/\D/g, '').slice(0, 6)
                          })
                        }
                        className="w-full px-2.5 py-2 rounded-lg bg-white border border-[#14233C]/20 text-xs font-mono text-[#14233C]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-[#14233C] mb-1">
                        Region
                      </label>
                      <input
                        type="text"
                        readOnly
                        value="Singapore"
                        className="w-full px-2.5 py-2 rounded-lg bg-[#FAF6EE] border border-[#14233C]/15 text-xs text-[#14233C]/75"
                      />
                    </div>
                  </div>
                )}

                {deliveryUpdateError && (
                  <p role="alert" className="text-[11px] font-bold text-red-700">
                    {deliveryUpdateError}
                  </p>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={updatingDelivery}
                    className="flex-1 py-2 px-3 rounded-lg bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] disabled:opacity-60"
                  >
                    {updatingDelivery ? 'Recalculating…' : 'Save & Recalculate Total'}
                  </button>
                  <button
                    type="button"
                    disabled={updatingDelivery}
                    onClick={() => {
                      setEditingDelivery(false);
                      setDeliveryUpdateError(null);
                    }}
                    className="px-3 py-2 rounded-lg border border-[#14233C]/20 bg-white text-xs font-semibold text-[#14233C]"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <p className="pt-2 text-[11px] font-medium text-[#14233C]/70">
              {DELIVERY_PROMISE_TEXT}
            </p>
          </div>

          {whatsappUrl && (
            <div className="pt-4 border-t border-[#14233C]/10">
              <a
                href={`${whatsappUrl}?text=${encodeURIComponent(`Hi Little Pixel Keepsakes, I have a question about order ${order.reference}.`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-xs font-bold text-emerald-800 hover:text-emerald-900 underline"
              >
                <MessageCircle className="w-4 h-4 shrink-0" />
                <span>Need help? Chat with us on WhatsApp</span>
              </a>
            </div>
          )}
        </aside>

        {/* RIGHT COLUMN: Payment Methods or Locked Status View (7 cols) */}
        <section className="lg:col-span-7 bg-white rounded-2xl border border-[#14233C]/12 p-6 sm:p-8 space-y-6">
          {/* STATE 1: PAID — Only shown when verified Paid by staff or Stripe webhook */}
          {isPaid && (
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-bold text-emerald-800">Status: Paid</p>
                  <h2 className="text-2xl font-extrabold text-[#14233C]">
                    {PAID_CONFIRMATION_HEADING}
                  </h2>
                  <p className="text-sm text-[#14233C]/80 leading-relaxed">
                    {DELIVERY_PROMISE_TEXT}
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-5 border-t border-[#14233C]/10 text-xs">
                <div>
                  <dt className="text-[#14233C]/60">Order Reference</dt>
                  <dd className="font-mono font-bold text-[#14233C] mt-0.5">{order.reference}</dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Items</dt>
                  <dd className="font-bold text-[#14233C] mt-0.5">
                    {order.productName} (Qty {order.itemQuantity})
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Delivery Country</dt>
                  <dd className="font-bold text-[#14233C] mt-0.5">
                    {formatCountryLabel(orderCountry)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Total Paid ({orderCurrency})</dt>
                  <dd className="font-extrabold tabular-nums text-emerald-800 text-sm mt-0.5">
                    {formatCurrencyWithCode(order.totalSen, orderCurrency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Payment Method</dt>
                  <dd className="font-bold text-[#14233C] mt-0.5">
                    {order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}
                  </dd>
                </div>
                {order.paidAt && (
                  <div>
                    <dt className="text-[#14233C]/60">Confirmed At</dt>
                    <dd className="font-medium text-[#14233C] mt-0.5">
                      {new Date(order.paidAt).toLocaleString()}
                    </dd>
                  </div>
                )}
                {order.confirmationEmailStatus === 'sent' && (
                  <div>
                    <dt className="text-[#14233C]/60">Confirmation Email</dt>
                    <dd className="font-medium text-emerald-800 mt-0.5">
                      Sent to {order.customer.email}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="pt-5 border-t border-[#14233C]/10 flex flex-wrap items-center justify-between gap-4">
                <p className="text-xs text-[#14233C]/65 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>Payment is complete. Additional payment sessions are disabled for this order.</span>
                </p>
                <button
                  type="button"
                  onClick={onReturnHome}
                  className="px-5 py-2.5 rounded-xl bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors whitespace-nowrap shrink-0"
                >
                  Back to Shop
                </button>
              </div>
            </div>
          )}

          {/* STATE 2: PENDING VERIFICATION — Show exact message and block second payment */}
          {isPendingVerification && (
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center shrink-0">
                  <Clock className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-bold text-amber-800">Status: Pending verification</p>
                  <h2 className="text-xl font-extrabold text-[#14233C]">
                    We’ve received your receipt. We’ll confirm your order once we verify your payment.
                  </h2>
                  <p className="text-sm text-[#14233C]/70 leading-relaxed">
                    Your receipt is stored privately and linked to order{' '}
                    <span className="font-mono font-semibold text-[#14233C]">
                      {order.reference}
                    </span>
                    . Our staff will verify your incoming transfer before marking the order paid.
                    Starting another payment is disabled while review is pending.
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-5 border-t border-[#14233C]/10 text-xs">
                <div>
                  <dt className="text-[#14233C]/60">Payment Method</dt>
                  <dd className="font-bold text-[#14233C] mt-0.5">
                    {order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Transaction Reference</dt>
                  <dd className="font-mono font-bold text-[#14233C] mt-0.5">
                    {order.transactionReference || 'Submitted'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Receipt File</dt>
                  <dd className="font-medium text-[#14233C] mt-0.5 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-[#14233C]/60 shrink-0" />
                    <span className="truncate">{order.receiptFileName || 'Stored privately'}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[#14233C]/60">Amount Submitted ({orderCurrency})</dt>
                  <dd className="font-bold tabular-nums text-[#14233C] mt-0.5">
                    {formatCurrencyWithCode(order.totalSen, orderCurrency)}
                  </dd>
                </div>
              </dl>

              <div className="pt-5 border-t border-[#14233C]/10 flex flex-wrap items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={handleManualStatusCheck}
                  disabled={checkingStatus}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingStatus ? 'animate-spin' : ''}`} />
                  <span>{checkingStatus ? 'Checking…' : 'Refresh Status'}</span>
                </button>
                <button
                  type="button"
                  onClick={onReturnHome}
                  className="px-5 py-2.5 rounded-xl bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors whitespace-nowrap shrink-0"
                >
                  Back to Shop
                </button>
              </div>
            </div>
          )}

          {/* STATE 3: RETURNING FROM STRIPE SUCCESS — Awaiting verified webhook confirmation */}
          {!isLocked && waitingForWebhook && (
            <div className="space-y-6 py-4">
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-sky-50 text-sky-700 flex items-center justify-center shrink-0">
                  <RefreshCw className="w-5 h-5 animate-spin" />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-xl font-extrabold text-[#14233C]">
                    Confirming your card payment…
                  </h2>
                  <p className="text-sm text-[#14233C]/75 leading-relaxed">
                    We only confirm card orders once Stripe sends a verified payment notification
                    matching your order reference, delivery country ({formatCountryLabel(orderCountry)}),
                    and exact {orderCurrency} total. This usually takes a few seconds.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleManualStatusCheck}
                  disabled={checkingStatus}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingStatus ? 'animate-spin' : ''}`} />
                  <span>{checkingStatus ? 'Checking…' : 'Check Payment Status'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setWaitingForWebhook(false)}
                  className="px-4 py-2.5 rounded-xl border border-[#14233C]/20 text-xs font-semibold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                >
                  Choose Another Method
                </button>
              </div>
            </div>
          )}

          {/* STATE 4: AWAITING PAYMENT OR RECEIPT CORRECTION NEEDED */}
          {!isLocked && !waitingForWebhook && (
            <div className="space-y-6">
              {/* Prominent alert when staff requested a corrected receipt */}
              {isCorrectionNeeded && (
                <div
                  role="alert"
                  className="flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200 text-red-950 text-xs leading-relaxed"
                >
                  <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-bold">Status: Receipt correction needed</p>
                    <p>
                      {order.correctionReason ||
                        'We could not verify your previous payment receipt. Please upload a clear replacement receipt below or choose another payment method.'}
                    </p>
                  </div>
                </div>
              )}

              {/* Inline notice when returning from cancelled/failed Stripe attempt */}
              {!isCorrectionNeeded &&
                (returnNotice === 'cancelled' ||
                  returnNotice === 'failed' ||
                  order.lastCardAttemptMessage) && (
                  <div
                    role="alert"
                    className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs leading-relaxed"
                  >
                    <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <p className="font-bold">Payment action needed</p>
                      <p>
                        {order.lastCardAttemptMessage ||
                          'Your saved order and uploaded photo are still linked to this reference. You can retry card checkout or switch to a QR payment below without uploading your photo again.'}
                      </p>
                    </div>
                  </div>
                )}

              {/* Required Review Confirmation Banner after Delivery Country Change */}
              {countryUpdatedNotice && (
                <div
                  role="alert"
                  className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs space-y-3"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-extrabold">{countryUpdatedNotice}</p>
                      <p className="leading-relaxed">
                        Updated total for{' '}
                        <strong>{formatCountryLabel(orderCountry)}</strong>:{' '}
                        <strong className="tabular-nums text-[#E05A40]">
                          {formatCurrencyWithCode(order.totalSen, orderCurrency)}
                        </strong>
                        . Any previous unpaid checkout session was invalidated automatically.
                      </p>
                    </div>
                  </div>
                  {requiresReviewConfirmation && (
                    <button
                      type="button"
                      onClick={() => setRequiresReviewConfirmation(false)}
                      className="w-full sm:w-auto px-4 py-2 rounded-lg bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors"
                    >
                      I’ve Reviewed the Updated Total — Continue to Payment
                    </button>
                  )}
                </div>
              )}

              {/* Select Payment Method — Filtered Strictly by Delivery Country */}
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-bold text-[#14233C]">Select Payment Method</h2>
                  <span className="text-[11px] font-semibold text-[#14233C]/65">
                    {orderCountry === 'SG'
                      ? 'Singapore (SGD) · Stripe Card Only'
                      : 'Malaysia (MYR)'}
                  </span>
                </div>

                {merchantConfigLoading ? (
                  <div className="py-6 text-xs text-[#14233C]/60">Loading available payment methods…</div>
                ) : availableMethods.length === 0 ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 p-4 rounded-xl bg-[#FAF6EE] border border-[#14233C]/15 text-xs text-[#14233C]/80 leading-relaxed"
                  >
                    <AlertCircle className="w-4 h-4 text-[#E05A40] shrink-0 mt-0.5" />
                    <p>
                      No payment methods are currently enabled for{' '}
                      <strong>{COUNTRY_LABELS[orderCountry]}</strong> checkout. Your order{' '}
                      <span className="font-mono font-bold text-[#14233C]">{order.reference}</span>{' '}
                      is saved — please contact the shop to complete payment.
                    </p>
                  </div>
                ) : (
                  <div
                    role="tablist"
                    aria-label="Select Payment Method"
                    className={`grid gap-2.5 ${
                      availableMethods.length === 3
                        ? 'grid-cols-1 sm:grid-cols-3'
                        : availableMethods.length === 2
                          ? 'grid-cols-1 sm:grid-cols-2'
                          : 'grid-cols-1'
                    }`}
                  >
                    {availableMethods.includes('tng') && merchantConfig?.tng?.configured && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeMethod === 'tng'}
                        onClick={() => {
                          setActiveMethod('tng');
                          setReceiptError(null);
                          setCardError(null);
                        }}
                        className={`px-3.5 py-3 rounded-xl border text-left transition-colors flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C] ${
                          activeMethod === 'tng'
                            ? 'bg-[#14233C] text-white border-[#14233C]'
                            : 'bg-[#FAF6EE]/60 text-[#14233C] border-[#14233C]/15 hover:border-[#14233C]/40'
                        }`}
                      >
                        <QrCode className="w-4 h-4 shrink-0" />
                        <span className="text-xs font-bold leading-snug">
                          Touch ’n Go eWallet QR
                        </span>
                      </button>
                    )}

                    {availableMethods.includes('duitnow') && merchantConfig?.duitnow?.configured && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeMethod === 'duitnow'}
                        onClick={() => {
                          setActiveMethod('duitnow');
                          setReceiptError(null);
                          setCardError(null);
                        }}
                        className={`px-3.5 py-3 rounded-xl border text-left transition-colors flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C] ${
                          activeMethod === 'duitnow'
                            ? 'bg-[#14233C] text-white border-[#14233C]'
                            : 'bg-[#FAF6EE]/60 text-[#14233C] border-[#14233C]/15 hover:border-[#14233C]/40'
                        }`}
                      >
                        <QrCode className="w-4 h-4 shrink-0" />
                        <span className="text-xs font-bold leading-snug">
                          Public Bank QR Pay
                        </span>
                      </button>
                    )}

                    {availableMethods.includes('card') && merchantConfig?.stripe?.configured && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeMethod === 'card'}
                        onClick={() => {
                          setActiveMethod('card');
                          setReceiptError(null);
                          setCardError(null);
                        }}
                        className={`px-3.5 py-3 rounded-xl border text-left transition-colors flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C] ${
                          activeMethod === 'card'
                            ? 'bg-[#14233C] text-white border-[#14233C]'
                            : 'bg-[#FAF6EE]/60 text-[#14233C] border-[#14233C]/15 hover:border-[#14233C]/40'
                        }`}
                      >
                        <CreditCard className="w-4 h-4 shrink-0" />
                        <span className="text-xs font-bold leading-snug">
                          Credit or Debit Card ({orderCurrency})
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* MANUAL QR PANEL — Malaysia (MYR) ONLY */}
              {orderCountry === 'MY' &&
                (activeMethod === 'tng' || activeMethod === 'duitnow') &&
                activeQrConfig && (
                <div key={activeMethod} role="tabpanel" className="pt-5 border-t border-[#14233C]/10 space-y-6">
                  {/* QR + Merchant Transfer Details */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                    <div className="md:col-span-5 flex flex-col items-center gap-3">
                      <div className="w-full max-w-[260px] aspect-[3/4] rounded-xl border border-[#14233C]/15 bg-white p-2 flex items-center justify-center overflow-hidden">
                        {!qrImageFailed[activeMethod] ? (
                          <img
                            key={activeQrConfig.qrImage}
                            src={activeQrConfig.qrImage}
                            alt={`${activeQrConfig.label} merchant QR code for ${activeQrConfig.recipientName}`}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setQrImageFailed(prev => ({ ...prev, [activeMethod]: true }))
                            }
                            className="w-full h-full object-contain rounded-lg"
                          />
                        ) : (
                          <div className="text-center p-4 space-y-2 text-[#14233C]/70">
                            <QrCode className="w-10 h-10 mx-auto" />
                            <p className="text-xs font-semibold">{activeQrConfig.label}</p>
                            <p className="text-[11px]">{activeQrConfig.recipientName}</p>
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={savingQr}
                        onClick={() => handleSaveQrImage(activeMethod, activeQrConfig.qrImage)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14233C]"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>{savingQr ? 'Saving…' : 'Save QR Image'}</span>
                      </button>
                    </div>

                    <div className="md:col-span-7 space-y-4">
                      <div>
                        <h3 className="text-base font-extrabold text-[#14233C]">
                          {activeQrConfig.label}
                        </h3>
                        <p className="text-xs text-[#14233C]/70 mt-1">
                          Follow these steps to complete your {activeQrConfig.label} transfer:
                        </p>
                      </div>

                      <ol className="space-y-2 text-xs text-[#14233C]/85 list-decimal list-inside">
                        <li>
                          Verify the recipient name matches{' '}
                          <strong className="text-[#14233C]">{activeQrConfig.recipientName}</strong>.
                        </li>
                        <li>
                          Pay the exact saved order total of{' '}
                          <strong className="tabular-nums text-[#E05A40]">
                            {formatCurrencyWithCode(order.totalSen, orderCurrency)}
                          </strong>
                          .
                        </li>
                        <li>Enter your transaction reference number below.</li>
                        <li>Upload your JPG, PNG, or PDF payment receipt for verification.</li>
                      </ol>

                      <dl className="pt-4 border-t border-[#14233C]/10 space-y-2.5 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[#14233C]/65">Payment Option</dt>
                          <dd className="font-semibold text-[#14233C] text-right">
                            {activeQrConfig.label}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[#14233C]/65">Recipient Name</dt>
                          <dd className="font-bold text-[#14233C] text-right">
                            {activeQrConfig.recipientName}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[#14233C]/65">Exact Order Total ({orderCurrency})</dt>
                          <dd className="flex items-center gap-2">
                            <span className="font-extrabold text-base tabular-nums text-[#E05A40]">
                              {formatCurrencyAmount(order.totalSen, orderCurrency)}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                handleCopy((order.totalSen / 100).toFixed(2), 'amount')
                              }
                              className="text-[11px] font-semibold text-[#14233C]/70 hover:text-[#14233C] underline"
                            >
                              {copiedField === 'amount' ? 'Copied' : 'Copy'}
                            </button>
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>

                  {/* Receipt Submission Form */}
                  <form
                    onSubmit={handleManualQrSubmit}
                    className="pt-6 border-t border-[#14233C]/10 space-y-4"
                  >
                    <h4 className="text-sm font-bold text-[#14233C]">
                      {isCorrectionNeeded
                        ? `Upload Replacement ${activeQrConfig.label} Receipt`
                        : `Submit ${activeQrConfig.label} Receipt`}
                    </h4>

                    <div>
                      <label
                        htmlFor="tx-ref-input"
                        className="block text-xs font-semibold text-[#14233C] mb-1.5"
                      >
                        Transaction Reference
                      </label>
                      <input
                        id="tx-ref-input"
                        type="text"
                        required
                        minLength={3}
                        maxLength={100}
                        placeholder="Enter the reference ID shown on your transfer receipt"
                        value={transactionRef}
                        onChange={e => setTransactionRef(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] placeholder:text-[#14233C]/40 focus:outline-none focus:border-[#14233C]"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="receipt-file-input"
                        className="block text-xs font-semibold text-[#14233C] mb-1.5"
                      >
                        Payment Receipt (JPG, PNG, or PDF · max 10 MB)
                      </label>
                      <label
                        htmlFor="receipt-file-input"
                        className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-dashed border-[#14233C]/30 bg-[#FAF6EE]/60 hover:bg-[#FAF6EE] cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Upload className="w-4 h-4 text-[#E05A40] shrink-0" />
                          <span className="text-xs font-medium text-[#14233C] truncate">
                            {receiptFile
                              ? `${receiptFile.name} (${formatReceiptSize(receiptFile.size)})`
                              : 'Choose JPG, PNG, or PDF receipt file'}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-[#14233C] underline whitespace-nowrap shrink-0">
                          {receiptFile ? 'Change' : 'Browse'}
                        </span>
                        <input
                          id="receipt-file-input"
                          type="file"
                          accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                          onChange={handleReceiptFileChange}
                          className="sr-only"
                        />
                      </label>
                      <p className="text-[11px] text-[#14233C]/60 mt-1.5">
                        Your receipt is uploaded directly to private storage and linked to order{' '}
                        {order.reference} under {activeQrConfig.label}.
                      </p>
                    </div>

                    {receiptSubmitting && (
                      <div className="p-3.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/15 space-y-2">
                        <div className="flex items-center justify-between text-xs font-semibold text-[#14233C]">
                          <span>{receiptUploadStage || 'Uploading receipt securely…'}</span>
                          <span className="tabular-nums">{receiptUploadProgress}%</span>
                        </div>
                        <progress
                          value={receiptUploadProgress}
                          max={100}
                          aria-label="Receipt upload progress"
                          className="w-full h-2 rounded-full overflow-hidden accent-[#14233C]"
                        />
                      </div>
                    )}

                    {receiptError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-800"
                      >
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{receiptError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={receiptSubmitting || requiresReviewConfirmation}
                      className="w-full py-3.5 px-6 rounded-xl bg-[#14233C] text-white font-bold text-sm hover:bg-[#1e3357] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      {receiptSubmitting
                        ? `Uploading receipt (${receiptUploadProgress}%)…`
                        : requiresReviewConfirmation
                          ? 'Please Review Updated Total Above First'
                          : isCorrectionNeeded
                            ? `Upload Replacement ${activeQrConfig.label} Receipt`
                            : `Submit ${activeQrConfig.label} Receipt`}
                    </button>
                  </form>
                </div>
              )}

              {/* CARD PAYMENT PANEL (Stripe Checkout) */}
              {activeMethod === 'card' && merchantConfig?.stripe?.configured && (
                <div role="tabpanel" className="pt-5 border-t border-[#14233C]/10 space-y-5">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-base font-extrabold text-[#14233C]">
                        Credit or Debit Card — Stripe Checkout
                      </h3>
                      {merchantConfig.stripe.mode === 'test' && (
                        <span className="text-xs font-semibold text-[#14233C]/65">
                          Stripe Test Mode
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#14233C]/75 leading-relaxed">
                      You will be redirected to Stripe’s secure hosted checkout to pay{' '}
                      <strong className="tabular-nums text-[#14233C]">
                        {formatCurrencyAmount(order.totalSen, orderCurrency)}
                      </strong>{' '}
                      in <strong>{CURRENCY_NAMES[orderCurrency]}</strong> for{' '}
                      <strong>{formatCountryLabel(orderCountry)}</strong> delivery. Your order is
                      confirmed automatically once Stripe verifies the payment.
                    </p>
                  </div>

                  {cardError && (
                    <div
                      role="alert"
                      className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-800"
                    >
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{cardError}</span>
                    </div>
                  )}

                  {stripeCheckoutUrl && !requiresReviewConfirmation ? (
                    <div className="space-y-2.5">
                      <a
                        href={stripeCheckoutUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-3.5 px-6 rounded-xl bg-[#FF8D76] text-[#14233C] font-extrabold text-sm hover:bg-[#ff7b60] transition-colors flex items-center justify-center gap-2"
                      >
                        <CreditCard className="w-4 h-4" />
                        <span>
                          Continue to Stripe Checkout (
                          {formatCurrencyWithCode(order.totalSen, orderCurrency)})
                        </span>
                      </a>
                      <p className="text-[11px] text-center text-[#14233C]/70">
                        Your Stripe Checkout session is ready and will open in a secure top-level tab.
                      </p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={cardLoading || requiresReviewConfirmation}
                      onClick={handleStartStripeCheckout}
                      className="w-full py-3.5 px-6 rounded-xl bg-[#FF8D76] text-[#14233C] font-extrabold text-sm hover:bg-[#ff7b60] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                    >
                      <CreditCard className="w-4 h-4" />
                      <span>
                        {cardLoading
                          ? 'Opening Stripe Checkout…'
                          : requiresReviewConfirmation
                            ? 'Review Updated Total Above to Continue'
                            : `Pay ${formatCurrencyAmount(order.totalSen, orderCurrency)} (${orderCurrency}) with Card`}
                      </span>
                    </button>
                  )}

                  <p className="text-[11px] text-[#14233C]/60 flex items-center justify-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Hosted by Stripe · Fixed charge in {orderCurrency} (no automatic currency
                      conversion) · If cancelled, you return directly to this order
                    </span>
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
