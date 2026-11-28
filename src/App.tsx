/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles,
  Heart,
  Package,
  ShieldCheck,
  ArrowRight,
  Check,
  CheckCircle2,
  Camera,
  Gift,
  Globe,
  ArrowLeft,
  AlertCircle,
  ChevronDown,
  MessageCircle,
  RefreshCw,
  Trash2,
  UploadCloud
} from 'lucide-react';
import PaymentPage from './components/PaymentPage';
import AdminPage from './components/AdminPage';
import HowItWorksSection from './components/HowItWorksSection';
import {
  DELIVERY_PROMISE_TEXT,
  type DeliveryCountry,
  type MerchantPaymentConfig,
  type OrderCustomer,
  type OrderPricingBreakdown,
  type OrderPublic,
  type PaymentMethodKey,
  type PublicStorefrontConfig,
  type SupportedCurrency
} from './types/order';
import {
  COUNTRY_LABELS,
  COUNTRY_UPDATE_NOTICE,
  CURRENCY_NAMES,
  MALAYSIAN_STATES,
  buildMarketPricingConfig,
  calculateAuthoritativeOrderPricing,
  formatCountryLabel,
  formatCurrencyAmount,
  formatCurrencyWithCode,
  getAllowedPaymentMethodsForCountry,
  getCurrencyForCountry,
  validateCustomerDeliveryAddress
} from './shared/pricing';

interface ProductOption {
  id: string;
  name: string;
  priceMinor: number;
  regularMinor?: number;
  savingsMinor?: number;
  description: string;
  badge?: string;
}

interface BundleChoice {
  id: 'bundle_2_keychains' | 'bundle_kc_magnet' | 'bundle_2_magnets';
  name: string;
  priceMinor: number;
  regularMinor: number;
  savingsMinor: number;
  description: string;
}

interface ValidatedDeliveryQuote {
  deliveryCountry: DeliveryCountry;
  currency: SupportedCurrency;
  productName: string;
  itemQuantity: number;
  subtotalMinor: number;
  regularSubtotalMinor: number | null;
  savingsMinor: number | null;
  deliveryZone: string;
  deliveryFeeMinor: number;
  totalMinor: number;
  allowedPaymentMethods: PaymentMethodKey[];
  breakdown: OrderPricingBreakdown;
}

const DEFAULT_STOREFRONT: PublicStorefrontConfig = {
  logoUrl: '/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png',
  heroImageUrl: '/assets/aistudio/From_Photo_to_Perler_Keepsake_40f444e1.png',
  productImages: {
    keychain: '/assets/aistudio/Custom_Perler_Bead_Keychain_Showcase_b07b8ffc.png',
    magnet: '/assets/aistudio/Custom_Family_Perler_Bead_Magnet_c104de68.png',
    bundle: '/assets/aistudio/Custom_Family_Perler_Bead_Bundle_e5569304.png'
  },
  galleryItems: [
    {
      id: 'pet',
      category: 'Pet Portrait',
      title: 'Golden Retriever Buddy',
      description: 'Turned from a smartphone portrait into a vibrant beaded keychain.',
      image: '/src/assets/images/pet_bead_art_1795515646980.jpg',
      tag: 'Popular'
    },
    {
      id: 'couple',
      category: 'Couple Keepsake',
      title: 'Anniversary Memory',
      description: 'Crafted into a charming fridge magnet with pastel cloud and heart details.',
      image: '/src/assets/images/couple_bead_art_1795515653017.jpg',
      tag: 'Best Seller'
    },
    {
      id: 'family',
      category: 'Family Portrait',
      title: 'Weekend Family Outing',
      description: 'Detailed multi-person pixel bead art keepsake mounted in a wooden frame.',
      image: '/src/assets/images/family_bead_art_1795515653155.jpg',
      tag: 'Special Gift'
    }
  ],
  deliveryRatesSen: {
    peninsular: 800,
    eastMalaysia: 1500
  },
  deliveryRateSingaporeCents: null,
  singaporeShippingConfigured: false,
  marketPricing: buildMarketPricingConfig(),
  whatsappSupportNumber: '',
  whatsappUrl: null,
  deliveryPromiseText: DELIVERY_PROMISE_TEXT
};

const FAQS = [
  {
    question: "What kind of photo works best?",
    answer: "Clear lighting, close-up subjects, and good contrast give the best bead art detail! Portraits of pets, couples, and family members with simple backgrounds work wonderfully in Perler beads."
  },
  {
    question: "How do bundles work?",
    answer: "Choose your 2-piece combination and enjoy an automatic 20% discount off the combined regular price. Important note: Both keepsakes in a bundle will be made from the exact same photo."
  },
  {
    question: "How long does delivery take?",
    answer: `${DELIVERY_PROMISE_TEXT} Each piece is meticulously handcrafted bead-by-bead in our Malaysian studio.`
  },
  {
    question: "How are the keychains and magnets made?",
    answer: "We carefully map your photo into custom pixel bead grids, hand-place each Perler bead, and fuse them with professional heat pressing for durable, long-lasting keepsakes."
  }
];

const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
const PHOTO_UPLOAD_TIMEOUT_MS = 90_000;

type PhotoUploadStatus = 'idle' | 'uploading' | 'success' | 'error';

interface ParsedApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  code?: string;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function resolvePhotoMimeType(file: File): 'image/jpeg' | 'image/png' | null {
  const type = (file.type || '').trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/png') return 'image/png';
  const name = (file.name || '').trim().toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return null;
}

function isSafeHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getHttpStatusFallbackError(status: number, fallbackError: string): string {
  if (status === 413) {
    return 'Photo exceeds the 10 MB upload limit. Please choose a smaller JPG or PNG image.';
  }
  if (status === 429) {
    return 'Too many upload attempts right now. Please wait a moment and try again.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'The upload service is temporarily unavailable or timed out. Please retry your upload.';
  }
  return fallbackError;
}

function parseRawApiJson<T extends Record<string, any>>(
  status: number,
  contentType: string,
  rawText: string,
  fallbackError: string
): ParsedApiResult<T> {
  const trimmed = rawText.trim();
  const normalizedCt = (contentType || '').toLowerCase();

  if (!trimmed) {
    return {
      ok: false,
      status,
      data: null,
      error: getHttpStatusFallbackError(
        status,
        'The server returned an empty response while processing your photo. Please try again.'
      )
    };
  }

  if (
    normalizedCt.includes('text/html') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<HTML')
  ) {
    return {
      ok: false,
      status,
      data: null,
      error: getHttpStatusFallbackError(
        status,
        'The server returned an unexpected page response instead of upload data. Please try again.'
      )
    };
  }

  let parsed: T | null = null;
  try {
    parsed = JSON.parse(trimmed) as T;
  } catch {
    return {
      ok: false,
      status,
      data: null,
      error: getHttpStatusFallbackError(
        status,
        'The server returned an incomplete response. Please check your connection and retry.'
      )
    };
  }

  const ok = status >= 200 && status < 300;
  if (!ok) {
    const serverMessage =
      parsed && typeof parsed.error === 'string' && parsed.error.trim()
        ? parsed.error.trim()
        : getHttpStatusFallbackError(status, fallbackError);
    return {
      ok: false,
      status,
      data: parsed,
      error: serverMessage,
      code: typeof parsed?.code === 'string' ? parsed.code : undefined
    };
  }

  return {
    ok: true,
    status,
    data: parsed,
    error: null,
    code: typeof parsed?.code === 'string' ? parsed.code : undefined
  };
}

async function parseApiJsonResponse<T extends Record<string, any>>(
  res: Response,
  fallbackError: string
): Promise<ParsedApiResult<T>> {
  let rawText = '';
  try {
    rawText = await res.text();
  } catch {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: 'Could not read the server response. Please check your internet connection and try again.'
    };
  }
  return parseRawApiJson<T>(
    res.status,
    res.headers.get('content-type') || '',
    rawText,
    fallbackError
  );
}

interface BinaryUploadResult {
  status: number;
  responseText: string;
  contentType: string;
  networkError?: 'network' | 'timeout' | 'aborted';
}

