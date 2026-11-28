import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
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
import {
  DEFAULT_MARKET_PRODUCT_BASE_PRICES,
  DEFAULT_PORTRAIT_FRAME_CONFIG,
  PORTRAIT_FRAME_DIMENSIONS,
  PORTRAIT_FRAME_PRODUCT_ID,
  formatCountryLabel,
  formatCurrencyAmount,
  formatCurrencyWithCode,
  resolvePortraitFrameConfig
} from '../shared/pricing';

interface AdminPageProps {
  onBackToShop: () => void;
  onOpenOrderPayment: (reference: string, accessToken: string) => void;
  onStorefrontUpdated: (
    storefront: PublicStorefrontConfig,
    merchantConfig: MerchantPaymentConfig
  ) => void;
}

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
  const [singaporeSgd, setSingaporeSgd] = useState('');
  const [sgKeychainSgd, setSgKeychainSgd] = useState(
    (DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.keychain / 100).toFixed(2)
  );
  const [sgMagnetSgd, setSgMagnetSgd] = useState(
    (DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG.magnet / 100).toFixed(2)
  );
  const [pfPriceMyRm, setPfPriceMyRm] = useState(
    (DEFAULT_PORTRAIT_FRAME_CONFIG.priceMySen / 100).toFixed(2)
  );
  const [pfPriceSgSgd, setPfPriceSgSgd] = useState(
    (DEFAULT_PORTRAIT_FRAME_CONFIG.priceSgCents / 100).toFixed(2)
  );
  const [pfPeninsularRm, setPfPeninsularRm] = useState(
    (DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryPeninsularSen / 100).toFixed(2)
  );
  const [pfEastRm, setPfEastRm] = useState(
    (DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryEastMalaysiaSen / 100).toFixed(2)
  );
  const [pfSingaporeSgd, setPfSingaporeSgd] = useState(
    typeof DEFAULT_PORTRAIT_FRAME_CONFIG.deliverySingaporeCents === 'number'
      ? (DEFAULT_PORTRAIT_FRAME_CONFIG.deliverySingaporeCents / 100).toFixed(2)
      : ''
  );
  const [pfDeliveryDays, setPfDeliveryDays] = useState(
    String(DEFAULT_PORTRAIT_FRAME_CONFIG.deliveryDays)
  );
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
  const [retryingMetaRef, setRetryingMetaRef] = useState<string | null>(null);
  const [testingMetaConnection, setTestingMetaConnection] = useState<boolean>(false);
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
    const resolvedFrame = resolvePortraitFrameConfig(loaded.portraitFrameConfig);
    setSettings({
      ...loaded,
      productImages: {
        keychain: loaded.productImages.keychain,
        magnet: loaded.productImages.magnet,
        bundle: loaded.productImages.bundle,
        portrait_frame:
          loaded.productImages.portrait_frame ||
          '/assets/aistudio/Our_Family_Perler_Bead_Portrait_ee465ba0.png'
      },
      portraitFrameConfig: resolvedFrame
    });
    setPeninsularRm((loaded.deliveryRatesSen.peninsular / 100).toFixed(2));
    setEastRm((loaded.deliveryRatesSen.eastMalaysia / 100).toFixed(2));
    setSingaporeSgd(
      typeof loaded.deliveryRateSingaporeCents === 'number'
        ? (loaded.deliveryRateSingaporeCents / 100).toFixed(2)
        : ''
    );
    const sgPrices = loaded.sgProductPricesCents || DEFAULT_MARKET_PRODUCT_BASE_PRICES.SG;
    setSgKeychainSgd((sgPrices.keychain / 100).toFixed(2));
    setSgMagnetSgd((sgPrices.magnet / 100).toFixed(2));
    setPfPriceMyRm((resolvedFrame.priceMySen / 100).toFixed(2));
    setPfPriceSgSgd((resolvedFrame.priceSgCents / 100).toFixed(2));
    setPfPeninsularRm((resolvedFrame.deliveryPeninsularSen / 100).toFixed(2));
    setPfEastRm((resolvedFrame.deliveryEastMalaysiaSen / 100).toFixed(2));
    setPfSingaporeSgd(
      typeof resolvedFrame.deliverySingaporeCents === 'number'
        ? (resolvedFrame.deliverySingaporeCents / 100).toFixed(2)
        : ''
    );
    setPfDeliveryDays(String(resolvedFrame.deliveryDays));
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
      const baseEndpoint =
        kind === 'photo'
          ? `/api/admin/orders/${encodeURIComponent(order.reference)}/photo`
          : `/api/admin/orders/${encodeURIComponent(order.reference)}/receipt`;
      const query = downloadOnly ? '?format=signed&download=1' : '?format=signed';
      const res = await fetch(`${baseEndpoint}${query}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      let blob: Blob;
      let resolvedFileName: string | undefined;
      let resolvedMimeType: string | undefined;

      if (contentType.includes('application/json')) {
        const rawText = await res.text().catch(() => '');
        let meta: {
          success?: boolean;
          signedUrl?: string;
          fileName?: string;
          mimeType?: string;
          error?: string;
        } = {};
        try {
          if (rawText.trim()) meta = JSON.parse(rawText);
        } catch {
          meta = {};
        }

        if (!res.ok || !meta.success || !meta.signedUrl) {
          setDashboardError(meta.error || `Unable to load private ${kind}.`);
          return;
        }
        let parsedSignedUrl: URL;
        try {
          parsedSignedUrl = new URL(meta.signedUrl);
          if (parsedSignedUrl.protocol !== 'https:') {
            throw new Error('Signed URL must use HTTPS.');
          }
        } catch {
          setDashboardError(`Received an invalid private ${kind} link from the server.`);
          return;
        }

        const storageRes = await fetch(parsedSignedUrl.toString());
        if (!storageRes.ok) {
          setDashboardError(`Unable to download private ${kind} from storage.`);
          return;
        }
        blob = await storageRes.blob();
        resolvedFileName = meta.fileName;
        resolvedMimeType = meta.mimeType;
      } else {
        if (!res.ok) {
          setDashboardError(`Unable to load private ${kind}.`);
          return;
        }
        blob = await res.blob();
      }

      const mimeType =
        resolvedMimeType ||
        blob.type ||
        (kind === 'receipt' ? order.receiptMimeType || 'image/jpeg' : 'image/jpeg');
      const fallbackExt =
        mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
      const fileName =
        resolvedFileName ||
        (kind === 'photo'
          ? order.photoFileName || `${order.reference}_photo.${fallbackExt}`
          : order.receiptFileName || `${order.reference}_receipt.${fallbackExt}`);
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

  const handleRetryMetaPurchase = async (reference: string) => {
    if (!authToken) return;
    setRetryingMetaRef(reference);
    setDashboardError(null);
    setActionFeedback(null);
    try {
      const res = await fetch(
        `/api/admin/orders/${encodeURIComponent(reference)}/retry-meta-purchase`,
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
      if (data.metaTracking) {
        setDiagnostics(prev => (prev ? { ...prev, metaTracking: data.metaTracking } : prev));
      }
      if (res.ok && data.success) {
        setActionFeedback(
          `Meta Conversions API Purchase event delivered for paid order ${reference} (deduplicated via purchase_${reference}).`
        );
      } else {
        setDashboardError(
          data.error ||
            `Could not deliver Meta Purchase event for ${reference}. The order remains confirmed as Paid.`
        );
      }
    } catch {
      setDashboardError(
        `Network error while retrying Meta Purchase event for ${reference}. The order remains confirmed as Paid.`
      );
    } finally {
      setRetryingMetaRef(null);
    }
  };

  const handleVerifyMetaConnection = async () => {
    if (!authToken) return;
    setTestingMetaConnection(true);
    setDashboardError(null);
    setActionFeedback(null);
    try {
      const res = await fetch('/api/admin/meta-capi/verify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      const data = await res.json();
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (data.metaTracking) {
        setDiagnostics(prev => (prev ? { ...prev, metaTracking: data.metaTracking } : prev));
      }
      if (res.ok && data.success) {
        setActionFeedback(data.message || 'Meta Conversions API connection verified.');
      } else {
        setDashboardError(
          data.message || data.error || 'Could not verify Meta Conversions API connection.'
        );
      }
    } catch {
      setDashboardError('Network error while checking Meta Conversions API connection.');
    } finally {
      setTestingMetaConnection(false);
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
      setDashboardError('Enter valid non-negative MYR amounts for Malaysia delivery rates.');
      return;
    }

    let sgDeliveryVal: number | null = null;
    if (singaporeSgd.trim() !== '') {
      const parsedSg = Math.round(Number.parseFloat(singaporeSgd) * 100);
      if (!Number.isFinite(parsedSg) || parsedSg < 0 || parsedSg > 100000) {
        setDashboardError(
          'Enter a valid non-negative SGD amount for Singapore delivery, or leave blank to disable Singapore shipping.'
        );
        return;
      }
      sgDeliveryVal = parsedSg;
    }

    const sgKcVal = Math.round(Number.parseFloat(sgKeychainSgd) * 100);
    const sgMagVal = Math.round(Number.parseFloat(sgMagnetSgd) * 100);
    if (!Number.isFinite(sgKcVal) || sgKcVal < 50 || !Number.isFinite(sgMagVal) || sgMagVal < 50) {
      setDashboardError('Enter valid SGD product prices (minimum S$ 0.50) for Singapore.');
      return;
    }

    const pfMyVal = Math.round(Number.parseFloat(pfPriceMyRm) * 100);
    const pfSgVal = Math.round(Number.parseFloat(pfPriceSgSgd) * 100);
    const pfPenVal = Math.round(Number.parseFloat(pfPeninsularRm) * 100);
    const pfEastVal = Math.round(Number.parseFloat(pfEastRm) * 100);
    const pfDaysVal = Number.parseInt(pfDeliveryDays, 10);

    if (!Number.isFinite(pfMyVal) || pfMyVal < 200 || pfMyVal > 500000) {
      setDashboardError('Portrait Frame Malaysia price must be between RM 2.00 and RM 5,000.00.');
      return;
    }
    if (!Number.isFinite(pfSgVal) || pfSgVal < 50 || pfSgVal > 500000) {
      setDashboardError('Portrait Frame Singapore price must be between S$ 0.50 and S$ 5,000.00.');
      return;
    }
    if (
      !Number.isFinite(pfPenVal) ||
      pfPenVal < 0 ||
      pfPenVal > 100000 ||
      !Number.isFinite(pfEastVal) ||
      pfEastVal < 0 ||
      pfEastVal > 100000
    ) {
      setDashboardError('Enter valid non-negative MYR amounts for Portrait Frame Malaysia delivery.');
      return;
    }

    let pfSgDeliveryVal: number | null = null;
    if (pfSingaporeSgd.trim() !== '') {
      const parsedPfSg = Math.round(Number.parseFloat(pfSingaporeSgd) * 100);
      if (!Number.isFinite(parsedPfSg) || parsedPfSg < 0 || parsedPfSg > 100000) {
        setDashboardError(
          'Enter a valid non-negative SGD amount for Portrait Frame Singapore delivery, or leave blank to disable.'
        );
        return;
      }
      pfSgDeliveryVal = parsedPfSg;
    }

    if (!Number.isInteger(pfDaysVal) || pfDaysVal < 1 || pfDaysVal > 90) {
      setDashboardError('Portrait Frame delivery timeframe must be between 1 and 90 days.');
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
        },
        deliveryRateSingaporeCents: sgDeliveryVal,
        sgProductPricesCents: {
          keychain: sgKcVal,
          magnet: sgMagVal
        },
        portraitFrameConfig: {
          priceMySen: pfMyVal,
          priceSgCents: pfSgVal,
          deliveryPeninsularSen: pfPenVal,
          deliveryEastMalaysiaSen: pfEastVal,
          deliverySingaporeCents: pfSgDeliveryVal,
          deliveryDays: pfDaysVal
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

  // Sales Report aggregation (strictly separated by currency MYR vs SGD and product category)
  const salesReportCategories = [
    { key: 'keychain', label: 'Custom Keychain' },
    { key: 'magnet', label: 'Custom Fridge Magnet' },
    { key: 'bundle', label: '2-Piece Bundle' },
    { key: PORTRAIT_FRAME_PRODUCT_ID, label: 'Custom Portrait Frame' }
  ] as const;

  const salesReport = salesReportCategories.map(cat => {
    const catOrders = orders.filter(o => o.productId === cat.key);
    const catPaid = catOrders.filter(o => o.paymentStatus === 'Paid');
    const paidMyrMinor = catPaid
      .filter(o => (o.currency || (o.deliveryCountry === 'SG' ? 'SGD' : 'MYR')) === 'MYR')
      .reduce((sum, o) => sum + o.totalSen, 0);
    const paidSgdMinor = catPaid
      .filter(o => (o.currency || (o.deliveryCountry === 'SG' ? 'SGD' : 'MYR')) === 'SGD')
      .reduce((sum, o) => sum + o.totalSen, 0);
    return {
      ...cat,
      totalOrders: catOrders.length,
      paidOrders: catPaid.length,
      paidMyrMinor,
      paidSgdMinor
    };
  });

  const totalPaidMyrMinor = salesReport.reduce((sum, r) => sum + r.paidMyrMinor, 0);
  const totalPaidSgdMinor = salesReport.reduce((sum, r) => sum + r.paidSgdMinor, 0);
  const totalPaidMyOrders = orders.filter(
    o => o.paymentStatus === 'Paid' && (o.currency || (o.deliveryCountry === 'SG' ? 'SGD' : 'MYR')) === 'MYR'
  ).length;
  const totalPaidSgOrders = orders.filter(
    o => o.paymentStatus === 'Paid' && (o.currency || (o.deliveryCountry === 'SG' ? 'SGD' : 'MYR')) === 'SGD'
  ).length;

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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {[diagnostics.tng, diagnostics.duitnow].map(item => (
              <div
                key={item.key}
                className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#14233C]">{item.label}</span>
                  <span className={`font-bold ${item.configured ? 'text-emerald-800' : 'text-amber-800'}`}>
                    {item.configured ? 'Active (MYR)' : 'Disabled'}
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
                <span className="font-bold text-[#14233C]">Stripe Card (MYR & SGD)</span>
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
              {diagnostics.stripe.lastCheckoutError && (
                <p className="text-red-700 break-words">
                  Last checkout error ({diagnostics.stripe.lastCheckoutError.code}):{' '}
                  {diagnostics.stripe.lastCheckoutError.message}
                </p>
              )}
            </div>

            {diagnostics.singaporeShipping && (
              <div className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#14233C]">Singapore Shipping (SGD)</span>
                  <span
                    className={`font-bold ${
                      diagnostics.singaporeShipping.configured ? 'text-emerald-800' : 'text-amber-800'
                    }`}
                  >
                    {diagnostics.singaporeShipping.configured &&
                    typeof diagnostics.singaporeShipping.feeCents === 'number'
                      ? formatCurrencyAmount(diagnostics.singaporeShipping.feeCents, 'SGD')
                      : 'Not Configured'}
                  </span>
                </div>
                <p className="text-[#14233C]/70 break-words">
                  {diagnostics.singaporeShipping.configured
                    ? `Source: ${diagnostics.singaporeShipping.source === 'env' ? 'SG_SHIPPING_FEE_CENTS env' : 'Store settings'}. Singapore orders use Stripe Card in SGD only.`
                    : diagnostics.singaporeShipping.issue ||
                      'Set a Singapore delivery fee in Store & QR Settings to enable Singapore checkout.'}
                </p>
              </div>
            )}

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
                <div className="space-y-1">
                  <p className="text-[#14233C]/70 break-words">
                    PostgreSQL & private buckets ({diagnostics.supabase.photosBucket},{' '}
                    {diagnostics.supabase.receiptsBucket}) ready.
                  </p>
                  {diagnostics.supabase.countryPricingSchemaReady === false && (
                    <p className="text-amber-900 font-semibold">
                      Migration needed: run supabase/migrations/002_country_based_pricing.sql to enable Singapore (SGD) persistence.
                    </p>
                  )}
                  {diagnostics.supabase.portraitFrameSchemaReady === false && (
                    <p className="text-amber-900 font-semibold">
                      Migration needed: run supabase/migrations/004_portrait_frame.sql to persist custom Portrait Frame settings and order personalisation text.
                    </p>
                  )}
                </div>
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

            {diagnostics.metaTracking && (
              <div className="p-3.5 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#14233C]">Meta Pixel &amp; CAPI</span>
                  <span
                    className={`font-bold ${
                      diagnostics.metaTracking.capiConnectionStatus === 'connected'
                        ? 'text-emerald-800'
                        : diagnostics.metaTracking.capiConnectionStatus === 'error'
                          ? 'text-red-700'
                          : diagnostics.metaTracking.pixelConfigured
                            ? 'text-amber-800'
                            : 'text-[#14233C]/65'
                    }`}
                  >
                    {diagnostics.metaTracking.capiConnectionStatus === 'connected'
                      ? diagnostics.metaTracking.testMode
                        ? 'Connected (Test)'
                        : 'Connected'
                      : diagnostics.metaTracking.capiConnectionStatus === 'configured'
                        ? diagnostics.metaTracking.testMode
                          ? 'Configured (Test)'
                          : 'Configured'
                        : diagnostics.metaTracking.capiConnectionStatus === 'error'
                          ? 'CAPI Error'
                          : diagnostics.metaTracking.pixelConfigured
                            ? 'Pixel Only'
                            : 'Not Set'}
                  </span>
                </div>
                <p className="text-[#14233C]/70 break-words">
                  Dataset / Pixel ID:{' '}
                  <strong className="font-mono text-[#14233C]">
                    {diagnostics.metaTracking.pixelId || 'Not set'}
                  </strong>
                </p>
                <p className="text-[11px] text-[#14233C]/70 break-words">
                  Test Event Code:{' '}
                  <strong className="text-[#14233C]">
                    {diagnostics.metaTracking.testEventConfigured ? 'Enabled (Test Mode)' : 'Off (Production)'}
                  </strong>
                </p>
                {!diagnostics.metaTracking.schemaReady && (
                  <p className="text-[11px] text-amber-900 font-semibold">
                    Run supabase/migrations/003_meta_conversions.sql to persist CAPI delivery logs.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Dedicated Meta Tracking & Conversions API Diagnostics Panel */}
          {diagnostics.metaTracking && (
            <div className="pt-4 border-t border-[#14233C]/10 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#14233C]" />
                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#14233C]">
                    Meta Tracking Diagnostics (Pixel &amp; Conversions API)
                  </h3>
                </div>
                <button
                  type="button"
                  disabled={testingMetaConnection || !diagnostics.metaTracking.capiConfigured}
                  onClick={handleVerifyMetaConnection}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#14233C]/15 bg-white text-[11px] font-bold text-[#14233C] hover:bg-[#FAF6EE] disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${testingMetaConnection ? 'animate-spin' : ''}`} />
                  <span>{testingMetaConnection ? 'Testing…' : 'Test CAPI Connection'}</span>
                </button>
              </div>

              {/* Explicit 4-Field Diagnostics Summary (NEVER displays CAPI access token) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1">
                  <p className="text-[11px] font-semibold text-[#14233C]/60">Current Pixel / Dataset ID</p>
                  <p className="font-mono font-extrabold text-[#14233C] break-all">
                    {diagnostics.metaTracking.pixelId || 'Not configured'}
                  </p>
                  <p className="text-[11px] text-[#14233C]/65">
                    {diagnostics.metaTracking.pixelConfigured
                      ? 'Shared by browser Pixel & server CAPI (runtime env).'
                      : 'Set META_PIXEL_ID in server environment variables.'}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1">
                  <p className="text-[11px] font-semibold text-[#14233C]/60">CAPI Connection Status</p>
                  <p
                    className={`font-extrabold ${
                      diagnostics.metaTracking.capiConnectionStatus === 'connected'
                        ? 'text-emerald-800'
                        : diagnostics.metaTracking.capiConnectionStatus === 'error'
                          ? 'text-red-700'
                          : diagnostics.metaTracking.capiConnectionStatus === 'configured'
                            ? 'text-[#14233C]'
                            : 'text-amber-800'
                    }`}
                  >
                    {diagnostics.metaTracking.capiConnectionStatus === 'connected'
                      ? 'Connected'
                      : diagnostics.metaTracking.capiConnectionStatus === 'configured'
                        ? 'Configured (Server Token Set)'
                        : diagnostics.metaTracking.capiConnectionStatus === 'error'
                          ? 'Connection Error'
                          : 'Not Configured'}
                  </p>
                  <p className="text-[11px] text-[#14233C]/65 break-words">
                    {diagnostics.metaTracking.capiConnectionMessage}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1">
                  <p className="text-[11px] font-semibold text-[#14233C]/60">Test Event Configuration</p>
                  <p
                    className={`font-extrabold ${
                      diagnostics.metaTracking.testEventConfigured
                        ? 'text-amber-800'
                        : 'text-emerald-800'
                    }`}
                  >
                    {diagnostics.metaTracking.testEventConfigured
                      ? 'Test Mode Enabled'
                      : 'Production Mode (Off)'}
                  </p>
                  <p className="text-[11px] text-[#14233C]/65">
                    {diagnostics.metaTracking.testEventConfigured
                      ? 'META_TEST_EVENT_CODE is active for Events Manager testing.'
                      : 'META_TEST_EVENT_CODE is unset; live events route to production.'}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1">
                  <p className="text-[11px] font-semibold text-[#14233C]/60">Recent Event Delivery</p>
                  <p className="font-extrabold text-[#14233C] tabular-nums">
                    <span className="text-emerald-800">{diagnostics.metaTracking.summary.sent} sent</span>
                    {' · '}
                    <span className={diagnostics.metaTracking.summary.failed > 0 ? 'text-red-700' : 'text-[#14233C]/65'}>
                      {diagnostics.metaTracking.summary.failed} failed
                    </span>
                  </p>
                  <p className="text-[11px] text-[#14233C]/65">
                    Last success:{' '}
                    <strong className="text-[#14233C]">
                      {diagnostics.metaTracking.lastSuccessAt
                        ? new Date(diagnostics.metaTracking.lastSuccessAt).toLocaleString()
                        : 'None yet'}
                    </strong>
                  </p>
                </div>
              </div>

              {diagnostics.metaTracking.issue && (
                <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2">
                  {diagnostics.metaTracking.issue}
                </p>
              )}

              {diagnostics.metaTracking.recentEvents.length === 0 ? (
                <p className="text-xs text-[#14233C]/65">
                  No server-side Meta Purchase events recorded yet. Events are sent automatically only when an order is confirmed Paid via Stripe webhook or staff QR verification.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-[#14233C]/10">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#FAF6EE] text-[#14233C]/70 border-b border-[#14233C]/10">
                        <th className="py-2 px-3 font-bold">Order Ref</th>
                        <th className="py-2 px-3 font-bold">Event ID</th>
                        <th className="py-2 px-3 font-bold">Market / Value</th>
                        <th className="py-2 px-3 font-bold">Status</th>
                        <th className="py-2 px-3 font-bold">Details / Last Attempt</th>
                        <th className="py-2 px-3 font-bold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#14233C]/10 bg-white">
                      {diagnostics.metaTracking.recentEvents.slice(0, 10).map(ev => {
                        const canRetry = ev.status === 'failed' || ev.status === 'not_configured';
                        return (
                          <tr key={ev.eventId} className="align-top">
                            <td className="py-2.5 px-3 font-mono font-bold text-[#14233C] whitespace-nowrap">
                              {ev.orderReference}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[11px] text-[#14233C]/75 whitespace-nowrap">
                              {ev.eventId}
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap tabular-nums">
                              <span className="font-semibold text-[#14233C]">
                                {formatCurrencyAmount(ev.valueMinor, ev.currency)}
                              </span>{' '}
                              <span className="text-[#14233C]/60">({ev.deliveryCountry})</span>
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <span
                                className={`font-bold ${
                                  ev.status === 'sent'
                                    ? 'text-emerald-800'
                                    : ev.status === 'failed'
                                      ? 'text-red-700'
                                      : 'text-amber-800'
                                }`}
                              >
                                {ev.status === 'sent'
                                  ? ev.testMode
                                    ? 'Sent (Test)'
                                    : 'Sent'
                                  : ev.status === 'failed'
                                    ? 'Failed'
                                    : ev.status === 'skipped_consent'
                                      ? 'Opted Out'
                                      : 'Not Configured'}
                              </span>
                              <span className="block text-[11px] text-[#14233C]/55">
                                {ev.attemptCount} {ev.attemptCount === 1 ? 'attempt' : 'attempts'}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-[11px] text-[#14233C]/75 max-w-xs break-words">
                              <div>
                                {ev.sentAt
                                  ? `Delivered ${new Date(ev.sentAt).toLocaleString()}`
                                  : `Last try ${new Date(ev.lastAttemptAt).toLocaleString()}`}
                              </div>
                              {ev.errorMessage && (
                                <div className="text-red-700 mt-0.5">{ev.errorMessage}</div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              {canRetry ? (
                                <button
                                  type="button"
                                  disabled={retryingMetaRef === ev.orderReference}
                                  onClick={() => handleRetryMetaPurchase(ev.orderReference)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#14233C] text-white text-[11px] font-bold hover:bg-[#1e3357] disabled:opacity-60 transition-colors"
                                >
                                  <RefreshCw
                                    className={`w-3 h-3 ${
                                      retryingMetaRef === ev.orderReference ? 'animate-spin' : ''
                                    }`}
                                  />
                                  <span>
                                    {retryingMetaRef === ev.orderReference ? 'Sending…' : 'Retry'}
                                  </span>
                                </button>
                              ) : (
                                <span className="text-[11px] text-[#14233C]/45">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* TAB 1: ORDERS & MANUAL PAYMENT VERIFICATION */}
      {activeTab === 'orders' && (
        <div className="space-y-6">
          {/* Sales Report Summary by Product & Currency */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-[#14233C]">Sales Report (Verified Paid Orders)</h2>
                <p className="text-xs text-[#14233C]/65">
                  Includes Keychains, Fridge Magnets, 2-Piece Bundles, and Custom Portrait Frames — reported separately in MYR and SGD.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <div className="px-3.5 py-2 rounded-xl bg-[#FAF6EE] border border-[#14233C]/10">
                  <span className="text-[#14233C]/60 block text-[10px] font-semibold uppercase tracking-wide">
                    Malaysia Paid ({totalPaidMyOrders})
                  </span>
                  <span className="font-extrabold text-[#14233C] text-sm tabular-nums">
                    {formatCurrencyAmount(totalPaidMyrMinor, 'MYR')}
                  </span>
                </div>
                <div className="px-3.5 py-2 rounded-xl bg-[#FAF6EE] border border-[#14233C]/10">
                  <span className="text-[#14233C]/60 block text-[10px] font-semibold uppercase tracking-wide">
                    Singapore Paid ({totalPaidSgOrders})
                  </span>
                  <span className="font-extrabold text-[#14233C] text-sm tabular-nums">
                    {formatCurrencyAmount(totalPaidSgdMinor, 'SGD')}
                  </span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#14233C]/10 text-[#14233C]/60">
                    <th className="py-2 pr-4 font-bold">Product Category</th>
                    <th className="py-2 px-3 font-bold text-right">All Orders</th>
                    <th className="py-2 px-3 font-bold text-right">Paid Orders</th>
                    <th className="py-2 px-3 font-bold text-right">Paid Revenue (MYR)</th>
                    <th className="py-2 pl-3 font-bold text-right">Paid Revenue (SGD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#14233C]/8">
                  {salesReport.map(row => (
                    <tr key={row.key} className="text-[#14233C]">
                      <td className="py-2.5 pr-4 font-bold">
                        {row.label}
                        {row.key === PORTRAIT_FRAME_PRODUCT_ID && (
                          <span className="ml-2 text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                            {PORTRAIT_FRAME_DIMENSIONS}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-[#14233C]/75">
                        {row.totalOrders}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-emerald-800">
                        {row.paidOrders}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums font-semibold">
                        {formatCurrencyAmount(row.paidMyrMinor, 'MYR')}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums font-semibold">
                        {formatCurrencyAmount(row.paidSgdMinor, 'SGD')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

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

                const orderCountry = order.deliveryCountry || order.customer?.country || 'MY';
                const orderCurrency = order.currency || (orderCountry === 'SG' ? 'SGD' : 'MYR');

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
                            <span className="inline-flex items-center gap-1 font-bold text-[#14233C]">
                              <Globe className="w-3.5 h-3.5 text-[#E05A40]" />
                              <span>
                                {formatCountryLabel(orderCountry)} · {orderCurrency}
                              </span>
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
                            {order.productId === PORTRAIT_FRAME_PRODUCT_ID && (
                              <span className="ml-2 inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-[#14233C] text-amber-200 align-middle">
                                Portrait Frame · {order.deliveryDays ?? 14}d
                              </span>
                            )}
                          </p>
                          {order.personalisationText && (
                            <p className="text-xs font-semibold text-amber-950 bg-amber-50 border border-amber-200/80 rounded-lg px-2.5 py-1 inline-block">
                              Frame Personalisation: &ldquo;{order.personalisationText}&rdquo;
                            </p>
                          )}
                          <p className="text-xs text-[#14233C]/70">
                            {order.customer.email} · {order.customer.mobile} ·{' '}
                            {orderCountry === 'SG'
                              ? `${order.customer.postcode} Singapore`
                              : `${order.customer.postcode} ${order.customer.city}, ${order.customer.state}, Malaysia`}
                          </p>
                          <p className="text-[11px] text-[#14233C]/65 tabular-nums">
                            Items {formatCurrencyAmount(order.subtotalSen, orderCurrency)}
                            {order.savingsSen
                              ? ` (saved ${formatCurrencyAmount(order.savingsSen, orderCurrency)})`
                              : ''}
                            {' + '}Shipping {formatCurrencyAmount(order.deliveryFeeSen, orderCurrency)}
                          </p>
                        </div>
                      </div>

                      <div className="md:text-right shrink-0">
                        <p className="text-[11px] font-semibold text-[#14233C]/60">
                          {isPaid ? `Total Paid (${orderCurrency})` : `Amount Due (${orderCurrency})`}
                        </p>
                        <p className="text-xl font-extrabold tabular-nums text-[#E05A40]">
                          {formatCurrencyAmount(order.totalSen, orderCurrency)}
                        </p>
                        {isPaid && (
                          <>
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
                            <p
                              className={`text-[11px] flex items-center md:justify-end gap-1 mt-0.5 font-semibold ${
                                order.metaPurchaseStatus === 'sent'
                                  ? 'text-emerald-800'
                                  : order.metaPurchaseStatus === 'failed'
                                    ? 'text-red-700'
                                    : 'text-[#14233C]/65'
                              }`}
                            >
                              <Activity className="w-3 h-3 shrink-0" />
                              <span>
                                {order.metaPurchaseStatus === 'sent'
                                  ? order.metaPurchaseTestMode
                                    ? 'Meta CAPI sent (Test)'
                                    : 'Meta CAPI Purchase sent'
                                  : order.metaPurchaseStatus === 'failed'
                                    ? 'Meta CAPI Purchase failed'
                                    : order.metaPurchaseStatus === 'skipped_consent'
                                      ? 'Meta tracking opted out'
                                      : 'Meta CAPI not sent'}
                              </span>
                            </p>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Payment Method, Transaction Reference, Receipt & Actions */}
                    <div className="pt-4 border-t border-[#14233C]/10 grid grid-cols-1 md:grid-cols-12 gap-4 items-center text-xs">
                      <div className="md:col-span-4 space-y-0.5">
                        <p className="text-[#14233C]/60 font-semibold">
                          Payment Method / Currency ({orderCurrency})
                        </p>
                        <p className="text-sm font-extrabold text-[#14233C]">
                          {accountInfo.accountTag}
                        </p>
                        <p className="text-[#14233C]/70">
                          {accountInfo.instruction}
                          {order.latestPaymentCurrency
                            ? ` · Recorded in ${order.latestPaymentCurrency}`
                            : ''}
                        </p>
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

                        {isPaid &&
                          !order.metaPurchaseSentAt &&
                          order.metaPurchaseStatus !== 'skipped_consent' && (
                            <button
                              type="button"
                              disabled={retryingMetaRef === order.reference}
                              onClick={() => handleRetryMetaPurchase(order.reference)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Activity className="w-3.5 h-3.5" />
                              <span>
                                {retryingMetaRef === order.reference
                                  ? 'Sending…'
                                  : order.metaPurchaseStatus === 'failed'
                                    ? 'Retry Meta CAPI'
                                    : 'Send Meta Purchase'}
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
                              {formatCurrencyWithCode(order.totalSen, orderCurrency)}
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

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {(
                [
                  { key: 'keychain', label: 'Keychain Image' },
                  { key: 'magnet', label: 'Fridge Magnet Image' },
                  { key: 'bundle', label: '2-Piece Bundle Image' },
                  { key: 'portrait_frame', label: 'Portrait Frame Image' }
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

          {/* Country-Based Delivery Rates & Regional Product Pricing */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-[#14233C]">
                Delivery Rates & Regional Pricing (MYR & SGD)
              </h2>
              <p className="text-xs text-[#14233C]/70 mt-0.5">
                Delivery country determines authoritative product pricing, currency, and shipping charges on the backend.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Peninsular Malaysia Delivery (MYR)
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
                  Sabah, Sarawak & Labuan Delivery (MYR)
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
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Singapore Delivery Fee (SGD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  placeholder="Leave blank to disable SG"
                  value={singaporeSgd}
                  onChange={e => setSingaporeSgd(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
                <p className="text-[11px] text-[#14233C]/60 mt-1">
                  Leave blank to block Singapore checkout until configured (never falls back to free shipping).
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-[#14233C]/10 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Singapore Keychain Price (SGD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.50"
                  max="1000"
                  required
                  value={sgKeychainSgd}
                  onChange={e => setSgKeychainSgd(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Singapore Fridge Magnet Price (SGD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.50"
                  max="1000"
                  required
                  value={sgMagnetSgd}
                  onChange={e => setSgMagnetSgd(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <p className="sm:col-span-2 text-[11px] text-[#14233C]/65">
                Singapore 2-Piece Bundles automatically receive 20% off these fixed SGD prices. Malaysia keychain &amp; magnet prices remain fixed in MYR (RM 29.90 / RM 31.90).
              </p>
            </div>
          </section>

          {/* Custom Perler Bead Portrait Frame — Separate Pricing, Delivery & Lead Time */}
          <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-[#14233C]">
                  Custom Portrait Frame — Pricing, Delivery &amp; Timeframe
                </h2>
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#14233C] text-amber-200">
                  {PORTRAIT_FRAME_DIMENSIONS} · Wooden Frame Included
                </span>
              </div>
              <p className="text-xs text-[#14233C]/70 mt-1">
                Portrait Frame prices, protective packaging/shipping fees, and delivery lead time are configured independently from keychains and fridge magnets.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Malaysia Price (MYR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="2.00"
                  max="5000"
                  required
                  value={pfPriceMyRm}
                  onChange={e => setPfPriceMyRm(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Singapore Price (SGD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.50"
                  max="5000"
                  required
                  value={pfPriceSgSgd}
                  onChange={e => setPfPriceSgSgd(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Delivery Timeframe (Days)
                </label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="90"
                  required
                  value={pfDeliveryDays}
                  onChange={e => setPfDeliveryDays(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
                <p className="text-[11px] text-[#14233C]/60 mt-1">
                  Initial default is 14 days after payment confirmation.
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-[#14233C]/10 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Portrait Frame — Peninsular MY Delivery (MYR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  required
                  value={pfPeninsularRm}
                  onChange={e => setPfPeninsularRm(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Portrait Frame — Sabah, Sarawak &amp; Labuan (MYR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  required
                  value={pfEastRm}
                  onChange={e => setPfEastRm(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Portrait Frame — Singapore Delivery (SGD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1000"
                  placeholder="Leave blank to disable SG"
                  value={pfSingaporeSgd}
                  onChange={e => setPfSingaporeSgd(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-mono"
                />
                <p className="text-[11px] text-[#14233C]/60 mt-1">
                  Leave blank to disable Singapore shipping for Portrait Frames only.
                </p>
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
