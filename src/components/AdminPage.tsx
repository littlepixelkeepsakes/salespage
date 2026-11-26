import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  Lock,
  LogOut,
  Mail,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Upload,
  X
} from 'lucide-react';
import type {
  AdminConfigDiagnostics,
  EditableStoreSettings,
  MerchantPaymentConfig,
  OrderPublic,
  PublicStorefrontConfig
} from '../types/order';

interface AdminPageProps {
  onBackToShop: () => void;
  onOpenOrderPayment: (reference: string, accessToken: string) => void;
  onStorefrontUpdated: (
    storefront: PublicStorefrontConfig,
    merchantConfig: MerchantPaymentConfig
  ) => void;
}

const formatRM = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

const getAccountToCheck = (order: OrderPublic): { accountTag: string; instruction: string } => {
  if (order.paymentMethod === 'tng') {
    return {
      accountTag: 'TNG — Touch ’n Go eWallet',
      instruction: 'Match incoming transfer in Touch ’n Go eWallet account'
    };
  }
  if (order.paymentMethod === 'duitnow') {
    return {
      accountTag: 'Public Bank — QR Pay',
      instruction: 'Match incoming transfer in Public Bank account'
    };
  }
  if (order.paymentMethod === 'card') {
    return {
      accountTag: 'Credit or Debit Card (Stripe)',
      instruction: 'Confirmed automatically by Stripe webhook'
    };
  }
  return {
    accountTag: 'Not selected yet',
    instruction: 'Customer has not submitted payment yet'
  };
};