function uploadBinaryWithProgress(params: {
  method: 'PUT' | 'POST';
  url: string;
  file: File;
  contentType: string;
  headers?: Record<string, string>;
  onProgress?: (percent: number) => void;
  timeoutMs?: number;
}): Promise<BinaryUploadResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open(params.method, params.url, true);
    xhr.timeout = params.timeoutMs ?? PHOTO_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', params.contentType);

    if (params.headers) {
      for (const [key, value] of Object.entries(params.headers)) {
        xhr.setRequestHeader(key, value);
      }
    }

    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0 && params.onProgress) {
        const pct = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
        params.onProgress(pct);
      }
    };

    xhr.onload = () => {
      resolve({
        status: xhr.status,
        responseText: typeof xhr.responseText === 'string' ? xhr.responseText : '',
        contentType: xhr.getResponseHeader('content-type') || ''
      });
    };

    xhr.onerror = () => {
      resolve({
        status: 0,
        responseText: '',
        contentType: '',
        networkError: 'network'
      });
    };

    xhr.ontimeout = () => {
      resolve({
        status: 0,
        responseText: '',
        contentType: '',
        networkError: 'timeout'
      });
    };

    xhr.onabort = () => {
      resolve({
        status: 0,
        responseText: '',
        contentType: '',
        networkError: 'aborted'
      });
    };

    xhr.send(params.file);
  });
}

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState<string>('keychain');
  const [selectedBundleId, setSelectedBundleId] = useState<
    'bundle_2_keychains' | 'bundle_kc_magnet' | 'bundle_2_magnets'
  >('bundle_kc_magnet');
  const [browsingCountry, setBrowsingCountry] = useState<DeliveryCountry>('MY');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Flow State: 'sales' | 'upload' | 'details' | 'review' | 'payment' | 'admin'
  const [orderStep, setOrderStep] = useState<'sales' | 'upload' | 'details' | 'review' | 'payment' | 'admin'>('sales');

  // Photo Upload State (stored in private Supabase customer-photos bucket via secure upload session)
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadSessionToken, setUploadSessionToken] = useState<string | null>(null);
  const [uploadedPhotoStoragePath, setUploadedPhotoStoragePath] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadStatus, setUploadStatus] = useState<PhotoUploadStatus>('idle');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadStageLabel, setUploadStageLabel] = useState<string>('');
  const [uploadedFileInfo, setUploadedFileInfo] = useState<{ name: string; sizeBytes: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const activeUploadIdRef = useRef<number>(0);
  const orderSubmitLockRef = useRef<boolean>(false);

  // Customer Details State (delivery country is required and drives pricing/currency/methods)
  const [customer, setCustomer] = useState<OrderCustomer>({
    fullName: '',
    email: '',
    mobile: '',
    address: '',
    postcode: '',
    city: '',
    state: 'Selangor',
    country: 'MY'
  });

  const [validatedQuote, setValidatedQuote] = useState<ValidatedDeliveryQuote | null>(null);
  const [countryPriceUpdatedNotice, setCountryPriceUpdatedNotice] = useState<boolean>(false);
  const [updatedTotalReviewed, setUpdatedTotalReviewed] = useState<boolean>(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [calculatingDelivery, setCalculatingDelivery] = useState<boolean>(false);

  // Saved Order & Payment Page State
  const [submittingOrder, setSubmittingOrder] = useState<boolean>(false);
  const [currentOrder, setCurrentOrder] = useState<OrderPublic | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderErrorCode, setOrderErrorCode] = useState<string | null>(null);
  const [loadingOrderRef, setLoadingOrderRef] = useState<boolean>(false);
  const [orderLookupError, setOrderLookupError] = useState<string | null>(null);
  const [paymentReturnNotice, setPaymentReturnNotice] = useState<'success_pending' | 'cancelled' | 'failed' | null>(null);

  const [storefront, setStorefront] = useState<PublicStorefrontConfig>(DEFAULT_STOREFRONT);
  const [merchantConfig, setMerchantConfig] = useState<MerchantPaymentConfig | null>(null);
  const [merchantConfigLoading, setMerchantConfigLoading] = useState<boolean>(true);
  const [supabaseReady, setSupabaseReady] = useState<boolean>(true);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);

  const fetchOrderByReference = useCallback(
    async (
      ref: string,
      accessToken: string
    ): Promise<{ order: OrderPublic | null; error?: string }> => {
      try {
        const res = await fetch(
          `/api/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(accessToken)}`,
          {
            headers: { 'x-order-token': accessToken }
          }
        );
        const parsed = await parseApiJsonResponse<{ success?: boolean; order?: OrderPublic; error?: string }>(
          res,
          'Could not load your saved order.'
        );
        if (parsed.ok && parsed.data?.success && parsed.data.order) {
          setCurrentOrder(parsed.data.order);
          return { order: parsed.data.order };
        }
        return { order: null, error: parsed.error || 'Could not load your saved order.' };
      } catch {
        return { order: null, error: 'Connection error while loading your order.' };
      }
    },
    []
  );

  // Load saved order (?order=LPK-...&token=...) or staff admin (?view=admin) & fetch storefront/merchant config
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    const paymentStatusParam = params.get('payment');
    const refParam = params.get('order') || params.get('ref');
    const tokenParam = params.get('token') || '';

    if (viewParam === 'admin') {
      setOrderStep('admin');
    } else if (refParam) {
      setLoadingOrderRef(true);
      setOrderLookupError(null);
      if (!tokenParam) {
        setOrderLookupError(
          `Order "${refParam}" requires its full secure order link to view status or upload receipts.`
        );
        setLoadingOrderRef(false);
      } else {
        fetchOrderByReference(refParam, tokenParam)
          .then(({ order, error }) => {
            if (order) {
              if (paymentStatusParam === 'cancelled') {
                setPaymentReturnNotice('cancelled');
              } else if (paymentStatusParam === 'failed') {
                setPaymentReturnNotice('failed');
              } else if (
                paymentStatusParam === 'success' &&
                (order.paymentStatus === 'Awaiting payment' ||
                  order.paymentStatus === 'Receipt correction needed')
              ) {
                setPaymentReturnNotice('success_pending');
              } else {
                setPaymentReturnNotice(null);
              }
              setOrderStep('payment');
            } else {
              setOrderLookupError(
                error ||
                  `We couldn’t find saved order "${refParam}". Please check that you opened your full secure order link.`
              );
            }
          })
          .finally(() => setLoadingOrderRef(false));
      }
    }

    // Fetch editable storefront settings, Supabase readiness & merchant payment options
    fetch('/api/store-config')
      .then(res =>
        parseApiJsonResponse<{
          success?: boolean;
          supabaseReady?: boolean;
          supabaseError?: string | null;
          storefront?: PublicStorefrontConfig;
          merchantConfig?: MerchantPaymentConfig;
        }>(res, 'Failed to load store configuration.')
      )
      .then(parsed => {
        const data = parsed.data;
        if (parsed.ok && data?.success) {
          if (typeof data.supabaseReady === 'boolean') {
            setSupabaseReady(data.supabaseReady);
          }
          setSupabaseError(data.supabaseError || null);
          if (data.storefront) {
            setStorefront({
              ...DEFAULT_STOREFRONT,
              ...data.storefront,
              marketPricing: data.storefront.marketPricing || buildMarketPricingConfig()
            });
          }
          if (data.merchantConfig) {
            setMerchantConfig(data.merchantConfig);
          }
        }
      })
      .catch(err => console.error('Failed to load store config:', err))
      .finally(() => setMerchantConfigLoading(false));
  }, [fetchOrderByReference]);

  // Active display country: browsing market on sales/upload; validated delivery country on details/review
  const activePricingCountry: DeliveryCountry =
    orderStep === 'details' || orderStep === 'review' ? customer.country : browsingCountry;
  const activeCurrency: SupportedCurrency = getCurrencyForCountry(activePricingCountry);
  const activeMarketTable =
    (storefront.marketPricing || buildMarketPricingConfig())[activePricingCountry];

  const bundleChoices: BundleChoice[] = [
    {
      id: 'bundle_2_keychains',
      name: '2 Keychains',
      priceMinor: activeMarketTable.bundles.bundle_2_keychains.priceMinor,
      regularMinor: activeMarketTable.bundles.bundle_2_keychains.regularMinor,
      savingsMinor: activeMarketTable.bundles.bundle_2_keychains.savingsMinor,
      description: `Two handmade bead keychains from the same photo. Save ${formatCurrencyAmount(
        activeMarketTable.bundles.bundle_2_keychains.savingsMinor,
        activeCurrency
      )}!`
    },
    {
      id: 'bundle_kc_magnet',
      name: '1 Keychain + 1 Fridge Magnet',
      priceMinor: activeMarketTable.bundles.bundle_kc_magnet.priceMinor,
      regularMinor: activeMarketTable.bundles.bundle_kc_magnet.regularMinor,
      savingsMinor: activeMarketTable.bundles.bundle_kc_magnet.savingsMinor,
      description: `One keychain and one fridge magnet from the same photo. Save ${formatCurrencyAmount(
        activeMarketTable.bundles.bundle_kc_magnet.savingsMinor,
        activeCurrency
      )}!`
    },
    {
      id: 'bundle_2_magnets',
      name: '2 Fridge Magnets',
      priceMinor: activeMarketTable.bundles.bundle_2_magnets.priceMinor,
      regularMinor: activeMarketTable.bundles.bundle_2_magnets.regularMinor,
      savingsMinor: activeMarketTable.bundles.bundle_2_magnets.savingsMinor,
      description: `Two fridge magnets with strong neodymium backing. Save ${formatCurrencyAmount(
        activeMarketTable.bundles.bundle_2_magnets.savingsMinor,
        activeCurrency
      )}!`
    }
  ];

  // Products config dynamically driven by active market pricing
  const products: ProductOption[] = [
    {
      id: 'keychain',
      name: 'Keychain',
      priceMinor: activeMarketTable.products.keychain,
      description: 'Handcrafted bead keychain with secure metal ring. Perfect for bags, keys, and lanyards.'
    },
    {
      id: 'magnet',
      name: 'Fridge Magnet',
      priceMinor: activeMarketTable.products.magnet,
      description: 'Handcrafted bead magnet with strong neodymium magnet backing for refrigerators and magnetic boards.'
    },
    {
      id: 'bundle',
      name: '2-Piece Bundle',
      priceMinor:
        bundleChoices.find(b => b.id === selectedBundleId)?.priceMinor ||
        activeMarketTable.bundles.bundle_kc_magnet.priceMinor,
      regularMinor:
        bundleChoices.find(b => b.id === selectedBundleId)?.regularMinor ||
        activeMarketTable.bundles.bundle_kc_magnet.regularMinor,
      savingsMinor:
        bundleChoices.find(b => b.id === selectedBundleId)?.savingsMinor ||
        activeMarketTable.bundles.bundle_kc_magnet.savingsMinor,
      description: 'Save 20% on a pair! Choose 2 keychains, 2 magnets, or a mixed pairing.',
      badge: 'Save 20%'
    }
  ];

  const currentProduct = products.find(p => p.id === selectedProductId) || products[0];
  const activeBundle = bundleChoices.find(b => b.id === selectedBundleId);

  const activePriceMinor =
    selectedProductId === 'bundle' && activeBundle
      ? activeBundle.priceMinor
      : currentProduct.priceMinor;
  const activeRegularMinor =
    selectedProductId === 'bundle' && activeBundle ? activeBundle.regularMinor : undefined;
  const activeSavingsMinor =
    selectedProductId === 'bundle' && activeBundle ? activeBundle.savingsMinor : undefined;

  // Live checkout pricing preview (recalculates immediately on delivery country/state change)
  const liveCheckoutEstimate = calculateAuthoritativeOrderPricing({
    country: customer.country,
    productId: selectedProductId,
    bundleId: selectedProductId === 'bundle' ? selectedBundleId : undefined,
    state: customer.country === 'MY' ? customer.state : 'Singapore',
    deliveryRates: {
      peninsularSen: storefront.deliveryRatesSen.peninsular,
      eastMalaysiaSen: storefront.deliveryRatesSen.eastMalaysia,
      singaporeCents: storefront.deliveryRateSingaporeCents
    },
    sgProductPricesCents: storefront.marketPricing?.SG?.products
  });

  const scrollToSelector = () => {
    const el = document.getElementById('product-selector');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleStartOrder = () => {
    setCustomer(prev => {
      if (browsingCountry === 'SG') {
        return {
          ...prev,
          country: 'SG',
          postcode: prev.country !== 'SG' ? '' : prev.postcode,
          city: 'Singapore',
          state: 'Singapore'
        };
      }
      return {
        ...prev,
        country: 'MY',
        postcode: prev.country !== 'MY' ? '' : prev.postcode,
        city: prev.city === 'Singapore' ? '' : prev.city,
        state: prev.state && prev.state !== 'Singapore' ? prev.state : 'Selangor'
      };
    });
    setValidatedQuote(null);
    setCountryPriceUpdatedNotice(false);
    setUpdatedTotalReviewed(false);
    setDeliveryError(null);
    setOrderError(null);
    setOrderErrorCode(null);
    setOrderStep('upload');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeliveryCountryChange = (nextCountry: DeliveryCountry) => {
    if (nextCountry === customer.country) return;
    setCustomer(prev => {
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
    setValidatedQuote(null);
    setDeliveryError(null);
    setOrderError(null);
    setOrderErrorCode(null);
    setCountryPriceUpdatedNotice(true);
    setUpdatedTotalReviewed(false);
  };

  const ensureUploadSession = async (forceNew = false): Promise<string> => {
    if (!forceNew && uploadSessionToken) return uploadSessionToken;
    let res: Response;
    try {
      res = await fetch('/api/photo-upload-session', { method: 'POST' });
    } catch {
      throw new Error('Could not reach the server to start your photo upload. Please check your connection and try again.');
    }
    const parsed = await parseApiJsonResponse<{
      success?: boolean;
      uploadSessionToken?: string;
      error?: string;
    }>(res, 'Could not start a secure photo upload session.');

    if (parsed.ok && parsed.data?.success && parsed.data.uploadSessionToken) {
      setUploadSessionToken(parsed.data.uploadSessionToken);
      return parsed.data.uploadSessionToken;
    }
    throw new Error(parsed.error || 'Could not start a secure photo upload session.');
  };

  const uploadSelectedPhoto = async (file: File) => {
    const uploadId = activeUploadIdRef.current + 1;
    activeUploadIdRef.current = uploadId;
    const isCurrent = () => activeUploadIdRef.current === uploadId;

    const mimeType = resolvePhotoMimeType(file);
    if (!mimeType) {
      setUploadedPhotoStoragePath(null);
      setUploadedFileInfo(null);
      setUploadStatus('error');
      setUploadProgress(0);
      setUploadError('Please upload a clear JPG or PNG image.');
      setUploading(false);
      return;
    }

    if (file.size <= 0) {
      setUploadedPhotoStoragePath(null);
      setUploadedFileInfo(null);
      setUploadStatus('error');
      setUploadProgress(0);
      setUploadError('The selected photo file appears to be empty. Please choose another JPG or PNG image.');
      setUploading(false);
      return;
    }

    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      setUploadedPhotoStoragePath(null);
      setUploadedFileInfo(null);
      setUploadStatus('error');
      setUploadProgress(0);
      setUploadError('Photo must be smaller than 10 MB.');
      setUploading(false);
      return;
    }

    setUploading(true);
    setUploadStatus('uploading');
    setUploadProgress(5);
    setUploadStageLabel('Starting secure upload…');
    setUploadError(null);
    setUploadedPhotoStoragePath(null);
    setUploadedFileInfo(null);

    try {
      let sessionTok = await ensureUploadSession(false);
      if (!isCurrent()) return;
      setUploadProgress(12);
      setUploadStageLabel('Authorising private storage upload…');

      // Step 1: Request a short-lived backend-authorised Supabase signed upload URL
      const requestSignedUrl = async (tok: string) => {
        const res = await fetch('/api/upload-photo-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-upload-session': tok
          },
          body: JSON.stringify({
            uploadSessionToken: tok,
            filename: file.name,
            mimeType,
            sizeBytes: file.size
          })
        });
        return parseApiJsonResponse<{
          success?: boolean;
          uploadSessionToken?: string;
          uploadIntentToken?: string;
          signedUploadUrl?: string;
          photoStoragePath?: string;
          fileName?: string;
          error?: string;
          code?: string;
        }>(res, 'Could not authorise secure photo upload.');
      };

      let signedResult = await requestSignedUrl(sessionTok);
      if (!isCurrent()) return;

      if (signedResult.status === 401) {
        sessionTok = await ensureUploadSession(true);
        if (!isCurrent()) return;
        signedResult = await requestSignedUrl(sessionTok);
        if (!isCurrent()) return;
      }

      // Immediately surface deterministic client validation errors (type / size / rate limit)
      if (
        !signedResult.ok &&
        signedResult.status >= 400 &&
        signedResult.status < 500 &&
        signedResult.status !== 404
      ) {
        throw new Error(signedResult.error || 'Photo upload was rejected.');
      }

      let directUploadSucceeded = false;
      let directUploadFailureReason: string | null = null;

      if (
        signedResult.ok &&
        signedResult.data?.success &&
        signedResult.data.signedUploadUrl &&
        signedResult.data.photoStoragePath &&
        isSafeHttpsUrl(signedResult.data.signedUploadUrl)
      ) {
        setUploadStageLabel('Uploading photo directly to private storage…');
        setUploadProgress(15);

        const putResult = await uploadBinaryWithProgress({
          method: 'PUT',
          url: signedResult.data.signedUploadUrl,
          file,
          contentType: mimeType,
          onProgress: pct => {
            if (!isCurrent()) return;
            setUploadProgress(Math.min(88, 15 + Math.round(pct * 0.73)));
          }
        });
        if (!isCurrent()) return;

        if (!putResult.networkError && putResult.status >= 200 && putResult.status < 300) {
          setUploadStageLabel('Verifying uploaded photo…');
          setUploadProgress(92);

          const confirmRes = await fetch('/api/upload-photo/confirm', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-upload-session': sessionTok
            },
            body: JSON.stringify({
              uploadSessionToken: sessionTok,
              photoStoragePath: signedResult.data.photoStoragePath,
              uploadIntentToken: signedResult.data.uploadIntentToken
            })
          });
          const confirmParsed = await parseApiJsonResponse<{
            success?: boolean;
            uploadSessionToken?: string;
            photoStoragePath?: string;
            fileName?: string;
            sizeBytes?: number;
            error?: string;
          }>(confirmRes, 'Could not verify your uploaded photo.');
          if (!isCurrent()) return;

          if (confirmParsed.ok && confirmParsed.data?.success && confirmParsed.data.photoStoragePath) {
            if (confirmParsed.data.uploadSessionToken) {
              setUploadSessionToken(confirmParsed.data.uploadSessionToken);
            }
            setUploadedPhotoStoragePath(confirmParsed.data.photoStoragePath);
            setUploadedFileInfo({
              name: confirmParsed.data.fileName || file.name,
              sizeBytes: confirmParsed.data.sizeBytes || file.size
            });
            setUploadProgress(100);
            setUploadStageLabel('Photo uploaded securely');
            setUploadStatus('success');
            setUploading(false);
            directUploadSucceeded = true;
          } else if (confirmParsed.status >= 400 && confirmParsed.status < 500) {
            throw new Error(confirmParsed.error || 'Uploaded file could not be verified as a valid JPG or PNG image.');
          } else {
            directUploadFailureReason =
              confirmParsed.error || 'Could not verify your uploaded photo. Please tap Retry Upload.';
          }
        } else if (putResult.networkError === 'timeout') {
          directUploadFailureReason =
            'The direct photo upload timed out. Please check your connection and tap Retry Upload.';
        } else if (putResult.networkError) {
          directUploadFailureReason =
            'Network error while uploading directly to private storage. Please check your connection and tap Retry Upload.';
        } else {
          directUploadFailureReason =
            'Direct private storage upload was rejected. Please tap Retry Upload.';
        }
      } else if (!signedResult.ok && signedResult.error) {
        directUploadFailureReason = signedResult.error;
      }

      if (directUploadSucceeded) return;

      // Serverless platforms enforce ~6 MB function request limits: never proxy >4.5 MB files through /api/upload-photo
      const MAX_PROXY_FALLBACK_BYTES = Math.floor(4.5 * 1024 * 1024);
      if (file.size > MAX_PROXY_FALLBACK_BYTES) {
        throw new Error(
          directUploadFailureReason ||
            'Could not complete direct private storage upload for this high-resolution photo. Please check your connection and tap Retry Upload.'
        );
      }

      // Fallback for small photos (<= 4.5 MB): zero-overhead same-origin raw binary upload to /api/upload-photo
      setUploadStageLabel('Uploading photo securely…');
      setUploadProgress(18);

      const postBinaryFallback = async (tok: string) =>
        uploadBinaryWithProgress({
          method: 'POST',
          url: '/api/upload-photo',
          file,
          contentType: mimeType,
          headers: {
            'x-upload-session': tok,
            'x-file-name': encodeURIComponent(file.name)
          },
          onProgress: pct => {
            if (!isCurrent()) return;
            setUploadProgress(Math.min(95, 18 + Math.round(pct * 0.77)));
          }
        });

      let binaryRes = await postBinaryFallback(sessionTok);
      if (!isCurrent()) return;

      if (binaryRes.status === 401) {
        sessionTok = await ensureUploadSession(true);
        if (!isCurrent()) return;
        binaryRes = await postBinaryFallback(sessionTok);
        if (!isCurrent()) return;
      }

      if (binaryRes.networkError === 'timeout') {
        throw new Error('The upload timed out before completing. Please check your connection and tap Retry Upload.');
      }
      if (binaryRes.networkError) {
        throw new Error('Network error while uploading your photo. Please check your connection and tap Retry Upload.');
      }

      const fallbackParsed = parseRawApiJson<{
        success?: boolean;
        uploadSessionToken?: string;
        photoStoragePath?: string;
        fileName?: string;
        sizeBytes?: number;
        error?: string;
      }>(binaryRes.status, binaryRes.contentType, binaryRes.responseText, 'Photo upload failed. Please try again.');

      if (fallbackParsed.ok && fallbackParsed.data?.success && fallbackParsed.data.photoStoragePath) {
        if (fallbackParsed.data.uploadSessionToken) {
          setUploadSessionToken(fallbackParsed.data.uploadSessionToken);
        }
        setUploadedPhotoStoragePath(fallbackParsed.data.photoStoragePath);
        setUploadedFileInfo({
          name: fallbackParsed.data.fileName || file.name,
          sizeBytes: fallbackParsed.data.sizeBytes || file.size
        });
        setUploadProgress(100);
        setUploadStageLabel('Photo uploaded securely');
        setUploadStatus('success');
        setUploading(false);
      } else {
        throw new Error(fallbackParsed.error || directUploadFailureReason || 'Photo upload failed. Please try again.');
      }
    } catch (err: any) {
      if (!isCurrent()) return;
      setUploadedPhotoStoragePath(null);
      setUploadedFileInfo(null);
      setUploadStatus('error');
      setUploadProgress(0);
      setUploadStageLabel('');
      setUploadError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not upload your photo right now. Please tap Retry Upload.'
      );
      setUploading(false);
    }
  };

  // Handle Photo File Selection & Upload into private Supabase customer-photos bucket
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset input value so re-selecting the same photo always triggers onChange
    e.target.value = '';
    if (!file) return;

    const mimeType = resolvePhotoMimeType(file);
    if (!mimeType) {
      setUploadError('Please upload a clear JPG or PNG image.');
      return;
    }
    if (file.size <= 0) {
      setUploadError('The selected photo file appears to be empty. Please choose another image.');
      return;
    }
    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      setUploadError('Photo must be smaller than 10 MB.');
      return;
    }

    if (photoPreview && photoPreview.startsWith('blob:')) {
      URL.revokeObjectURL(photoPreview);
    }
    setUploadError(null);
    setPhotoFile(file);
    const localPreview = URL.createObjectURL(file);
    setPhotoPreview(localPreview);
    void uploadSelectedPhoto(file);
  };

  const handleRetryUpload = () => {
    if (!photoFile || uploading) return;
    void uploadSelectedPhoto(photoFile);
  };

  const handleRemovePhoto = () => {
    activeUploadIdRef.current += 1;
    if (photoPreview && photoPreview.startsWith('blob:')) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(null);
    setPhotoPreview(null);
    setUploadedPhotoStoragePath(null);
    setUploadedFileInfo(null);
    setUploading(false);
    setUploadStatus('idle');
    setUploadProgress(0);
    setUploadStageLabel('');
    setUploadError(null);
  };

  // Validate Country-Specific Delivery Address & Fetch Authoritative Quote
  const handleValidateDeliveryAndContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeliveryError(null);
    setOrderError(null);

    const clientCheck = validateCustomerDeliveryAddress(customer, {
      requireContactFields: true
    });
    if (!clientCheck.valid || !clientCheck.normalized) {
      setDeliveryError(clientCheck.error || 'Please check your delivery address details.');
      return;
    }

    const normalizedCustomer = clientCheck.normalized;
    const expectedCurrency = getCurrencyForCountry(normalizedCustomer.country);

    setCalculatingDelivery(true);
    try {
      const res = await fetch('/api/validate-delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: normalizedCustomer.country,
          state: normalizedCustomer.state,
          postcode: normalizedCustomer.postcode,
          city: normalizedCustomer.city,
          currency: expectedCurrency,
          productId: selectedProductId,
          bundleId: selectedProductId === 'bundle' ? selectedBundleId : undefined
        })
      });
      const parsed = await parseApiJsonResponse<{
        valid?: boolean;
        deliveryCountry?: DeliveryCountry;
        currency?: SupportedCurrency;
        zone?: string;
        deliveryFeeSen?: number;
        allowedPaymentMethods?: PaymentMethodKey[];
        pricing?: OrderPricingBreakdown | null;
        error?: string;
      }>(res, 'Failed to validate delivery rate.');

      if (
        parsed.ok &&
        parsed.data?.valid &&
        parsed.data.deliveryCountry &&
        parsed.data.currency &&
        parsed.data.pricing
      ) {
        const breakdown = parsed.data.pricing;
        const nextQuote: ValidatedDeliveryQuote = {
          deliveryCountry: parsed.data.deliveryCountry,
          currency: parsed.data.currency,
          productName: breakdown.productName,
          itemQuantity: breakdown.itemQuantity,
          subtotalMinor: breakdown.unitSubtotalMinor,
          regularSubtotalMinor: breakdown.regularSubtotalMinor,
          savingsMinor: breakdown.bundleSavingsMinor,
          deliveryZone: breakdown.deliveryZone,
          deliveryFeeMinor: breakdown.deliveryFeeMinor,
          totalMinor: breakdown.totalMinor,
          allowedPaymentMethods:
            parsed.data.allowedPaymentMethods ||
            getAllowedPaymentMethodsForCountry(parsed.data.deliveryCountry),
          breakdown
        };

        setCustomer(normalizedCustomer);
        setValidatedQuote(nextQuote);
        if (nextQuote.deliveryCountry !== browsingCountry) {
          setCountryPriceUpdatedNotice(true);
          setUpdatedTotalReviewed(false);
        }
        setCalculatingDelivery(false);
        setOrderStep('review');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setDeliveryError(parsed.error || 'Invalid delivery address or country.');
        setCalculatingDelivery(false);
      }
    } catch {
      setDeliveryError('Failed to validate delivery rate. Please try again.');
      setCalculatingDelivery(false);
    }
  };

  // Create Order and Proceed to Payment Page (backend computes authoritative pricing & handles idempotent retries)
  const handleConfirmAndCreateOrder = async () => {
    if (orderSubmitLockRef.current) return;

    if (countryPriceUpdatedNotice && !updatedTotalReviewed) {
      setOrderError('Please confirm that you have reviewed the updated total before proceeding to payment.');
      setOrderErrorCode(null);
      return;
    }

    const clientCheck = validateCustomerDeliveryAddress(customer, {
      requireContactFields: true
    });
    if (!clientCheck.valid || !clientCheck.normalized) {
      setOrderError(clientCheck.error || 'Please verify your delivery address details.');
      setOrderErrorCode(null);
      return;
    }

    orderSubmitLockRef.current = true;
    setSubmittingOrder(true);
    setOrderError(null);
    setOrderErrorCode(null);

    try {
      const targetCountry = clientCheck.normalized.country;
      const targetCurrency = getCurrencyForCountry(targetCountry);

      // If an order was already created in this checkout session, securely resume/update it
      // using its authorised order session instead of creating a duplicate order.
      if (currentOrder?.reference && currentOrder?.accessToken) {
        if (currentOrder.paymentStatus !== 'Awaiting payment') {
          setOrderStep('payment');
          window.history.replaceState(
            {},
            '',
            `/?order=${encodeURIComponent(currentOrder.reference)}&token=${encodeURIComponent(currentOrder.accessToken)}`
          );
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }

        const expectedBundleId = selectedProductId === 'bundle' ? selectedBundleId : undefined;
        const matchesSameSelection =
          currentOrder.productId === selectedProductId &&
          (currentOrder.bundleId || undefined) === expectedBundleId;

        if (matchesSameSelection) {
          const patchRes = await fetch(
            `/api/orders/${encodeURIComponent(currentOrder.reference)}/delivery`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'x-order-token': currentOrder.accessToken
              },
              body: JSON.stringify({
                accessToken: currentOrder.accessToken,
                customer: clientCheck.normalized,
                currency: targetCurrency
              })
            }
          );
          const patchParsed = await parseApiJsonResponse<{
            success?: boolean;
            order?: OrderPublic;
            error?: string;
            code?: string;
          }>(patchRes, 'Could not update your existing order.');

          if (patchParsed.ok && patchParsed.data?.success && patchParsed.data.order) {
            const resumedOrder = patchParsed.data.order;
            setCurrentOrder(resumedOrder);
            setBrowsingCountry(resumedOrder.deliveryCountry);
            setCountryPriceUpdatedNotice(false);
            setUpdatedTotalReviewed(false);
            setPaymentReturnNotice(null);
            setOrderStep('payment');
            window.history.replaceState(
              {},
              '',
              `/?order=${encodeURIComponent(resumedOrder.reference)}&token=${encodeURIComponent(resumedOrder.accessToken)}`
            );
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }

          setOrderError(patchParsed.error || 'Could not update your existing order.');
          setOrderErrorCode(patchParsed.code || null);
          return;
        }
      }

      const res = await fetch('/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: selectedProductId,
          bundleId: selectedProductId === 'bundle' ? selectedBundleId : undefined,
          uploadSessionToken,
          photoStoragePath: uploadedPhotoStoragePath,
          customer: clientCheck.normalized,
          currency: targetCurrency
        })
      });
      const parsed = await parseApiJsonResponse<{
        success?: boolean;
        resumed?: boolean;
        order?: OrderPublic;
        error?: string;
        code?: string;
      }>(res, 'Failed to create order.');

      if (parsed.ok && parsed.data?.success && parsed.data.order) {
        const createdOrder = parsed.data.order;
        setCurrentOrder(createdOrder);
        setBrowsingCountry(createdOrder.deliveryCountry);
        setCountryPriceUpdatedNotice(false);
        setUpdatedTotalReviewed(false);
        setPaymentReturnNotice(null);
        setUploadSessionToken(null);
        setUploadedPhotoStoragePath(null);
        setUploadedFileInfo(null);
        setUploadStatus('idle');
        setUploadProgress(0);
        setUploadStageLabel('');
        setOrderError(null);
        setOrderErrorCode(null);
        setOrderStep('payment');
        window.history.replaceState(
          {},
          '',
          `/?order=${encodeURIComponent(createdOrder.reference)}&token=${encodeURIComponent(createdOrder.accessToken)}`
        );
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // Keep uploadSessionToken & uploadedPhotoStoragePath intact so failed attempts can be retried safely
        setOrderError(parsed.error || 'Failed to create order.');
        setOrderErrorCode(parsed.code || null);
      }
    } catch {
      setOrderError('Server error while saving order. Please try again — your uploaded photo is still attached.');
      setOrderErrorCode(null);
    } finally {
      orderSubmitLockRef.current = false;
      setSubmittingOrder(false);
    }
  };

  const handleRefreshCurrentOrder = useCallback(async () => {
    if (!currentOrder?.reference || !currentOrder?.accessToken) return null;
    const { order } = await fetchOrderByReference(currentOrder.reference, currentOrder.accessToken);
    return order;
  }, [currentOrder?.reference, currentOrder?.accessToken, fetchOrderByReference]);

  const handleReturnHome = () => {
    const leavingCompletedOrder = Boolean(currentOrder);
    setOrderStep('sales');
    setCurrentOrder(null);
    setPaymentReturnNotice(null);
    setOrderLookupError(null);
    setOrderError(null);
    setOrderErrorCode(null);
    if (leavingCompletedOrder) {
      if (photoPreview && photoPreview.startsWith('blob:')) {
        URL.revokeObjectURL(photoPreview);
      }
      setPhotoFile(null);
      setPhotoPreview(null);
      setUploadSessionToken(null);
      setUploadedPhotoStoragePath(null);
      setUploadedFileInfo(null);
      setUploadStatus('idle');
      setUploadProgress(0);
      setUploadStageLabel('');
      setUploadError(null);
      setValidatedQuote(null);
      setCountryPriceUpdatedNotice(false);
      setUpdatedTotalReviewed(false);
    }
    window.history.replaceState({}, '', '/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenAdmin = () => {
    setOrderStep('admin');
    window.history.replaceState({}, '', '/?view=admin');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOpenOrderPaymentFromAdmin = async (reference: string, accessToken: string) => {
    setLoadingOrderRef(true);
    const { order } = await fetchOrderByReference(reference, accessToken);
    setLoadingOrderRef(false);
    if (order) {
      setPaymentReturnNotice(null);
      setOrderStep('payment');
      window.history.replaceState(
        {},
        '',
        `/?order=${encodeURIComponent(order.reference)}&token=${encodeURIComponent(order.accessToken)}`
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF6EE] text-[#14233C] font-sans antialiased selection:bg-[#FF8D76]/30">
      {/* Top Notification Bar */}
      <div className="bg-[#14233C] text-[#FAF6EE] py-2 px-4 text-xs font-medium text-center flex items-center justify-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[#FF8D76] shrink-0" />
        <span>Handmade in Malaysia · {DELIVERY_PROMISE_TEXT}</span>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#FAF6EE]/90 backdrop-blur-md border-b border-[#14233C]/10 px-4 sm:px-8 py-3.5 transition-all">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer" onClick={handleReturnHome}>
            <img
              src={storefront.logoUrl}
              alt="Little Pixel Keepsakes logo"
              className="w-10 h-10 object-contain rounded-xl shadow-sm"
            />
            <span className="font-bold text-lg sm:text-xl tracking-tight text-[#14233C]">
              Little Pixel Keepsakes
            </span>
          </div>

          <div className="text-xs font-semibold text-[#14233C]/75">
            {orderStep === 'sales'
              ? 'Handmade Beaded Art'
              : orderStep === 'admin'
                ? 'Protected Staff Admin'
                : currentOrder?.reference
                  ? `Order ${currentOrder.reference} · ${currentOrder.paymentStatus}`
                  : 'Checkout'}
          </div>
        </div>
      </header>

      {/* Supabase Configuration / Unavailability Notice */}
      {!supabaseReady && supabaseError && orderStep !== 'admin' && (
        <div className="max-w-5xl mx-auto px-4 sm:px-8 pt-6">
          <div
            role="alert"
            className="flex items-start gap-3 p-4 rounded-2xl bg-red-50 border border-red-200 text-xs text-red-950 leading-relaxed"
          >
            <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">Store storage configuration required</p>
              <p>{supabaseError}</p>
            </div>
          </div>
        </div>
      )}

      {/* Saved Order Lookup Loading / Error */}
      {loadingOrderRef && (
        <div className="max-w-3xl mx-auto px-4 sm:px-8 pt-10">
          <div className="bg-white rounded-2xl border border-[#14233C]/12 p-8 text-center text-sm font-medium text-[#14233C]/75">
            Loading your saved order…
          </div>
        </div>
      )}

      {orderLookupError && !loadingOrderRef && (
        <div className="max-w-3xl mx-auto px-4 sm:px-8 pt-6">
          <div
            role="alert"
            className="flex items-center justify-between gap-4 p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950"
          >
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>{orderLookupError}</span>
            </div>
            <button
              type="button"
              onClick={handleReturnHome}
              className="font-bold underline whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* SALES PAGE */}
      {orderStep === 'sales' && (
        <>
          <section className="relative pt-10 pb-16 px-4 sm:px-8 overflow-hidden">
            <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
              <div className="lg:col-span-7 space-y-6 text-center lg:text-left">
                <div className="inline-flex items-center gap-2 bg-[#FF8D76]/15 text-[#E05A40] px-3.5 py-1.5 rounded-full text-xs font-bold tracking-wide uppercase">
                  <Heart className="w-3.5 h-3.5 fill-[#FF8D76]" />
                  <span>Handmade Perler Bead Art</span>
                </div>
                
                <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-[#14233C] leading-[1.1] max-w-2xl mx-auto lg:mx-0">
                  Your favourite photo, turned into bead art.
                </h1>
                
                <p className="text-lg sm:text-xl text-[#14233C]/75 font-medium max-w-xl mx-auto lg:mx-0">
                  Big memories in tiny beads. We transform your cherished moments into custom, tactile keychains and fridge magnets crafted with love in Malaysia.
                </p>

                <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4 pt-2">
                  <button 
                    onClick={scrollToSelector}
                    className="w-full sm:w-auto bg-[#FF8D76] text-[#14233C] font-bold px-8 py-4 rounded-2xl shadow-lg shadow-[#FF8D76]/30 hover:bg-[#ff7b60] active:scale-95 transition-all flex items-center justify-center gap-3 text-base"
                  >
                    <span>Create My Keepsake</span>
                    <ArrowRight className="w-5 h-5" />
                  </button>
                  
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#14233C]/70 px-4 py-3 bg-white/60 rounded-xl border border-[#14233C]/10">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>100% Satisfaction Guarantee</span>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5 relative">
                <div className="relative mx-auto max-w-md lg:max-w-none">
                  <div className="absolute -inset-2 bg-gradient-to-tr from-[#FF8D76]/30 to-[#38BDF8]/30 rounded-3xl blur-xl opacity-70"></div>
                  <div className="relative rounded-3xl overflow-hidden shadow-2xl border-4 border-white bg-white">
                    <img
                      src={storefront.heroImageUrl}
                      alt="Turn your favourite photo into a custom Perler beads keychain"
                      className="w-full h-auto block"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* How It Works Section */}
          <HowItWorksSection onCreateKeepsake={scrollToSelector} />

          {/* Product Selector Section */}
          <section id="product-selector" className="py-16 px-4 sm:px-8 max-w-5xl mx-auto">
            <div className="text-center space-y-3 mb-10">
              <span className="text-xs font-bold uppercase tracking-widest text-[#FF8D76]">Step 1 of Your Order</span>
              <h2 className="text-3xl sm:text-4xl font-extrabold text-[#14233C]">Choose Your Keepsake Style</h2>
              <p className="text-[#14233C]/70 max-w-xl mx-auto text-sm sm:text-base">
                Select your delivery region to view prices in {CURRENCY_NAMES[activeCurrency]}. Final pricing and currency are always enforced by your verified delivery country at checkout.
              </p>

              {/* Market / Currency Switcher (MYR / SGD) */}
              <div className="pt-2 flex flex-col items-center gap-2">
                <div
                  role="group"
                  aria-label="Select browsing delivery country and currency"
                  className="inline-flex items-center gap-1 p-1 rounded-2xl bg-white border border-[#14233C]/15 shadow-sm"
                >
                  {(['MY', 'SG'] as const).map(countryCode => {
                    const isActive = browsingCountry === countryCode;
                    const curr = getCurrencyForCountry(countryCode);
                    return (
                      <button
                        key={countryCode}
                        type="button"
                        onClick={() => setBrowsingCountry(countryCode)}
                        aria-pressed={isActive}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors ${
                          isActive
                            ? 'bg-[#14233C] text-[#FAF6EE]'
                            : 'text-[#14233C]/75 hover:text-[#14233C] hover:bg-[#FAF6EE]'
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          {COUNTRY_LABELS[countryCode]} ({curr})
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] font-medium text-[#14233C]/65">
                  {browsingCountry === 'SG'
                    ? storefront.singaporeShippingConfigured &&
                      typeof storefront.deliveryRateSingaporeCents === 'number'
                      ? `Singapore delivery (${formatCurrencyAmount(storefront.deliveryRateSingaporeCents, 'SGD')} shipping) · Stripe Card payment only`
                      : 'Singapore shipping rate is currently being configured by the shop. Malaysia delivery is available.'
                    : `Malaysia delivery (${formatCurrencyAmount(storefront.deliveryRatesSen.peninsular, 'MYR')} Peninsular / ${formatCurrencyAmount(storefront.deliveryRatesSen.eastMalaysia, 'MYR')} East MY) · TNG, Public Bank QR & Stripe Card`}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {products.map((product) => {
                const isSelected = selectedProductId === product.id;
                return (
                  <div 
                    key={product.id}
                    onClick={() => setSelectedProductId(product.id)}
                    className={`cursor-pointer rounded-3xl p-6 transition-all relative border-2 flex flex-col justify-between ${
                      isSelected 
                        ? 'bg-white border-[#14233C] shadow-xl ring-2 ring-[#14233C]/20 scale-[1.02]' 
                        : 'bg-white/60 border-[#14233C]/15 hover:border-[#14233C]/40 hover:bg-white'
                    }`}
                  >
                    {product.badge && (
                      <span className="absolute -top-3 right-6 bg-[#FF8D76] text-[#14233C] text-xs font-extrabold px-3 py-1 rounded-full shadow-sm">
                        {product.badge}
                      </span>
                    )}

                    <div className="space-y-4">
                      <div className="rounded-2xl overflow-hidden aspect-[4/3] bg-[#FAF6EE] border border-[#14233C]/10">
                        <img
                          src={
                            product.id === 'keychain'
                              ? storefront.productImages.keychain
                              : product.id === 'magnet'
                                ? storefront.productImages.magnet
                                : storefront.productImages.bundle
                          }
                          alt={product.name}
                          className="w-full h-full object-contain"
                        />
                      </div>

                      <div className="flex items-center justify-between">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isSelected ? 'bg-[#14233C] text-[#FAF6EE]' : 'bg-[#14233C]/10 text-[#14233C]'}`}>
                          {product.id === 'keychain' && <Package className="w-5 h-5" />}
                          {product.id === 'magnet' && <Gift className="w-5 h-5" />}
                          {product.id === 'bundle' && <Sparkles className="w-5 h-5" />}
                        </div>
                        <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-[#14233C] bg-[#14233C]' : 'border-gray-300'}`}>
                          {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                        </div>
                      </div>

                      <div>
                        <h3 className="font-extrabold text-xl text-[#14233C]">{product.name}</h3>
                        <p className="text-xs text-[#14233C]/70 mt-1 min-h-[36px]">{product.description}</p>
                      </div>
                    </div>

                    <div className="pt-6 mt-6 border-t border-[#14233C]/10 flex items-baseline justify-between">
                      <span className="text-xs font-semibold text-[#14233C]/60">Price ({activeCurrency})</span>
                      <div className="text-right">
                        <span className="text-2xl font-black text-[#14233C] tabular-nums">
                          {formatCurrencyAmount(product.priceMinor, activeCurrency)}
                        </span>
                        {product.regularMinor && (
                          <div className="text-xs text-emerald-600 font-bold tabular-nums">
                            Save {formatCurrencyAmount(product.savingsMinor || 0, activeCurrency)} (20% OFF)
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {selectedProductId === 'bundle' && (
              <div className="bg-white rounded-3xl p-6 sm:p-8 border-2 border-[#FF8D76] shadow-xl mb-8 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <span className="text-xs font-bold text-[#E05A40] uppercase tracking-wider">Bundle Selection</span>
                    <h3 className="text-xl font-extrabold text-[#14233C]">Choose Your 2-Piece Pairing</h3>
                    <p className="text-xs text-[#14233C]/70 mt-0.5">Both keepsakes will be made from the same photo. 20% discount applied automatically!</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {bundleChoices.map((choice) => {
                    const isBundleSelected = selectedBundleId === choice.id;
                    return (
                      <div
                        key={choice.id}
                        onClick={() => setSelectedBundleId(choice.id)}
                        className={`cursor-pointer rounded-2xl p-4 border-2 transition-all flex flex-col justify-between ${
                          isBundleSelected 
                            ? 'bg-[#FAF6EE] border-[#14233C] shadow-md' 
                            : 'bg-white border-[#14233C]/10 hover:border-[#14233C]/30'
                        }`}
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-sm text-[#14233C]">{choice.name}</span>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isBundleSelected ? 'border-[#14233C] bg-[#14233C]' : 'border-gray-300'}`}>
                              {isBundleSelected && <Check className="w-3 h-3 text-white" />}
                            </div>
                          </div>
                          <p className="text-xs text-[#14233C]/70">{choice.description}</p>
                        </div>

                        <div className="pt-4 mt-4 border-t border-[#14233C]/10 flex items-center justify-between">
                          <span className="text-xs text-emerald-600 font-bold tabular-nums">
                            Save {formatCurrencyAmount(choice.savingsMinor, activeCurrency)}
                          </span>
                          <span className="text-lg font-black text-[#14233C] tabular-nums">
                            {formatCurrencyAmount(choice.priceMinor, activeCurrency)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-[#14233C] text-[#FAF6EE] rounded-3xl p-6 sm:p-8 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-6">
              <div className="space-y-2 text-center sm:text-left">
                <span className="text-xs font-bold text-[#FF8D76] uppercase tracking-wider">
                  Your Keepsake Summary · {formatCountryLabel(browsingCountry)}
                </span>
                <h3 className="text-2xl font-extrabold">
                  {currentProduct.name} {selectedProductId === 'bundle' && activeBundle ? `(${activeBundle.name})` : ''}
                </h3>
                <p className="text-xs sm:text-sm text-[#FAF6EE]/80">
                  {selectedProductId === 'bundle' ? activeBundle?.description : currentProduct.description}
                </p>
              </div>

              <div className="flex flex-col sm:items-end gap-3 w-full sm:w-auto">
                <div className="text-center sm:text-right">
                  <span className="text-xs text-[#FAF6EE]/70 block">Item Subtotal ({activeCurrency})</span>
                  <div className="flex items-baseline justify-center sm:justify-end gap-2">
                    {activeRegularMinor && (
                      <span className="text-sm line-through text-[#FAF6EE]/50 font-semibold tabular-nums">
                        {formatCurrencyAmount(activeRegularMinor, activeCurrency)}
                      </span>
                    )}
                    <span className="text-3xl font-black text-[#FF8D76] tabular-nums">
                      {formatCurrencyAmount(activePriceMinor, activeCurrency)}
                    </span>
                  </div>
                </div>

                <button 
                  onClick={handleStartOrder}
                  className="w-full sm:w-auto bg-[#FF8D76] text-[#14233C] font-extrabold px-8 py-3.5 rounded-2xl shadow-lg hover:bg-[#ff7b60] active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <span>Continue to Order</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </section>

          {/* Gallery Section */}
          <section id="gallery" className="py-16 px-4 sm:px-8 bg-white/50 border-y border-[#14233C]/10">
            <div className="max-w-6xl mx-auto">
              <div className="text-center space-y-3 mb-12">
                <span className="text-xs font-bold uppercase tracking-widest text-[#0284C7]">Gallery</span>
                <h2 className="text-3xl sm:text-4xl font-extrabold text-[#14233C]">From Photo to Bead Art</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {storefront.galleryItems.map((item, idx) => (
                  <div key={item.id || idx} className="bg-[#FAF6EE] rounded-3xl overflow-hidden border border-[#14233C]/10 shadow-lg flex flex-col">
                    <div className="relative aspect-[4/3] overflow-hidden bg-gray-100">
                      <img src={item.image} alt={item.title} className="w-full h-full object-cover" />
                    </div>
                    <div className="p-6 space-y-2">
                      <h3 className="font-extrabold text-xl text-[#14233C]">{item.title}</h3>
                      <p className="text-xs text-[#14233C]/75">{item.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* FAQ Section */}
          <section id="faq" className="py-16 px-4 sm:px-8 max-w-3xl mx-auto">
            <div className="text-center space-y-2 mb-10">
              <span className="text-xs font-bold uppercase tracking-widest text-[#E05A40]">FAQ</span>
              <h2 className="text-3xl font-extrabold text-[#14233C]">Frequently Asked Questions</h2>
            </div>
            <div className="space-y-3">
              {FAQS.map((faq, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div
                    key={faq.question}
                    className="bg-white rounded-2xl border border-[#14233C]/12 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      aria-expanded={isOpen}
                      className="w-full px-6 py-4 text-left flex items-center justify-between gap-4 font-bold text-sm text-[#14233C] hover:bg-[#FAF6EE]/60 transition-colors"
                    >
                      <span>{faq.question}</span>
                      <ChevronDown
                        className={`w-4 h-4 text-[#14233C]/60 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-6 pb-5 text-xs sm:text-sm text-[#14233C]/75 leading-relaxed border-t border-[#14233C]/10 pt-3">
                        {faq.answer}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* CHECKOUT FLOW: UPLOAD */}
      {orderStep === 'upload' && (
        <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
          <button
            type="button"
            onClick={() => setOrderStep('sales')}
            className="text-xs font-bold text-[#14233C] flex items-center gap-1.5 hover:text-[#E05A40]"
          >
            <ArrowLeft className="w-4 h-4" /><span>Back to Keepsakes</span>
          </button>
          <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
            <div className="space-y-1.5">
              <h2 className="text-2xl font-black text-[#14233C]">Upload Your Photo</h2>
              <p className="text-sm text-[#14233C]/70">
                Upload 1 clear JPG or PNG photo (up to 10 MB). Both items in a bundle use the same photo.
              </p>
            </div>

            {!photoPreview ? (
              <label className="border-2 border-dashed border-[#14233C]/25 hover:border-[#E05A40]/60 transition-colors rounded-3xl p-8 sm:p-10 flex flex-col items-center justify-center text-center cursor-pointer bg-[#FAF6EE]/60">
                <div className="w-12 h-12 rounded-2xl bg-[#FF8D76]/15 flex items-center justify-center mb-3">
                  <UploadCloud className="w-6 h-6 text-[#E05A40]" />
                </div>
                <span className="font-bold text-sm text-[#14233C]">Click to choose a photo</span>
                <span className="text-xs text-[#14233C]/60 mt-1">JPG or PNG · Maximum 10 MB · Stored privately</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl overflow-hidden border border-[#14233C]/12 max-w-sm mx-auto aspect-[4/3] bg-[#FAF6EE] relative">
                  <img
                    src={photoPreview}
                    alt="Uploaded photo preview"
                    className="w-full h-full object-contain"
                  />
                  {uploading && (
                    <div className="absolute inset-0 bg-[#14233C]/35 backdrop-blur-[1px] flex items-center justify-center">
                      <div className="bg-white/95 px-4 py-2 rounded-xl shadow-md text-xs font-bold text-[#14233C]">
                        Uploading {uploadProgress}%
                      </div>
                    </div>
                  )}
                </div>

                {photoFile && (
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-[#FAF6EE]/80 border border-[#14233C]/10 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Camera className="w-4 h-4 text-[#E05A40] shrink-0" />
                      <span className="font-semibold text-[#14233C] truncate">
                        {uploadedFileInfo?.name || photoFile.name}
                      </span>
                    </div>
                    <span className="text-[#14233C]/65 font-medium shrink-0">
                      {formatFileSize(uploadedFileInfo?.sizeBytes || photoFile.size)}
                    </span>
                  </div>
                )}

                {/* Live Upload Progress Bar */}
                {uploadStatus === 'uploading' && (
                  <div className="space-y-2 p-4 rounded-2xl bg-[#FAF6EE] border border-[#14233C]/10" aria-live="polite">
                    <div className="flex items-center justify-between text-xs font-bold text-[#14233C]">
                      <span>{uploadStageLabel || 'Uploading photo…'}</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <progress
                      value={Math.max(5, Math.min(100, uploadProgress))}
                      max={100}
                      aria-label={uploadStageLabel || 'Uploading photo'}
                      className="block w-full h-2.5 overflow-hidden rounded-full appearance-none bg-[#14233C]/10 [&::-webkit-progress-bar]:bg-[#14233C]/10 [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:bg-[#E05A40] [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:transition-all [&::-moz-progress-bar]:bg-[#E05A40] [&::-moz-progress-bar]:rounded-full"
                    />
                  </div>
                )}

                {/* Upload Success Confirmation */}
                {uploadStatus === 'success' && uploadedPhotoStoragePath && !uploading && (
                  <div
                    className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs"
                    role="status"
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold">Photo uploaded securely</p>
                      <p className="text-emerald-800/80 mt-0.5">
                        Your photo is saved privately and ready for your keepsake order.
                      </p>
                    </div>
                  </div>
                )}

                {/* Action Buttons: Retry (on failure), Replace Photo, Remove */}
                <div className="flex flex-wrap items-center gap-3">
                  {photoFile && uploadStatus === 'error' && !uploading && (
                    <button
                      type="button"
                      onClick={handleRetryUpload}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#E05A40] text-white rounded-xl text-xs font-bold hover:bg-[#c94c34] transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry Upload</span>
                    </button>
                  )}
                  <label
                    className={`inline-flex items-center gap-1.5 px-4 py-2 bg-[#FAF6EE] border border-[#14233C]/20 rounded-xl text-xs font-bold transition-colors ${
                      uploading ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-[#14233C]/5'
                    }`}
                  >
                    <Camera className="w-3.5 h-3.5 text-[#14233C]/75" />
                    <span>{uploading ? 'Uploading…' : 'Replace Photo'}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                      disabled={uploading}
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-gray-100 rounded-xl text-xs font-bold text-[#14233C]/75 hover:text-[#14233C] hover:bg-gray-200/70 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </button>
                </div>
              </div>
            )}

            {/* Clear Failure Alert */}
            {uploadError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-red-50 border border-red-200 text-red-800 text-xs"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">Photo upload could not be completed</p>
                  <p className="text-red-700 leading-relaxed">{uploadError}</p>
                </div>
              </div>
            )}

            <p className="text-xs text-[#14233C]/65">{DELIVERY_PROMISE_TEXT}</p>

            <button
              type="button"
              disabled={!uploadedPhotoStoragePath || uploading}
              onClick={() => setOrderStep('details')}
              className={`w-full py-4 rounded-2xl font-bold text-sm transition-colors ${
                uploadedPhotoStoragePath && !uploading
                  ? 'bg-[#14233C] text-white hover:bg-[#1c3154]'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {uploading
                ? `Uploading photo (${uploadProgress}%)…`
                : 'Continue to Delivery Details'}
            </button>
          </div>
        </div>
      )}

      {/* CHECKOUT FLOW: DETAILS */}
      {orderStep === 'details' && (
        <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
          <button
            type="button"
            onClick={() => setOrderStep('upload')}
            className="text-xs font-bold text-[#14233C] flex items-center gap-1.5 hover:text-[#E05A40]"
          >
            <ArrowLeft className="w-4 h-4" /><span>Back to Photo Upload</span>
          </button>
          <form onSubmit={handleValidateDeliveryAndContinue} className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
            <div className="space-y-1">
              <h2 className="text-2xl font-black text-[#14233C]">Customer & Delivery Details</h2>
              <p className="text-xs text-[#14233C]/70">
                Your delivery country determines product pricing, currency ({getCurrencyForCountry(customer.country)}), shipping charges, and available payment methods.
              </p>
            </div>

            {countryPriceUpdatedNotice && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-950 text-xs"
              >
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-bold">{COUNTRY_UPDATE_NOTICE}</p>
                  <p className="text-amber-900/85">
                    Prices are now shown in {CURRENCY_NAMES[getCurrencyForCountry(customer.country)]}. Please review the updated total on the next screen before proceeding to payment.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {/* Required Delivery Country Field */}
              <div>
                <label htmlFor="checkout-country" className="block text-xs font-bold text-[#14233C] mb-1.5">
                  Delivery Country <span className="text-[#E05A40]">*</span>
                </label>
                <select
                  id="checkout-country"
                  required
                  value={customer.country}
                  onChange={e => handleDeliveryCountryChange(e.target.value as DeliveryCountry)}
                  className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm font-semibold text-[#14233C] focus:outline-none focus:border-[#14233C]"
                >
                  <option value="MY">Malaysia (MY) — Priced in MYR</option>
                  <option value="SG">Singapore (SG) — Priced in SGD (Stripe Card only)</option>
                </select>
                <p className="text-[11px] text-[#14233C]/65 mt-1">
                  {customer.country === 'SG'
                    ? 'Singapore orders are priced in SGD and support Stripe credit/debit card payment only.'
                    : 'Malaysia orders are priced in MYR and support Touch ’n Go eWallet QR, Public Bank QR Pay, and Stripe Card.'}
                </p>
              </div>

              <div>
                <label htmlFor="checkout-fullname" className="block text-xs font-bold text-[#14233C] mb-1">
                  Full Name
                </label>
                <input
                  id="checkout-fullname"
                  type="text"
                  required
                  value={customer.fullName}
                  onChange={e => setCustomer({ ...customer, fullName: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="checkout-email" className="block text-xs font-bold text-[#14233C] mb-1">
                    Email
                  </label>
                  <input
                    id="checkout-email"
                    type="email"
                    required
                    value={customer.email}
                    onChange={e => setCustomer({ ...customer, email: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                  />
                </div>
                <div>
                  <label htmlFor="checkout-mobile" className="block text-xs font-bold text-[#14233C] mb-1">
                    Mobile Phone
                  </label>
                  <input
                    id="checkout-mobile"
                    type="tel"
                    required
                    placeholder={customer.country === 'SG' ? '+65 9123 4567' : '+60 12-345 6789'}
                    value={customer.mobile}
                    onChange={e => setCustomer({ ...customer, mobile: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="checkout-address" className="block text-xs font-bold text-[#14233C] mb-1">
                  {customer.country === 'SG' ? 'Block, Street Name & Unit Number' : 'Street Address'}
                </label>
                <textarea
                  id="checkout-address"
                  required
                  rows={2}
                  placeholder={
                    customer.country === 'SG'
                      ? 'e.g. Blk 123 Orchard Road, #08-45'
                      : 'e.g. No. 12, Jalan SS15/4'
                  }
                  value={customer.address}
                  onChange={e => setCustomer({ ...customer, address: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                />
              </div>

              {customer.country === 'MY' ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="checkout-postcode" className="block text-xs font-bold text-[#14233C] mb-1">
                      Postcode (5 digits)
                    </label>
                    <input
                      id="checkout-postcode"
                      type="text"
                      inputMode="numeric"
                      pattern="\d{5}"
                      maxLength={5}
                      required
                      placeholder="47500"
                      value={customer.postcode}
                      onChange={e =>
                        setCustomer({
                          ...customer,
                          postcode: e.target.value.replace(/\D/g, '').slice(0, 5)
                        })
                      }
                      className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] font-mono focus:outline-none focus:border-[#14233C]"
                    />
                  </div>
                  <div>
                    <label htmlFor="checkout-city" className="block text-xs font-bold text-[#14233C] mb-1">
                      City
                    </label>
                    <input
                      id="checkout-city"
                      type="text"
                      required
                      placeholder="Subang Jaya"
                      value={customer.city}
                      onChange={e => setCustomer({ ...customer, city: e.target.value })}
                      className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
                    />
                  </div>
                  <div>
                    <label htmlFor="checkout-state" className="block text-xs font-bold text-[#14233C] mb-1">
                      State
                    </label>
                    <select
                      id="checkout-state"
                      required
                      value={customer.state}
                      onChange={e => setCustomer({ ...customer, state: e.target.value })}
                      className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] focus:outline-none focus:border-[#14233C]"
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="checkout-sg-postcode" className="block text-xs font-bold text-[#14233C] mb-1">
                      Singapore Postal Code (6 digits)
                    </label>
                    <input
                      id="checkout-sg-postcode"
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      placeholder="238801"
                      value={customer.postcode}
                      onChange={e =>
                        setCustomer({
                          ...customer,
                          postcode: e.target.value.replace(/\D/g, '').slice(0, 6)
                        })
                      }
                      className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border border-[#14233C]/20 text-sm text-[#14233C] font-mono focus:outline-none focus:border-[#14233C]"
                    />
                  </div>
                  <div>
                    <label htmlFor="checkout-sg-region" className="block text-xs font-bold text-[#14233C] mb-1">
                      City / Region
                    </label>
                    <input
                      id="checkout-sg-region"
                      type="text"
                      readOnly
                      value="Singapore"
                      className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE]/60 border border-[#14233C]/15 text-sm text-[#14233C]/75"
                    />
                  </div>
                </div>
              )}

              {/* Live Recalculated Total Preview */}
              <div className="p-4 rounded-2xl bg-[#FAF6EE] border border-[#14233C]/12 space-y-2 text-xs">
                <div className="flex items-center justify-between font-bold text-[#14233C]">
                  <span>
                    Estimated Order Total ({formatCountryLabel(customer.country)} · {getCurrencyForCountry(customer.country)})
                  </span>
                  {liveCheckoutEstimate.ok && (
                    <span className="text-base font-black text-[#E05A40] tabular-nums">
                      {formatCurrencyAmount(liveCheckoutEstimate.totalMinor, liveCheckoutEstimate.currency)}
                    </span>
                  )}
                </div>

                {liveCheckoutEstimate.ok ? (
                  <div className="space-y-1 text-[#14233C]/75">
                    <div className="flex justify-between">
                      <span>{liveCheckoutEstimate.productName}</span>
                      <span className="tabular-nums font-semibold">
                        {formatCurrencyAmount(liveCheckoutEstimate.subtotalMinor, liveCheckoutEstimate.currency)}
                      </span>
                    </div>
                    {liveCheckoutEstimate.savingsMinor ? (
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <span>Bundle 20% Discount</span>
                        <span className="tabular-nums">
                          - {formatCurrencyAmount(liveCheckoutEstimate.savingsMinor, liveCheckoutEstimate.currency)}
                        </span>
                      </div>
                    ) : null}
                    <div className="flex justify-between">
                      <span>Delivery ({liveCheckoutEstimate.deliveryZone})</span>
                      <span className="tabular-nums font-semibold">
                        {formatCurrencyAmount(liveCheckoutEstimate.deliveryFeeMinor, liveCheckoutEstimate.currency)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div role="alert" className="flex items-start gap-2 text-red-800 font-semibold pt-1">
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <span>{liveCheckoutEstimate.error}</span>
                  </div>
                )}
              </div>

              {deliveryError && (
                <div role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-bold text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{deliveryError}</span>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={calculatingDelivery || !liveCheckoutEstimate.ok}
              className="w-full bg-[#14233C] text-white font-bold py-4 rounded-2xl text-sm hover:bg-[#1e3357] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {calculatingDelivery ? 'Validating delivery & recalculating total…' : 'Review Order & Final Total'}
            </button>
          </form>
        </div>
      )}

      {/* CHECKOUT FLOW: REVIEW */}
      {orderStep === 'review' && (() => {
        const reviewCountry = validatedQuote?.deliveryCountry || customer.country;
        const reviewCurrency = validatedQuote?.currency || getCurrencyForCountry(reviewCountry);
        const reviewProductName =
          validatedQuote?.productName ||
          `${currentProduct.name}${selectedProductId === 'bundle' && activeBundle ? ` (${activeBundle.name})` : ''}`;
        const reviewSubtotal = validatedQuote?.subtotalMinor ?? activePriceMinor;
        const reviewRegular = validatedQuote?.regularSubtotalMinor ?? activeRegularMinor ?? null;
        const reviewSavings = validatedQuote?.savingsMinor ?? activeSavingsMinor ?? null;
        const reviewDeliveryZone =
          validatedQuote?.deliveryZone ||
          (reviewCountry === 'SG' ? 'Singapore' : customer.state);
        const reviewDeliveryFee =
          validatedQuote?.deliveryFeeMinor ??
          (liveCheckoutEstimate.ok ? liveCheckoutEstimate.deliveryFeeMinor : 0);
        const reviewTotal = validatedQuote?.totalMinor ?? reviewSubtotal + reviewDeliveryFee;

        return (
          <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
            <button
              type="button"
              onClick={() => setOrderStep('details')}
              className="text-xs font-bold text-[#14233C] flex items-center gap-1.5 hover:text-[#E05A40]"
            >
              <ArrowLeft className="w-4 h-4" /><span>Back to Delivery Details</span>
            </button>
            <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
              <div className="space-y-1">
                <h2 className="text-2xl font-black text-[#14233C]">Order Summary & Review</h2>
                <p className="text-xs text-[#14233C]/70">
                  Delivery Country: <strong className="text-[#14233C]">{formatCountryLabel(reviewCountry)}</strong>
                  {' · '}
                  Currency: <strong className="text-[#14233C]">{reviewCurrency}</strong>
                </p>
              </div>

              {countryPriceUpdatedNotice && (
                <div
                  role="alert"
                  className="p-4 rounded-2xl bg-amber-50 border border-amber-300 text-amber-950 text-xs space-y-3"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-extrabold">{COUNTRY_UPDATE_NOTICE}</p>
                      <p className="text-amber-900/90 leading-relaxed">
                        All item prices, bundle discounts, and delivery fees have been recalculated for{' '}
                        <strong>{formatCountryLabel(reviewCountry)}</strong> in{' '}
                        <strong>{CURRENCY_NAMES[reviewCurrency]}</strong>.
                      </p>
                    </div>
                  </div>
                  <label className="flex items-start gap-2.5 pt-2 border-t border-amber-200/80 cursor-pointer font-bold text-[#14233C]">
                    <input
                      type="checkbox"
                      checked={updatedTotalReviewed}
                      onChange={e => {
                        setUpdatedTotalReviewed(e.target.checked);
                        setOrderError(null);
                      }}
                      className="mt-0.5 w-4 h-4 accent-[#14233C] rounded"
                    />
                    <span>
                      I have reviewed the updated total of{' '}
                      <span className="tabular-nums text-[#E05A40]">
                        {formatCurrencyWithCode(reviewTotal, reviewCurrency)}
                      </span>{' '}
                      for {COUNTRY_LABELS[reviewCountry]} delivery.
                    </span>
                  </label>
                </div>
              )}

              {photoPreview && (
                <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-[#FAF6EE]/70 border border-[#14233C]/10">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={photoPreview}
                      alt="Selected keepsake photo"
                      className="w-16 h-16 rounded-xl object-cover border border-[#14233C]/10 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-[#14233C]">Uploaded Photo Ready</p>
                      <p className="text-[11px] text-[#14233C]/65 truncate">
                        {photoFile?.name || 'Saved photo'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOrderStep('upload')}
                    className="text-xs font-bold text-[#E05A40] hover:underline whitespace-nowrap shrink-0"
                  >
                    Replace Photo
                  </button>
                </div>
              )}

              <div className="bg-[#FAF6EE] p-5 rounded-2xl space-y-3 text-sm">
                <div className="flex justify-between font-bold text-[#14233C]">
                  <span>{reviewProductName}</span>
                  <span className="tabular-nums">
                    {formatCurrencyAmount(reviewSubtotal, reviewCurrency)}
                  </span>
                </div>
                {reviewRegular && reviewSavings ? (
                  <>
                    <div className="flex justify-between text-xs text-[#14233C]/60">
                      <span>Regular item price</span>
                      <span className="line-through tabular-nums">
                        {formatCurrencyAmount(reviewRegular, reviewCurrency)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-emerald-700">
                      <span>Bundle 20% Discount</span>
                      <span className="tabular-nums">
                        - {formatCurrencyAmount(reviewSavings, reviewCurrency)}
                      </span>
                    </div>
                  </>
                ) : null}
                <div className="flex justify-between text-xs text-[#14233C]/75">
                  <span>Delivery Fee ({reviewDeliveryZone})</span>
                  <span className="tabular-nums font-semibold">
                    {formatCurrencyAmount(reviewDeliveryFee, reviewCurrency)}
                  </span>
                </div>
                <div className="flex justify-between pt-3 border-t border-[#14233C]/12 font-black text-lg text-[#E05A40]">
                  <span>Final Payable Amount ({reviewCurrency})</span>
                  <span className="tabular-nums">
                    {formatCurrencyAmount(reviewTotal, reviewCurrency)}
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#FAF6EE]/60 border border-[#14233C]/10 text-xs text-[#14233C]/80 space-y-1">
                <p className="font-bold text-[#14233C]">Delivery Address & Available Payment Methods</p>
                <p className="font-medium text-[#14233C]">{customer.fullName}</p>
                <p>
                  {customer.address}, {customer.postcode}{' '}
                  {reviewCountry === 'SG'
                    ? 'Singapore'
                    : `${customer.city}, ${customer.state}, Malaysia`}
                </p>
                <p className="pt-1 text-[11px] text-[#14233C]/70">
                  {reviewCountry === 'SG'
                    ? 'Available payment method: Stripe credit/debit card (charged in SGD).'
                    : 'Available payment methods: Touch ’n Go eWallet QR, Public Bank QR Pay, or Stripe credit/debit card (charged in MYR).'}
                </p>
              </div>

              <p className="text-xs text-[#14233C]/70 leading-relaxed">{DELIVERY_PROMISE_TEXT}</p>
              {orderError && (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-bold text-red-700 space-y-2.5"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{orderError}</span>
                  </div>
                  {(orderErrorCode === 'PHOTO_MOVE_FAILED' ||
                    orderErrorCode === 'PHOTO_UPLOAD_REQUIRED' ||
                    orderErrorCode === 'PHOTO_ALREADY_USED') && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {photoFile && orderErrorCode !== 'PHOTO_ALREADY_USED' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setOrderError(null);
                            setOrderErrorCode(null);
                            setOrderStep('upload');
                            void uploadSelectedPhoto(photoFile);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Re-upload Photo</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setOrderError(null);
                            setOrderErrorCode(null);
                            handleRemovePhoto();
                            setOrderStep('upload');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#14233C] text-white text-xs font-bold hover:bg-[#1e3357] transition-colors"
                        >
                          <Camera className="w-3.5 h-3.5" />
                          <span>Upload New Photo</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                disabled={submittingOrder || (countryPriceUpdatedNotice && !updatedTotalReviewed)}
                onClick={handleConfirmAndCreateOrder}
                className="w-full bg-[#FF8D76] text-[#14233C] font-black py-4 rounded-2xl shadow-lg text-sm hover:bg-[#ff7b60] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submittingOrder
                  ? 'Saving Order…'
                  : countryPriceUpdatedNotice && !updatedTotalReviewed
                    ? 'Review Updated Total Above to Continue'
                    : 'Continue to Payment Options'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* PAYMENT & CUSTOMER ORDER STATUS PAGE (LINKED TO SAVED ORDER VIA SECURE TOKEN) */}
      {orderStep === 'payment' && currentOrder && (
        <div className="flex-1">
          <PaymentPage
            order={currentOrder}
            merchantConfig={merchantConfig}
            merchantConfigLoading={merchantConfigLoading}
            singaporeShippingConfigured={storefront.singaporeShippingConfigured}
            whatsappUrl={storefront.whatsappUrl}
            returnNotice={paymentReturnNotice}
            onOrderUpdated={updated => {
              setCurrentOrder(updated);
              setPaymentReturnNotice(null);
            }}
            onRefreshOrder={handleRefreshCurrentOrder}
            onReturnHome={handleReturnHome}
          />
        </div>
      )}

      {/* PROTECTED STAFF ADMIN VIEW */}
      {orderStep === 'admin' && (
        <div className="flex-1">
          <AdminPage
            onBackToShop={handleReturnHome}
            onOpenOrderPayment={handleOpenOrderPaymentFromAdmin}
            onStorefrontUpdated={(nextStorefront, nextMerchant) => {
              setStorefront({
                ...DEFAULT_STOREFRONT,
                ...nextStorefront,
                marketPricing: nextStorefront.marketPricing || buildMarketPricingConfig()
              });
              setMerchantConfig(nextMerchant);
            }}
          />
        </div>
      )}

      {/* Quiet Footer */}
      <footer className="mt-auto border-t border-[#14233C]/10 py-6 px-4 sm:px-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#14233C]/60">
          <span>© {new Date().getFullYear()} Little Pixel Keepsakes · Handmade in Malaysia</span>
          <div className="flex items-center gap-4">
            {storefront.whatsappUrl && (
              <a
                href={storefront.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-semibold text-emerald-800 hover:text-emerald-900 underline"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                <span>WhatsApp Support</span>
              </a>
            )}
            {orderStep !== 'admin' && (
              <button
                type="button"
                onClick={handleOpenAdmin}
                className="font-semibold text-[#14233C]/65 hover:text-[#14233C] underline transition-colors"
              >
                Staff Admin
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
