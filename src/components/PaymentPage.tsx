import React, { useState, useEffect, useMemo } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Download,
  FileText,
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
  type MerchantPaymentConfig,
  type OrderPublic,
  type PaymentMethodKey
} from '../types/order';

interface PaymentPageProps {
  order: OrderPublic;
  merchantConfig: MerchantPaymentConfig | null;
  merchantConfigLoading: boolean;
  whatsappUrl: string | null;
  returnNotice: 'success_pending' | 'cancelled' | 'failed' | null;
  onOrderUpdated: (updated: OrderPublic) => void;
  onRefreshOrder: () => Promise<OrderPublic | null>;
  onReturnHome: () => void;
}

const formatRM = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

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
  whatsappUrl,
  returnNotice,
  onOrderUpdated,
  onRefreshOrder,
  onReturnHome
}: PaymentPageProps) {
  // Evaluate each payment option independently — only show options that are enabled and configured
  const availableMethods = useMemo<PaymentMethodKey[]>(() => {
    const methods: PaymentMethodKey[] = [];
    if (merchantConfig?.tng?.configured) methods.push('tng');
    if (merchantConfig?.duitnow?.configured) methods.push('duitnow');
    if (merchantConfig?.stripe?.configured) methods.push('card');
    return methods;
  }, [merchantConfig]);

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
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [qrImageFailed, setQrImageFailed] = useState<Record<string, boolean>>({});
  const [savingQr, setSavingQr] = useState(false);

  // Stripe card checkout state
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  // Webhook confirmation polling when returning from Stripe ?payment=success
  const [waitingForWebhook, setWaitingForWebhook] = useState(
    returnNotice === 'success_pending' &&
      (order.paymentStatus === 'Awaiting payment' ||
        order.paymentStatus === 'Receipt correction needed')
  );
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [pollAttempts, setPollAttempts] = useState(0);

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
    setReceiptError(null);
    if (!file) {
      setReceiptFile(null);
      return;
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      setReceiptError('Please upload a JPG, PNG, or PDF receipt file.');
      setReceiptFile(null);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setReceiptError('Receipt file must be smaller than 10 MB.');
      setReceiptFile(null);
      return;
    }

    setReceiptFile(file);
  };

  const canSubmitPayment =
    order.paymentStatus === 'Awaiting payment' ||
    order.paymentStatus === 'Receipt correction needed';

  const handleManualQrSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitPayment) return;
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

    setReceiptSubmitting(true);
    setReceiptError(null);

    const reader = new FileReader();
    reader.onerror = () => {
      setReceiptError('Unable to read the selected file. Please try again.');
      setReceiptSubmitting(false);
    };
    reader.onload = async () => {
      try {
        const res = await fetch('/api/upload-receipt', {
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
            receiptBase64: reader.result as string,
            filename: receiptFile.name
          })
        });
        const data = await res.json();
        if (res.ok && data.success && data.order) {
          onOrderUpdated(data.order);
          setTransactionRef('');
          setReceiptFile(null);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          setReceiptError(data.error || 'Could not submit your receipt. Please try again.');
        }
      } catch {
        setReceiptError('Connection error while uploading your receipt. Please try again.');
      } finally {
        setReceiptSubmitting(false);
      }
    };
    reader.readAsDataURL(receiptFile);
  };

  const handleStartStripeCheckout = async () => {
    if (!canSubmitPayment) return;
    setCardLoading(true);
    setCardError(null);

    try {
      const res = await fetch('/api/create-stripe-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-order-token': order.accessToken
        },
        body: JSON.stringify({
          reference: order.reference,
          accessToken: order.accessToken
        })
      });
      const data = await res.json();
      if (res.ok && data.success && data.url) {
        window.location.assign(data.url);
      } else {
        setCardError(data.error || 'Unable to open Stripe Checkout right now.');
        setCardLoading(false);
        if (res.status === 409) {
          await onRefreshOrder();
        }
      }
    } catch {
      setCardError('Network error while connecting to Stripe Checkout. Please try again.');
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

          {/* Itemized RM Pricing Breakdown */}
          <dl className="space-y-3 pt-5 border-t border-[#14233C]/10 text-sm">
            {order.regularSubtotalSen && order.savingsSen ? (
              <>
                <div className="flex items-center justify-between gap-4 text-[#14233C]/75">
                  <dt>Regular item total</dt>
                  <dd className="tabular-nums font-medium line-through text-[#14233C]/50">
                    {formatRM(order.regularSubtotalSen)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-emerald-800 font-semibold">
                  <dt>Bundle savings (20% off)</dt>
                  <dd className="tabular-nums">- {formatRM(order.savingsSen)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4 text-[#14233C]">
                  <dt className="font-medium">Bundle subtotal</dt>
                  <dd className="tabular-nums font-semibold">{formatRM(order.subtotalSen)}</dd>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-4 text-[#14233C]">
                <dt className="font-medium">Item subtotal</dt>
                <dd className="tabular-nums font-semibold">{formatRM(order.subtotalSen)}</dd>
              </div>
            )}

            <div className="flex items-center justify-between gap-4 text-[#14233C]/75">
              <dt>Delivery fee ({order.customer.state})</dt>
              <dd className="tabular-nums font-medium">{formatRM(order.deliveryFeeSen)}</dd>
            </div>

            <div className="flex items-baseline justify-between gap-4 pt-4 border-t border-[#14233C]/12">
              <dt className="text-sm font-bold text-[#14233C]">
                {isPaid ? 'Total Paid' : 'Exact Amount Due'}
              </dt>
              <dd className="text-2xl font-extrabold tabular-nums text-[#E05A40]">
                {formatRM(order.totalSen)}
              </dd>
            </div>
          </dl>

          {/* Delivery Details Summary */}
          <div className="pt-5 border-t border-[#14233C]/10 space-y-1.5 text-xs text-[#14233C]/75">
            <p className="font-bold text-[#14233C]">Delivery Recipient</p>
            <p className="font-medium text-[#14233C]">{order.customer.fullName}</p>
            <p>
              {order.customer.email} · {order.customer.mobile}
            </p>
            <p>
              {order.customer.address}, {order.customer.postcode} {order.customer.city},{' '}
              {order.customer.state}
            </p>
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
                  <dt className="text-[#14233C]/60">Total Paid</dt>
                  <dd className="font-extrabold tabular-nums text-emerald-800 text-sm mt-0.5">
                    {formatRM(order.totalSen)}
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
                  <dt className="text-[#14233C]/60">Amount Submitted</dt>
                  <dd className="font-bold tabular-nums text-[#14233C] mt-0.5">
                    {formatRM(order.totalSen)}
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
                    matching your order reference and exact MYR total. This usually takes a few
                    seconds.
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

              {/* Select Payment Method — Three Independent Options */}
              <div className="space-y-2.5">
                <h2 className="text-base font-bold text-[#14233C]">Select Payment Method</h2>

                {merchantConfigLoading ? (
                  <div className="py-6 text-xs text-[#14233C]/60">Loading available payment methods…</div>
                ) : availableMethods.length === 0 ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 p-4 rounded-xl bg-[#FAF6EE] border border-[#14233C]/15 text-xs text-[#14233C]/80 leading-relaxed"
                  >
                    <AlertCircle className="w-4 h-4 text-[#E05A40] shrink-0 mt-0.5" />
                    <p>
                      No payment methods are currently enabled for checkout. Your order{' '}
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
                    {merchantConfig?.tng?.configured && (
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

                    {merchantConfig?.duitnow?.configured && (
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

                    {merchantConfig?.stripe?.configured && (
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
                          Credit or Debit Card
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* MANUAL QR PANEL — Shows ONLY the currently selected QR option */}
              {(activeMethod === 'tng' || activeMethod === 'duitnow') && activeQrConfig && (
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
                            {formatRM(order.totalSen)}
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
                          <dt className="text-[#14233C]/65">Exact Order Total</dt>
                          <dd className="flex items-center gap-2">
                            <span className="font-extrabold text-base tabular-nums text-[#E05A40]">
                              {formatRM(order.totalSen)}
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
                              ? `${receiptFile.name} (${(receiptFile.size / 1024).toFixed(0)} KB)`
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
                        Your receipt is stored privately and linked to order {order.reference} under{' '}
                        {activeQrConfig.label}.
                      </p>
                    </div>

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
                      disabled={receiptSubmitting}
                      className="w-full py-3.5 px-6 rounded-xl bg-[#14233C] text-white font-bold text-sm hover:bg-[#1e3357] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      {receiptSubmitting
                        ? 'Uploading receipt securely…'
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
                        {formatRM(order.totalSen)}
                      </strong>{' '}
                      in Malaysian Ringgit (MYR). Your order is confirmed automatically once Stripe
                      verifies the payment.
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

                  <button
                    type="button"
                    disabled={cardLoading}
                    onClick={handleStartStripeCheckout}
                    className="w-full py-3.5 px-6 rounded-xl bg-[#FF8D76] text-[#14233C] font-extrabold text-sm hover:bg-[#ff7b60] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>
                      {cardLoading
                        ? 'Opening Stripe Checkout…'
                        : `Pay ${formatRM(order.totalSen)} with Card`}
                    </span>
                  </button>

                  <p className="text-[11px] text-[#14233C]/60 flex items-center justify-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Hosted by Stripe · Charged in MYR · If cancelled, you return directly to this
                      order
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