export default function AdminPage({
  onBackToShop,
  onOpenOrderPayment,
  onStorefrontUpdated
}: AdminPageProps) {
  const [authMode, setAuthMode] = useState<'loading' | 'env' | 'claimed' | 'bootstrap_required' | 'unavailable'>('loading');
  const [supabaseBannerError, setSupabaseBannerError] = useState<string | null>(null);
  // Session token kept strictly in React memory (never localStorage or sessionStorage)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [confirmPasscodeInput, setConfirmPasscodeInput] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'orders' | 'settings'>('orders');

  const [orders, setOrders] = useState<OrderPublic[]>([]);
  const [diagnostics, setDiagnostics] = useState<AdminConfigDiagnostics | null>(null);
  const [settings, setSettings] = useState<EditableStoreSettings | null>(null);
  const [peninsularRm, setPeninsularRm] = useState('8.00');
  const [eastRm, setEastRm] = useState('15.00');
  const [savingSettings, setSavingSettings] = useState(false);
  const [uploadingField, setUploadingField] = useState<string | null>(null);

  const [loadingOrders, setLoadingOrders] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'correction' | 'awaiting' | 'paid'>('all');

  // Verification & email retry action state
  const [confirmingRef, setConfirmingRef] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState('');
  const [actionBusyRef, setActionBusyRef] = useState<string | null>(null);
  const [retryingEmailRef, setRetryingEmailRef] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [copiedLinkRef, setCopiedLinkRef] = useState<string | null>(null);

  // In-app private file preview modal (supports both customer photos & payment receipts)
  const [filePreview, setFilePreview] = useState<{
    kind: 'photo' | 'receipt';
    reference: string;
    fileName: string;
    mimeType: string;
    objectUrl: string;
  } | null>(null);
  const [loadingFileKey, setLoadingFileKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/auth-status')
      .then(res => res.json())
      .then(data => {
        if (data.supabaseError) {
          setSupabaseBannerError(data.supabaseError);
        }
        if (data.success && data.mode) {
          setAuthMode(data.mode);
        } else {
          setAuthMode('env');
        }
      })
      .catch(() => setAuthMode('env'));
  }, []);

  useEffect(() => {
    return () => {
      if (filePreview?.objectUrl) {
        URL.revokeObjectURL(filePreview.objectUrl);
      }
    };
  }, [filePreview]);

  const hydrateSettings = (loaded: EditableStoreSettings) => {
    setSettings(loaded);
    setPeninsularRm((loaded.deliveryRatesSen.peninsular / 100).toFixed(2));
    setEastRm((loaded.deliveryRatesSen.eastMalaysia / 100).toFixed(2));
  };

  const fetchAdminData = useCallback(async (token: string) => {
    setLoadingOrders(true);
    setDashboardError(null);
    try {
      const res = await fetch('/api/admin/orders', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (res.ok && data.success) {
        setOrders(data.orders || []);
        setDiagnostics(data.diagnostics || null);
        setSupabaseBannerError(data.supabaseError || null);
        if (data.settings) {
          hydrateSettings(data.settings);
        }
      } else {
        if (data.diagnostics) setDiagnostics(data.diagnostics);
        setDashboardError(data.error || 'Failed to load orders.');
      }
    } catch {
      setDashboardError('Network error while loading orders.');
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => {
    if (authToken) {
      fetchAdminData(authToken);
    }
  }, [authToken, fetchAdminData]);

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (passcodeInput.trim().length < 8) {
      setAuthError('Please choose a passcode of at least 8 characters.');
      return;
    }
    if (passcodeInput !== confirmPasscodeInput) {
      setAuthError('Passcodes do not match.');
      return;
    }

    setAuthSubmitting(true);
    try {
      const res = await fetch('/api/admin/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: passcodeInput })
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        setAuthMode('claimed');
        setPasscodeInput('');
        setConfirmPasscodeInput('');
      } else {
        setAuthError(data.error || 'Unable to set up admin passcode.');
      }
    } catch {
      setAuthError('Connection error during admin setup.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: passcodeInput })
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        setPasscodeInput('');
      } else {
        setAuthError(data.error || 'Sign-in failed.');
      }
    } catch {
      setAuthError('Connection error while signing in.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    if (authToken) {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` }
        });
      } catch {
        // Best-effort server logout
      }
    }
    setAuthToken(null);
    setOrders([]);
    setDiagnostics(null);
    setSettings(null);
    setConfirmingRef(null);
  };

  const handleOpenPrivateFile = async (
    order: OrderPublic,
    kind: 'photo' | 'receipt',
    downloadOnly = false
  ) => {
    if (!authToken) return;
    const key = `${kind}:${order.reference}:${downloadOnly ? 'dl' : 'view'}`;
    setLoadingFileKey(key);
    setDashboardError(null);
    try {
      const endpoint =
        kind === 'photo'
          ? `/api/admin/orders/${encodeURIComponent(order.reference)}/photo${downloadOnly ? '?download=1' : ''}`
          : `/api/admin/orders/${encodeURIComponent(order.reference)}/receipt${downloadOnly ? '?download=1' : ''}`;
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setDashboardError(errData.error || `Unable to load private ${kind}.`);
        return;
      }
      const blob = await res.blob();
      const mimeType =
        blob.type ||
        (kind === 'receipt' ? order.receiptMimeType || 'image/jpeg' : 'image/jpeg');
      const fallbackExt =
        mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
      const fileName =
        kind === 'photo'
          ? order.photoFileName || `${order.reference}_photo.${fallbackExt}`
          : order.receiptFileName || `${order.reference}_receipt.${fallbackExt}`;
      const objectUrl = URL.createObjectURL(blob);

      if (downloadOnly) {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      } else {
        setFilePreview({
          kind,
          reference: order.reference,
          fileName,
          mimeType,
          objectUrl
        });
      }
    } catch {
      setDashboardError(`Failed to fetch private ${kind}.`);
    } finally {
      setLoadingFileKey(null);
    }
  };

  const handleVerifyAndMarkPaid = async (reference: string) => {
    if (!authToken) return;
    setActionBusyRef(reference);
    setDashboardError(null);
    setActionFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/orders/${encodeURIComponent(reference)}/verify-payment`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({ note: verifyNote.trim() })
        }
      );
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (res.ok && data.success && data.order) {
        setOrders(prev => prev.map(o => (o.reference === reference ? data.order : o)));
        setConfirmingRef(null);
        setVerifyNote('');
        const emailSuffix =
          data.order.confirmationEmailStatus === 'sent'
            ? ' Confirmation email sent via Resend.'
            : data.order.confirmationEmailStatus === 'failed'
              ? ' Confirmation email failed — order remains Paid; use Retry Email below.'
              : data.order.confirmationEmailStatus === 'not_configured'
                ? ' (Resend email not configured; order remains Paid.)'
                : '';
        setActionFeedback(`Order ${reference} verified and marked as Paid.${emailSuffix}`);
      } else {
        setDashboardError(data.error || 'Could not mark order as paid.');
      }
    } catch {
      setDashboardError('Network error while verifying payment.');
    } finally {
      setActionBusyRef(null);
    }
  };

  const handleRetryConfirmationEmail = async (reference: string) => {
    if (!authToken) return;
    setRetryingEmailRef(reference);
    setDashboardError(null);
    setActionFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/orders/${encodeURIComponent(reference)}/retry-email`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        }
      );
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (data.order) {
        setOrders(prev => prev.map(o => (o.reference === reference ? data.order : o)));
      }
      if (res.ok && data.success) {
        setActionFeedback(
          `Confirmation email sent for paid order ${reference}. Paid status unchanged.`
        );
      } else {
        setDashboardError(
          data.error ||
            `Could not send confirmation email for ${reference}. The order remains confirmed as Paid.`
        );
      }
    } catch {
      setDashboardError(
        `Network error while retrying confirmation email for ${reference}. The order remains confirmed as Paid.`
      );
    } finally {
      setRetryingEmailRef(null);
    }
  };

  const handleRequestCorrectedReceipt = async (reference: string) => {
    if (!authToken) return;
    setActionBusyRef(reference);
    setDashboardError(null);
    setActionFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/orders/${encodeURIComponent(reference)}/reject-payment`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify({
            reason:
              verifyNote.trim() ||
              'Incoming transfer could not be matched. Please verify the recipient name and exact amount, then upload a corrected receipt.'
          })
        }
      );
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (res.ok && data.success && data.order) {
        setOrders(prev => prev.map(o => (o.reference === reference ? data.order : o)));
        setConfirmingRef(null);
        setVerifyNote('');
        setActionFeedback(
          `Order ${reference} marked as "Receipt correction needed". Share the customer's secure order link so they can upload a replacement receipt.`
        );
      } else {
        setDashboardError(data.error || 'Could not request a corrected receipt.');
      }
    } catch {
      setDashboardError('Network error while updating order.');
    } finally {
      setActionBusyRef(null);
    }
  };

  const handleCopySecureLink = async (order: OrderPublic) => {
    const link = `${window.location.origin}/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.accessToken)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLinkRef(order.reference);
      window.setTimeout(() => setCopiedLinkRef(null), 1800);
    } catch {
      // Clipboard restricted
    }
  };

  const handleAdminAssetUpload = (
    fieldKey: string,
    target: 'storefront' | 'qr',
    onSuccess: (assetUrl: string) => void
  ) => {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !authToken) return;
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        setDashboardError('Please upload a JPG or PNG image.');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setDashboardError('Image must be smaller than 10 MB.');
        return;
      }

      setUploadingField(fieldKey);
      setDashboardError(null);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await fetch('/api/admin/upload-asset', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`
            },
            body: JSON.stringify({ target, imageBase64: reader.result as string })
          });
          const data = await res.json();
          if (res.status === 401) {
            setAuthToken(null);
            setAuthError('Session expired. Please sign in again.');
            return;
          }
          if (res.ok && data.success && data.assetUrl) {
            onSuccess(data.assetUrl);
          } else {
            setDashboardError(data.error || 'Asset upload failed.');
          }
        } catch {
          setDashboardError('Network error while uploading image.');
        } finally {
          setUploadingField(null);
        }
      };
      reader.readAsDataURL(file);
    };
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !settings) return;

    const penVal = Math.round(Number.parseFloat(peninsularRm) * 100);
    const eastVal = Math.round(Number.parseFloat(eastRm) * 100);
    if (!Number.isFinite(penVal) || penVal < 0 || !Number.isFinite(eastVal) || eastVal < 0) {
      setDashboardError('Enter valid non-negative RM amounts for delivery rates.');
      return;
    }

    setSavingSettings(true);
    setDashboardError(null);
    setActionFeedback(null);

    try {
      const payload: EditableStoreSettings = {
        ...settings,
        deliveryRatesSen: {
          peninsular: penVal,
          eastMalaysia: eastVal
        }
      };

      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ settings: payload })
      });
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (res.ok && data.success) {
        hydrateSettings(data.settings);
        if (data.diagnostics) setDiagnostics(data.diagnostics);
        if (data.storefront && data.merchantConfig) {
          onStorefrontUpdated(data.storefront, data.merchantConfig);
        }
        setActionFeedback('Storefront and payment settings saved and applied live.');
      } else {
        setDashboardError(data.error || 'Could not save settings.');
      }
    } catch {
      setDashboardError('Network error while saving settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const filteredOrders = orders.filter(order => {
    if (filter === 'pending') return order.paymentStatus === 'Pending verification';
    if (filter === 'correction') return order.paymentStatus === 'Receipt correction needed';
    if (filter === 'awaiting') return order.paymentStatus === 'Awaiting payment';
    if (filter === 'paid') return order.paymentStatus === 'Paid';
    return true;
  });

  const pendingCount = orders.filter(o => o.paymentStatus === 'Pending verification').length;
  const correctionCount = orders.filter(o => o.paymentStatus === 'Receipt correction needed').length;
  const awaitingCount = orders.filter(o => o.paymentStatus === 'Awaiting payment').length;
  const paidCount = orders.filter(o => o.paymentStatus === 'Paid').length;

  // UNAUTHENTICATED GATE
  if (!authToken) {
    return (
      <main className="py-12 px-4 sm:px-8 max-w-md mx-auto space-y-6">
        <button
          type="button"
          onClick={onBackToShop}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#14233C] hover:text-[#E05A40] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Shop</span>
        </button>

        <div className="bg-white rounded-2xl border border-[#14233C]/12 p-7 space-y-6">
          <div className="space-y-1.5">
            <div className="w-10 h-10 rounded-xl bg-[#14233C] text-white flex items-center justify-center mb-3">
              <Lock className="w-5 h-5" />
            </div>
            <h1 className="text-2xl font-extrabold text-[#14233C]">
              {authMode === 'bootstrap_required'
                ? 'Set Up Staff Admin Passcode'
                : 'Staff Admin Sign In'}
            </h1>
            <p className="text-xs text-[#14233C]/70 leading-relaxed">
              {authMode === 'bootstrap_required'
                ? 'Create a one-time staff passcode stored hashed in Supabase staff_accounts. Setting ADMIN_PASSCODE on the server always overrides this setup.'
                : authMode === 'unavailable'
                  ? 'Supabase must be configured (or ADMIN_PASSCODE set on the server) before signing in to Staff Admin.'
                  : 'Sign in with your staff passcode to verify manual QR payments, preview private customer photos and receipts, and edit shop settings.'}
            </p>
          </div>

          {supabaseBannerError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 leading-relaxed"
            >
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">Supabase configuration required</p>
                <p className="mt-0.5">{supabaseBannerError}</p>
              </div>
            </div>
          )}

          {authMode === 'loading' ? (
            <p className="text-xs text-[#14233C]/60">Checking admin access status…</p>
          ) : authMode === 'unavailable' ? (
            <p className="text-xs text-[#14233C]/70">
              Configure <span className="font-mono font-semibold">SUPABASE_URL</span>,{' '}
              <span className="font-mono font-semibold">SUPABASE_SECRET_KEY</span>,{' '}
              <span className="font-mono font-semibold">SUPABASE_PHOTOS_BUCKET</span>, and{' '}
              <span className="font-mono font-semibold">SUPABASE_RECEIPTS_BUCKET</span> on the server, run the SQL migration, then reload.
            </p>
          ) : authMode === 'bootstrap_required' ? (
            <form onSubmit={handleBootstrap} className="space-y-4">
              <div>
                <label htmlFor="admin-setup-pass" className="block text-xs font-semibold text-[#14233C] mb-1.5">
                  New Staff Passcode (min 8 characters)
                </label>
                <input
                  id="admin-setup-pass"
                  type="password"
                  required
                  minLength={8}
                  value={passcodeInput}
                  onChange={e => setPasscodeInput(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                />
              </div>
              <div>
                <label htmlFor="admin-setup-confirm" className="block text-xs font-semibold text-[#14233C] mb-1.5">
                  Confirm Staff Passcode
                </label>
                <input
                  id="admin-setup-confirm"
                  type="password"
                  required
                  minLength={8}
                  value={confirmPasscodeInput}
                  onChange={e => setConfirmPasscodeInput(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                />
              </div>
              {authError && (
                <div role="alert" className="text-xs font-semibold text-red-700 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-3 rounded-xl bg-[#14233C] text-white text-sm font-bold hover:bg-[#1e3357] disabled:opacity-60 transition-colors"
              >
                {authSubmitting ? 'Saving Passcode…' : 'Claim Staff Admin Access'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="admin-login-pass" className="block text-xs font-semibold text-[#14233C] mb-1.5">
                  Staff Passcode
                </label>
                <input
                  id="admin-login-pass"
                  type="password"
                  required
                  value={passcodeInput}
                  onChange={e => setPasscodeInput(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                />
              </div>
              {authError && (
                <div role="alert" className="text-xs font-semibold text-red-700 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-3 rounded-xl bg-[#14233C] text-white text-sm font-bold hover:bg-[#1e3357] disabled:opacity-60 transition-colors"
              >
                {authSubmitting ? 'Signing in…' : 'Sign In to Staff Admin'}
              </button>
            </form>
          )}
        </div>
      </main>
    );
  }

  // AUTHENTICATED ADMIN DASHBOARD
  return (
    <main className="py-10 px-4 sm:px-8 max-w-6xl mx-auto space-y-8">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-[#14233C]/10 pb-6">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onBackToShop}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-[#14233C]/70 hover:text-[#14233C] mb-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Storefront</span>
          </button>
          <h1 className="text-3xl font-extrabold tracking-tight text-[#14233C]">
            Protected Staff Admin
          </h1>
          <p className="text-xs text-[#14233C]/70">
            Verify incoming TNG and Public Bank payments, request corrected receipts, and manage shop settings.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1 p-1 bg-white border border-[#14233C]/15 rounded-xl">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                activeTab === 'orders'
                  ? 'bg-[#14233C] text-white'
                  : 'text-[#14233C]/75 hover:text-[#14233C]'
              }`}
            >
              Orders ({orders.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                activeTab === 'settings'
                  ? 'bg-[#14233C] text-white'
                  : 'text-[#14233C]/75 hover:text-[#14233C]'
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Store & QR Settings</span>
            </button>
          </div>

          <button
            type="button"
            disabled={loadingOrders}
            onClick={() => fetchAdminData(authToken)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#14233C]/20 bg-white text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingOrders ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>

      {/* Alerts / Feedback */}
      {supabaseBannerError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 leading-relaxed"
        >
          <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Supabase Configuration Error (no local JSON fallback)</p>
            <p className="mt-0.5">{supabaseBannerError}</p>
          </div>
        </div>
      )}

      {dashboardError && (
        <div
          role="alert"
          className="flex items-center gap-2.5 p-4 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-800"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{dashboardError}</span>
        </div>
      )}

      {actionFeedback && (
        <div className="flex items-center gap-2.5 p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-900">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{actionFeedback}</span>
        </div>
      )}

      {/* Payment, Storage & Email Readiness Summary */}
      {diagnostics && (
        <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-4">
          <h2 className="text-sm font-bold text-[#14233C]">
            Payment Methods, Private Storage & Email Readiness
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
            {[diagnostics.tng, diagnostics.duitnow].map(item => (
              <div
                key={item.key}
                className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#14233C]">{item.label}</span>
                  <span className={`font-bold ${item.configured ? 'text-emerald-800' : 'text-amber-800'}`}>
                    {item.configured ? 'Active' : 'Disabled'}
                  </span>
                </div>
                {item.configured ? (
                  <>
                    <p className="text-[#14233C]/75 truncate">Recipient: {item.recipientName}</p>
                    <p className="font-mono text-[11px] text-[#14233C]/60 truncate">{item.qrImage}</p>
                  </>
                ) : (
                  <ul className="text-amber-900 list-disc list-inside space-y-0.5">
                    {item.issues.map((issue, idx) => (
                      <li key={idx}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            <div className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[#14233C]">Stripe Card</span>
                <span
                  className={`font-bold ${
                    diagnostics.stripe.configured ? 'text-emerald-800' : 'text-amber-800'
                  }`}
                >
                  {diagnostics.stripe.configured
                    ? diagnostics.stripe.mode === 'test'
                      ? 'Test Mode'
                      : 'Live Mode'
                    : 'Disabled'}
                </span>
              </div>
              <p className="text-[#14233C]/70">
                {diagnostics.stripe.issue ||
                  (diagnostics.stripe.webhookConfigured
                    ? 'Webhook signing secret configured.'
                    : 'Webhook secret not set.')}
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[#14233C]">Supabase</span>
                <span
                  className={`font-bold ${
                    diagnostics.supabase.configured ? 'text-emerald-800' : 'text-red-700'
                  }`}
                >
                  {diagnostics.supabase.configured ? 'Connected' : 'Action Needed'}
                </span>
              </div>
              {diagnostics.supabase.configured ? (
                <p className="text-[#14233C]/70 break-words">
                  PostgreSQL & private buckets ({diagnostics.supabase.photosBucket},{' '}
                  {diagnostics.supabase.receiptsBucket}) ready.
                </p>
              ) : (
                <ul className="text-red-800 list-disc list-inside space-y-0.5">
                  {diagnostics.supabase.issues.map((issue, idx) => (
                    <li key={idx}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[#14233C]">Paid Emails</span>
                <span
                  className={`font-bold ${
                    diagnostics.email.configured ? 'text-emerald-800' : 'text-amber-800'
                  }`}
                >
                  {diagnostics.email.configured ? 'Resend API' : 'Not Set'}
                </span>
              </div>
              <p className="text-[#14233C]/70 break-words">
                {diagnostics.email.configured
                  ? `From: ${diagnostics.email.fromAddress}`
                  : diagnostics.email.issue}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* TAB 1: ORDERS & MANUAL PAYMENT VERIFICATION */}
      {activeTab === 'orders' && (
        <div className="space-y-6">
          {/* Filter Controls */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-white border border-[#14233C]/12 rounded-xl">
              {(
                [
                  { key: 'all', label: `All (${orders.length})` },
                  { key: 'pending', label: `Pending Verification (${pendingCount})` },
                  { key: 'correction', label: `Receipt Correction (${correctionCount})` },
                  { key: 'awaiting', label: `Awaiting Payment (${awaitingCount})` },
                  { key: 'paid', label: `Paid (${paidCount})` }
                ] as const
              ).map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilter(tab.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                    filter === tab.key
                      ? 'bg-[#14233C] text-white'
                      : 'text-[#14233C]/70 hover:text-[#14233C]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {filteredOrders.length === 0 ? (
            <div className="bg-white rounded-2xl border border-[#14233C]/12 p-10 text-center text-sm text-[#14233C]/65">
              {loadingOrders ? 'Loading orders…' : 'No orders match this filter.'}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredOrders.map(order => {
                const accountInfo = getAccountToCheck(order);
                const isPending = order.paymentStatus === 'Pending verification';
                const isCorrection = order.paymentStatus === 'Receipt correction needed';
                const isPaid = order.paymentStatus === 'Paid';
                const isConfirming = confirmingRef === order.reference;

                return (
                  <article
                    key={order.reference}
                    className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-4"
                  >
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className="w-16 h-16 rounded-xl overflow-hidden bg-[#FAF6EE] border border-[#14233C]/10 shrink-0">
                          {order.photoUrl && (
                            <img
                              src={order.photoUrl}
                              alt={`Photo for ${order.reference}`}
                              className="w-full h-full object-cover"
                            />
                          )}
                        </div>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[#14233C]/65">
                            <span className="font-mono font-bold text-[#14233C] text-sm">
                              {order.reference}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{new Date(order.createdAt).toLocaleString()}</span>
                            <span aria-hidden="true">·</span>
                            <span
                              className={`font-bold inline-flex items-center gap-1 ${
                                isPaid
                                  ? 'text-emerald-800'
                                  : isPending
                                    ? 'text-amber-800'
                                    : isCorrection
                                      ? 'text-red-700'
                                      : 'text-[#14233C]/80'
                              }`}
                            >
                              {isPaid && <CheckCircle2 className="w-3.5 h-3.5" />}
                              {isPending && <Clock className="w-3.5 h-3.5" />}
                              {isCorrection && <AlertCircle className="w-3.5 h-3.5" />}
                              <span>{order.paymentStatus}</span>
                            </span>
                          </div>

                          <p className="text-sm font-bold text-[#14233C]">
                            {order.productName} (Qty {order.itemQuantity}) — {order.customer.fullName}
                          </p>
                          <p className="text-xs text-[#14233C]/70">
                            {order.customer.email} · {order.customer.mobile} · {order.customer.city},{' '}
                            {order.customer.state}
                          </p>
                        </div>
                      </div>

                      <div className="md:text-right shrink-0">
                        <p className="text-[11px] font-semibold text-[#14233C]/60">
                          {isPaid ? 'Total Paid' : 'Amount Due'}
                        </p>
                        <p className="text-xl font-extrabold tabular-nums text-[#E05A40]">
                          {formatRM(order.totalSen)}
                        </p>
                        {isPaid && (
                          <p
                            className={`text-[11px] flex items-center md:justify-end gap-1 mt-0.5 font-semibold ${
                              order.confirmationEmailStatus === 'sent'
                                ? 'text-emerald-800'
                                : order.confirmationEmailStatus === 'failed'
                                  ? 'text-red-700'
                                  : 'text-amber-800'
                            }`}
                          >
                            <Mail className="w-3 h-3 shrink-0" />
                            <span>
                              {order.confirmationEmailStatus === 'sent'
                                ? 'Confirmation email sent'
                                : order.confirmationEmailStatus === 'failed'
                                  ? 'Confirmation email failed'
                                  : 'Email not sent yet'}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Payment Method, Transaction Reference, Receipt & Actions */}
                    <div className="pt-4 border-t border-[#14233C]/10 grid grid-cols-1 md:grid-cols-12 gap-4 items-center text-xs">
                      <div className="md:col-span-4 space-y-0.5">
                        <p className="text-[#14233C]/60 font-semibold">Payment Method / Account</p>
                        <p className="text-sm font-extrabold text-[#14233C]">
                          {accountInfo.accountTag}
                        </p>
                        <p className="text-[#14233C]/70">{accountInfo.instruction}</p>
                      </div>

                      <div className="md:col-span-4 space-y-0.5">
                        <p className="text-[#14233C]/60 font-semibold">Transaction Reference & Receipt</p>
                        <p className="font-mono font-bold text-[#14233C]">
                          {order.transactionReference || '—'}
                        </p>
                        <p className="text-[#14233C]/70 flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">
                            {order.receiptSubmitted
                              ? order.receiptFileName || 'Private receipt uploaded'
                              : 'No receipt uploaded'}
                          </span>
                        </p>
                      </div>

                      <div className="md:col-span-4 flex flex-wrap md:justify-end gap-2">
                        <button
                          type="button"
                          disabled={loadingFileKey === `photo:${order.reference}:view`}
                          onClick={() => handleOpenPrivateFile(order, 'photo', false)}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          <span>
                            {loadingFileKey === `photo:${order.reference}:view`
                              ? 'Opening…'
                              : 'Preview Photo'}
                          </span>
                        </button>

                        <button
                          type="button"
                          disabled={loadingFileKey === `photo:${order.reference}:dl`}
                          onClick={() => handleOpenPrivateFile(order, 'photo', true)}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>
                            {loadingFileKey === `photo:${order.reference}:dl`
                              ? 'Downloading…'
                              : 'Download Photo'}
                          </span>
                        </button>

                        {order.receiptSubmitted && (
                          <>
                            <button
                              type="button"
                              disabled={loadingFileKey === `receipt:${order.reference}:view`}
                              onClick={() => handleOpenPrivateFile(order, 'receipt', false)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>
                                {loadingFileKey === `receipt:${order.reference}:view`
                                  ? 'Opening…'
                                  : 'View Receipt'}
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={loadingFileKey === `receipt:${order.reference}:dl`}
                              onClick={() => handleOpenPrivateFile(order, 'receipt', true)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                            >
                              <Download className="w-3.5 h-3.5" />
                              <span>
                                {loadingFileKey === `receipt:${order.reference}:dl`
                                  ? 'Downloading…'
                                  : 'Receipt'}
                              </span>
                            </button>
                          </>
                        )}

                        {isPending && !isConfirming && (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmingRef(order.reference);
                              setVerifyNote('');
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>Review Payment</span>
                          </button>
                        )}

                        {isPaid && !order.confirmationEmailSentAt && (
                          <button
                            type="button"
                            disabled={retryingEmailRef === order.reference}
                            onClick={() => handleRetryConfirmationEmail(order.reference)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#E05A40] text-white text-xs font-bold hover:bg-[#c84b33] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Mail className="w-3.5 h-3.5" />
                            <span>
                              {retryingEmailRef === order.reference
                                ? 'Sending…'
                                : order.confirmationEmailStatus === 'failed'
                                  ? 'Retry Email'
                                  : 'Send Confirmation Email'}
                            </span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleCopySecureLink(order)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-[#14233C]/15 text-xs font-semibold text-[#14233C] hover:bg-[#FAF6EE] whitespace-nowrap shrink-0"
                        >
                          {copiedLinkRef === order.reference ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-700" />
                              <span>Link Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-[#14233C]/65" />
                              <span>Copy Secure Link</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => onOpenOrderPayment(order.reference, order.accessToken)}
                          className="px-2.5 py-2 rounded-xl text-xs font-semibold text-[#14233C]/70 hover:text-[#14233C] underline whitespace-nowrap shrink-0"
                        >
                          Open Status Page
                        </button>
                      </div>
                    </div>

                    {/* Staff Verification / Request Corrected Receipt Panel */}
                    {isPending && isConfirming && (
                      <div className="pt-4 border-t border-[#14233C]/10 bg-[#FAF6EE] -mx-6 -mb-6 p-6 rounded-b-2xl space-y-4">
                        <div className="space-y-1 text-xs">
                          <p className="font-extrabold text-[#14233C] text-sm">
                            Verify against actual incoming transaction or request a corrected receipt
                          </p>
                          <p className="text-[#14233C]/80">
                            Check that{' '}
                            <strong className="tabular-nums text-[#E05A40]">
                              {formatRM(order.totalSen)}
                            </strong>{' '}
                            actually arrived in <strong>{accountInfo.accountTag}</strong> matching
                            reference <strong className="font-mono">{order.transactionReference}</strong>.
                          </p>
                        </div>

                        <input
                          type="text"
                          maxLength={240}
                          placeholder="Staff note (or reason shown to customer when requesting a corrected receipt)"
                          value={verifyNote}
                          onChange={e => setVerifyNote(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#14233C]/20 text-xs text-[#14233C] focus:outline-none focus:border-[#14233C]"
                        />

                        <div className="flex flex-wrap items-center gap-2.5">
                          <button
                            type="button"
                            disabled={actionBusyRef === order.reference}
                            onClick={() => handleVerifyAndMarkPaid(order.reference)}
                            className="px-4 py-2.5 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                          >
                            {actionBusyRef === order.reference
                              ? 'Updating…'
                              : 'Confirm Incoming Payment — Mark Paid'}
                          </button>
                          <button
                            type="button"
                            disabled={actionBusyRef === order.reference}
                            onClick={() => handleRequestCorrectedReceipt(order.reference)}
                            className="px-4 py-2.5 rounded-xl border border-red-700/30 bg-white text-red-800 text-xs font-bold hover:bg-red-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                          >
                            Request Corrected Receipt
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmingRef(null);
                              setVerifyNote('');
                            }}
                            className="px-3 py-2 text-xs font-semibold text-[#14233C]/70 hover:text-[#14233C]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {isCorrection && order.correctionReason && (
                      <p className="text-xs text-red-800 pt-2 border-t border-[#14233C]/10">
                        Correction requested: {order.correctionReason}
                      </p>
                    )}

                    {isPaid && order.verificationNote && (
                      <p className="text-xs text-emerald-900 pt-2 border-t border-[#14233C]/10">
                        Staff verification note: {order.verificationNote}
                      </p>
                    )}

                    {isPaid && !order.confirmationEmailSentAt && order.confirmationEmailError && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950">
                        <div className="space-y-0.5">
                          <p className="font-bold text-red-800">
                            Confirmation email error recorded (order remains confirmed as Paid):
                          </p>
                          <p className="font-mono text-[11px] break-all text-[#14233C]/85">
                            {order.confirmationEmailError}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={retryingEmailRef === order.reference}
                          onClick={() => handleRetryConfirmationEmail(order.reference)}
                          className="px-3 py-1.5 rounded-lg bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] disabled:opacity-60 whitespace-nowrap shrink-0 self-start sm:self-center"
                        >
                          {retryingEmailRef === order.reference ? 'Retrying…' : 'Retry Email'}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: EDITABLE STOREFRONT, DELIVERY, WHATSAPP & MERCHANT QR SETTINGS */}
      {activeTab === 'settings' && settings && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          {/* Branding & WhatsApp */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-5">
            <h2 className="text-base font-bold text-[#14233C]">
              Logo, Hero Showcase & WhatsApp Support
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Logo */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-[#14233C]">Shop Logo Image</label>
                <div className="flex items-center gap-3">
                  <img
                    src={settings.logoUrl}
                    alt="Logo preview"
                    className="w-12 h-12 rounded-xl object-contain bg-[#FAF6EE] border border-[#14233C]/15 shrink-0"
                  />
                  <input
                    type="text"
                    value={settings.logoUrl}
                    onChange={e => setSettings({ ...settings, logoUrl: e.target.value })}
                    className="flex-1 px-3 py-2 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-xs font-mono"
                  />
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold cursor-pointer hover:bg-[#FAF6EE] whitespace-nowrap">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{uploadingField === 'logo' ? '…' : 'Upload'}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="sr-only"
                      onChange={handleAdminAssetUpload('logo', 'storefront', url =>
                        setSettings(prev => (prev ? { ...prev, logoUrl: url } : prev))
                      )}
                    />
                  </label>
                </div>
              </div>

              {/* WhatsApp */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-[#14233C]">
                  WhatsApp Support Number (digits with country code, e.g. 60123456789)
                </label>
                <input
                  type="text"
                  placeholder="60123456789"
                  value={settings.whatsappSupportNumber}
                  onChange={e =>
                    setSettings({
                      ...settings,
                      whatsappSupportNumber: e.target.value.replace(/\D/g, '')
                    })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-xs font-mono"
                />
                <p className="text-[11px] text-[#14233C]/60">
                  {settings.whatsappSupportNumber.length >= 8
                    ? `Active link: https://wa.me/${settings.whatsappSupportNumber}`
                    : 'Leave blank to hide WhatsApp support links until configured.'}
                </p>
              </div>
            </div>

            {/* Hero Image */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-[#14233C]">Hero Showcase Image</label>
              <div className="flex items-center gap-3">
                <img
                  src={settings.heroImageUrl}
                  alt="Hero preview"
                  className="w-16 h-12 rounded-xl object-cover bg-[#FAF6EE] border border-[#14233C]/15 shrink-0"
                />
                <input
                  type="text"
                  value={settings.heroImageUrl}
                  onChange={e => setSettings({ ...settings, heroImageUrl: e.target.value })}
                  className="flex-1 px-3 py-2 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-xs font-mono"
                />
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold cursor-pointer hover:bg-[#FAF6EE] whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5" />
                  <span>{uploadingField === 'hero' ? '…' : 'Upload'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png"
                    className="sr-only"
                    onChange={handleAdminAssetUpload('hero', 'storefront', url =>
                      setSettings(prev => (prev ? { ...prev, heroImageUrl: url } : prev))
                    )}
                  />
                </label>
              </div>
            </div>
          </section>

          {/* Product & Gallery Images */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-5">
            <h2 className="text-base font-bold text-[#14233C]">Product & Gallery Images</h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(
                [
                  { key: 'keychain', label: 'Keychain Image' },
                  { key: 'magnet', label: 'Fridge Magnet Image' },
                  { key: 'bundle', label: '2-Piece Bundle Image' }
                ] as const
              ).map(item => (
                <div key={item.key} className="p-4 rounded-xl bg-[#FAF6EE]/60 border border-[#14233C]/10 space-y-2.5">
                  <p className="text-xs font-bold text-[#14233C]">{item.label}</p>
                  <img
                    src={settings.productImages[item.key]}
                    alt={item.label}
                    className="w-full aspect-[4/3] rounded-lg object-cover bg-white border border-[#14233C]/10"
                  />
                  <input
                    type="text"
                    value={settings.productImages[item.key]}
                    onChange={e =>
                      setSettings({
                        ...settings,
                        productImages: { ...settings.productImages, [item.key]: e.target.value }
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-[11px] font-mono"
                  />
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-xs font-bold cursor-pointer hover:bg-[#FAF6EE]">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{uploadingField === `prod_${item.key}` ? 'Uploading…' : 'Upload New'}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="sr-only"
                      onChange={handleAdminAssetUpload(`prod_${item.key}`, 'storefront', url =>
                        setSettings(prev =>
                          prev
                            ? {
                                ...prev,
                                productImages: { ...prev.productImages, [item.key]: url }
                              }
                            : prev
                        )
                      )}
                    />
                  </label>
                </div>
              ))}
            </div>

            <div className="pt-4 border-t border-[#14233C]/10 space-y-3">
              <p className="text-xs font-bold text-[#14233C]">Gallery Showcase Images</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {settings.galleryItems.map((gal, idx) => (
                  <div
                    key={gal.id || idx}
                    className="p-4 rounded-xl bg-[#FAF6EE]/60 border border-[#14233C]/10 space-y-2"
                  >
                    <img
                      src={gal.image}
                      alt={gal.title}
                      className="w-full aspect-[4/3] rounded-lg object-cover bg-white border border-[#14233C]/10"
                    />
                    <input
                      type="text"
                      value={gal.title}
                      onChange={e => {
                        const copy = [...settings.galleryItems];
                        copy[idx] = { ...copy[idx], title: e.target.value };
                        setSettings({ ...settings, galleryItems: copy });
                      }}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-xs font-semibold"
                    />
                    <input
                      type="text"
                      value={gal.image}
                      onChange={e => {
                        const copy = [...settings.galleryItems];
                        copy[idx] = { ...copy[idx], image: e.target.value };
                        setSettings({ ...settings, galleryItems: copy });
                      }}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-[11px] font-mono"
                    />
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-xs font-bold cursor-pointer hover:bg-[#FAF6EE]">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{uploadingField === `gal_${idx}` ? 'Uploading…' : 'Upload Image'}</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png"
                        className="sr-only"
                        onChange={handleAdminAssetUpload(`gal_${idx}`, 'storefront', url =>
                          setSettings(prev => {
                            if (!prev) return prev;
                            const copy = [...prev.galleryItems];
                            copy[idx] = { ...copy[idx], image: url };
                            return { ...prev, galleryItems: copy };
                          })
                        )}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Delivery Rates */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-4">
            <h2 className="text-base font-bold text-[#14233C]">Delivery Rates (RM)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Peninsular Malaysia Delivery Fee (RM)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  required
                  value={peninsularRm}
                  onChange={e => setPeninsularRm(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Sabah, Sarawak & Labuan Delivery Fee (RM)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  required
                  value={eastRm}
                  onChange={e => setEastRm(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
            </div>
          </section>

          {/* Merchant QR Images & Recipient Names */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-[#14233C]">
                Merchant QR Images & Recipient Names
              </h2>
              <p className="text-xs text-[#14233C]/70 mt-0.5">
                Leave recipient name or image blank to use server environment variables (`TNG_*` / `DUITNOW_*`), or set overrides below.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {(
                [
                  {
                    key: 'tng',
                    label: 'Touch ’n Go eWallet QR',
                    diag: diagnostics?.tng
                  },
                  {
                    key: 'duitnow',
                    label: 'Public Bank QR Pay',
                    diag: diagnostics?.duitnow
                  }
                ] as const
              ).map(({ key, label, diag }) => {
                const override = settings.qrOverrides[key];
                const effectiveImage = override.qrImage || diag?.qrImage || '';
                return (
                  <div
                    key={key}
                    className="p-4 rounded-xl bg-[#FAF6EE]/60 border border-[#14233C]/12 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-extrabold text-[#14233C]">{label}</span>
                      <select
                        value={
                          override.enabled === null
                            ? 'env'
                            : override.enabled
                              ? 'enabled'
                              : 'disabled'
                        }
                        onChange={e => {
                          const val = e.target.value;
                          const nextEnabled =
                            val === 'env' ? null : val === 'enabled' ? true : false;
                          setSettings({
                            ...settings,
                            qrOverrides: {
                              ...settings.qrOverrides,
                              [key]: { ...override, enabled: nextEnabled }
                            }
                          });
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-white border border-[#14233C]/20 text-xs font-bold"
                      >
                        <option value="env">Use Env Setting</option>
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-[#14233C] mb-1">
                        Recipient Name
                      </label>
                      <input
                        type="text"
                        placeholder={diag?.recipientName || 'Enter merchant recipient name'}
                        value={override.recipientName}
                        onChange={e =>
                          setSettings({
                            ...settings,
                            qrOverrides: {
                              ...settings.qrOverrides,
                              [key]: { ...override, recipientName: e.target.value }
                            }
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl bg-white border border-[#14233C]/20 text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-[#14233C] mb-1">
                        QR Image Path or URL
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder={diag?.qrImage || '/payments/...'}
                          value={override.qrImage}
                          onChange={e =>
                            setSettings({
                              ...settings,
                              qrOverrides: {
                                ...settings.qrOverrides,
                                [key]: { ...override, qrImage: e.target.value }
                              }
                            })
                          }
                          className="flex-1 px-3 py-2 rounded-xl bg-white border border-[#14233C]/20 text-xs font-mono"
                        />
                        <label className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-[#14233C]/20 text-xs font-bold cursor-pointer hover:bg-[#FAF6EE] whitespace-nowrap">
                          <Upload className="w-3.5 h-3.5" />
                          <span>{uploadingField === `qr_${key}` ? '…' : 'Upload'}</span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png"
                            className="sr-only"
                            onChange={handleAdminAssetUpload(`qr_${key}`, 'qr', url =>
                              setSettings(prev =>
                                prev
                                  ? {
                                      ...prev,
                                      qrOverrides: {
                                        ...prev.qrOverrides,
                                        [key]: { ...prev.qrOverrides[key], qrImage: url }
                                      }
                                    }
                                  : prev
                              )
                            )}
                          />
                        </label>
                      </div>
                    </div>

                    {effectiveImage && (
                      <div className="w-28 aspect-[3/4] rounded-lg bg-white border border-[#14233C]/15 p-1 overflow-hidden">
                        <img
                          src={effectiveImage}
                          alt={`${label} preview`}
                          className="w-full h-full object-contain"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={savingSettings}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#14233C] text-white text-sm font-bold hover:bg-[#1e3357] disabled:opacity-60 transition-colors"
            >
              <Save className="w-4 h-4" />
              <span>{savingSettings ? 'Saving Settings…' : 'Save Store & Payment Settings'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Private Customer Photo / Payment Receipt Preview Modal */}
      {filePreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${filePreview.kind === 'photo' ? 'Customer photo' : 'Receipt'} preview for ${filePreview.reference}`}
          className="fixed inset-0 z-50 bg-[#14233C]/60 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden border border-[#14233C]/15">
            <div className="px-5 py-4 border-b border-[#14233C]/10 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-bold text-[#14233C] truncate">
                  {filePreview.kind === 'photo' ? 'Private Customer Photo' : 'Private Receipt'} ·{' '}
                  {filePreview.reference}
                </p>
                <p className="text-xs text-[#14233C]/65 truncate">{filePreview.fileName}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={filePreview.objectUrl}
                  download={filePreview.fileName}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE]"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </a>
                <button
                  type="button"
                  onClick={() => setFilePreview(null)}
                  aria-label="Close preview"
                  className="p-2 rounded-lg text-[#14233C]/70 hover:bg-[#FAF6EE] hover:text-[#14233C]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-5 overflow-auto flex-1 bg-[#FAF6EE] flex items-center justify-center">
              {filePreview.mimeType === 'application/pdf' ? (
                <iframe
                  src={filePreview.objectUrl}
                  title={`PDF receipt for ${filePreview.reference}`}
                  className="w-full h-[65vh] rounded-xl border border-[#14233C]/15 bg-white"
                />
              ) : (
                <img
                  src={filePreview.objectUrl}
                  alt={`${filePreview.kind === 'photo' ? 'Customer photo' : 'Payment receipt'} for ${filePreview.reference}`}
                  className="max-w-full max-h-[65vh] object-contain rounded-xl border border-[#14233C]/15 bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
