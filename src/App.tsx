/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  Heart,
  Package,
  ShieldCheck,
  ArrowRight,
  Check,
  Camera,
  Gift,
  ArrowLeft,
  AlertCircle,
  ChevronDown,
  MessageCircle
} from 'lucide-react';
import PaymentPage from './components/PaymentPage';
import AdminPage from './components/AdminPage';
import {
  DELIVERY_PROMISE_TEXT,
  type MerchantPaymentConfig,
  type OrderPublic,
  type PublicStorefrontConfig
} from './types/order';

interface ProductOption {
  id: string;
  name: string;
  priceSen: number;
  regularSen?: number;
  savingsSen?: number;
  description: string;
  badge?: string;
}

interface BundleChoice {
  id: string;
  name: string;
  priceSen: number;
  regularSen: number;
  savingsSen: number;
  description: string;
}

const BUNDLE_CHOICES: BundleChoice[] = [
  {
    id: 'bundle_2_keychains',
    name: '2 Keychains',
    priceSen: 4784,
    regularSen: 5980,
    savingsSen: 1196,
    description: 'Two handmade bead keychains from the same photo. Save RM11.96!'
  },
  {
    id: 'bundle_kc_magnet',
    name: '1 Keychain + 1 Fridge Magnet',
    priceSen: 4944,
    regularSen: 6180,
    savingsSen: 1236,
    description: 'One keychain and one fridge magnet from the same photo. Save RM12.36!'
  },
  {
    id: 'bundle_2_magnets',
    name: '2 Fridge Magnets',
    priceSen: 5104,
    regularSen: 6380,
    savingsSen: 1276,
    description: 'Two fridge magnets with strong neodymium backing. Save RM12.76!'
  }
];

const DEFAULT_STOREFRONT: PublicStorefrontConfig = {
  logoUrl: '/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png',
  heroImageUrl: '/src/assets/images/hero_bead_art_showcase_1795515646405.jpg',
  productImages: {
    keychain: '/src/assets/images/pet_bead_art_1795515646980.jpg',
    magnet: '/src/assets/images/couple_bead_art_1795515653017.jpg',
    bundle: '/src/assets/images/family_bead_art_1795515653155.jpg'
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
  whatsappSupportNumber: '',
  whatsappUrl: null,
  deliveryPromiseText: DELIVERY_PROMISE_TEXT
};

const MALAYSIAN_STATES = [
  'Johor', 'Kedah', 'Kelantan', 'Melaka', 'Negeri Sembilan', 
  'Pahang', 'Perak', 'Perlis', 'Pulau Pinang', 'Sabah', 
  'Sarawak', 'Selangor', 'Terengganu', 'Kuala Lumpur', 'Putrajaya', 'Labuan'
];

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

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState<string>('keychain');
  const [selectedBundleId, setSelectedBundleId] = useState<string>('bundle_kc_magnet');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Flow State: 'sales' | 'upload' | 'details' | 'review' | 'payment' | 'admin'
  const [orderStep, setOrderStep] = useState<'sales' | 'upload' | 'details' | 'review' | 'payment' | 'admin'>('sales');

  // Photo Upload State
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadedPhotoUrl, setUploadedPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Customer Details State
  const [customer, setCustomer] = useState({
    fullName: '',
    email: '',
    mobile: '',
    address: '',
    postcode: '',
    city: '',
    state: 'Selangor'
  });

  const [deliveryFeeSen, setDeliveryFeeSen] = useState<number>(800);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [calculatingDelivery, setCalculatingDelivery] = useState<boolean>(false);

  // Saved Order & Payment Page State
  const [submittingOrder, setSubmittingOrder] = useState<boolean>(false);
  const [currentOrder, setCurrentOrder] = useState<OrderPublic | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [loadingOrderRef, setLoadingOrderRef] = useState<boolean>(false);
  const [orderLookupError, setOrderLookupError] = useState<string | null>(null);
  const [paymentReturnNotice, setPaymentReturnNotice] = useState<'success_pending' | 'cancelled' | 'failed' | null>(null);

  const [storefront, setStorefront] = useState<PublicStorefrontConfig>(DEFAULT_STOREFRONT);
  const [merchantConfig, setMerchantConfig] = useState<MerchantPaymentConfig | null>(null);
  const [merchantConfigLoading, setMerchantConfigLoading] = useState<boolean>(true);

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
        const data = await res.json();
        if (res.ok && data.success && data.order) {
          setCurrentOrder(data.order);
          return { order: data.order as OrderPublic };
        }
        return { order: null, error: data.error };
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

    // Fetch editable storefront settings & independently evaluated merchant payment options
    fetch('/api/store-config')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          if (data.storefront) {
            setStorefront(data.storefront);
            setDeliveryFeeSen(data.storefront.deliveryRatesSen.peninsular);
          }
          if (data.merchantConfig) {
            setMerchantConfig(data.merchantConfig);
          }
        }
      })
      .catch(err => console.error('Failed to load store config:', err))
      .finally(() => setMerchantConfigLoading(false));
  }, [fetchOrderByReference]);

  // Products config
  const products: ProductOption[] = [
    {
      id: 'keychain',
      name: 'Keychain',
      priceSen: 2990,
      description: 'Handcrafted bead keychain with secure metal ring. Perfect for bags, keys, and lanyards.',
    },
    {
      id: 'magnet',
      name: 'Fridge Magnet',
      priceSen: 3190,
      description: 'Handcrafted bead magnet with strong neodymium magnet backing for refrigerators and magnetic boards.',
    },
    {
      id: 'bundle',
      name: '2-Piece Bundle',
      priceSen: BUNDLE_CHOICES.find(b => b.id === selectedBundleId)?.priceSen || 4944,
      regularSen: BUNDLE_CHOICES.find(b => b.id === selectedBundleId)?.regularSen || 6180,
      savingsSen: BUNDLE_CHOICES.find(b => b.id === selectedBundleId)?.savingsSen || 1236,
      description: 'Save 20% on a pair! Choose 2 keychains, 2 magnets, or a mixed pairing.',
      badge: 'Save 20%'
    }
  ];

  const currentProduct = products.find(p => p.id === selectedProductId) || products[0];
  const activeBundle = BUNDLE_CHOICES.find(b => b.id === selectedBundleId);

  const activePriceSen = selectedProductId === 'bundle' && activeBundle ? activeBundle.priceSen : currentProduct.priceSen;
  const activeRegularSen = selectedProductId === 'bundle' && activeBundle ? activeBundle.regularSen : undefined;
  const activeSavingsSen = selectedProductId === 'bundle' && activeBundle ? activeBundle.savingsSen : undefined;
  const itemQuantity = selectedProductId === 'bundle' ? 2 : 1;

  const formatRM = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

  const scrollToSelector = () => {
    const el = document.getElementById('product-selector');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleStartOrder = () => {
    setOrderStep('upload');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Handle Photo File Upload
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setUploadError('Please upload a clear JPG or PNG image.');
      return;
    }

    if (photoPreview && photoPreview.startsWith('blob:')) {
      URL.revokeObjectURL(photoPreview);
    }
    setUploadError(null);
    setPhotoFile(file);
    const localPreview = URL.createObjectURL(file);
    setPhotoPreview(localPreview);

    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = reader.result as string;
        const res = await fetch('/api/upload-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64Data })
        });
        const data = await res.json();
        if (data.success) {
          setUploadedPhotoUrl(data.photoUrl);
          setUploading(false);
        } else {
          setUploadError(data.error || 'Upload failed');
          setUploading(false);
        }
      } catch (err) {
        setUploadError('Server connection failed during upload.');
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // Validate Delivery & Proceed to Review
  const handleValidateDeliveryAndContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setCalculatingDelivery(true);
    setDeliveryError(null);

    try {
      const res = await fetch('/api/validate-delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: customer.state })
      });
      const data = await res.json();

      if (data.valid) {
        setDeliveryFeeSen(data.deliveryFeeSen);
        setCalculatingDelivery(false);
        setOrderStep('review');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setDeliveryError(data.error || 'Invalid delivery state.');
        setCalculatingDelivery(false);
      }
    } catch (err) {
      setDeliveryError('Failed to validate delivery rate.');
      setCalculatingDelivery(false);
    }
  };

  // Create Order and Proceed to Payment Page
  const handleConfirmAndCreateOrder = async () => {
    setSubmittingOrder(true);
    setOrderError(null);

    try {
      const res = await fetch('/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: selectedProductId,
          bundleId: selectedProductId === 'bundle' ? selectedBundleId : undefined,
          photoUrl: uploadedPhotoUrl,
          customer
        })
      });
      const data = await res.json();

      if (data.success && data.order) {
        setCurrentOrder(data.order);
        setPaymentReturnNotice(null);
        setSubmittingOrder(false);
        setOrderStep('payment');
        window.history.replaceState(
          {},
          '',
          `/?order=${encodeURIComponent(data.order.reference)}&token=${encodeURIComponent(data.order.accessToken)}`
        );
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setOrderError(data.error || 'Failed to create order.');
        setSubmittingOrder(false);
      }
    } catch {
      setOrderError('Server error while saving order.');
      setSubmittingOrder(false);
    }
  };

  const handleRefreshCurrentOrder = useCallback(async () => {
    if (!currentOrder?.reference || !currentOrder?.accessToken) return null;
    const { order } = await fetchOrderByReference(currentOrder.reference, currentOrder.accessToken);
    return order;
  }, [currentOrder?.reference, currentOrder?.accessToken, fetchOrderByReference]);

  const handleReturnHome = () => {
    setOrderStep('sales');
    setCurrentOrder(null);
    setPaymentReturnNotice(null);
    setOrderLookupError(null);
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
                      alt="Little Pixel Keepsakes handmade bead art showcase"
                      className="w-full h-auto object-cover aspect-[4/3]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Product Selector Section */}
          <section id="product-selector" className="py-16 px-4 sm:px-8 max-w-5xl mx-auto">
            <div className="text-center space-y-3 mb-12">
              <span className="text-xs font-bold uppercase tracking-widest text-[#FF8D76]">Step 1 of Your Order</span>
              <h2 className="text-3xl sm:text-4xl font-extrabold text-[#14233C]">Choose Your Keepsake Style</h2>
              <p className="text-[#14233C]/70 max-w-lg mx-auto text-sm sm:text-base">
                Select your preferred keepsake format. Prices in Malaysian Ringgit (RM).
              </p>
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
                          className="w-full h-full object-cover"
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
                      <span className="text-xs font-semibold text-[#14233C]/60">Price</span>
                      <div className="text-right">
                        <span className="text-2xl font-black text-[#14233C]">{formatRM(product.priceSen)}</span>
                        {product.regularSen && (
                          <div className="text-xs text-emerald-600 font-bold">
                            Save {formatRM(product.savingsSen || 0)} (20% OFF)
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
                  {BUNDLE_CHOICES.map((choice) => {
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
                          <span className="text-xs text-emerald-600 font-bold">Save {formatRM(choice.savingsSen)}</span>
                          <span className="text-lg font-black text-[#14233C]">{formatRM(choice.priceSen)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-[#14233C] text-[#FAF6EE] rounded-3xl p-6 sm:p-8 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-6">
              <div className="space-y-2 text-center sm:text-left">
                <span className="text-xs font-bold text-[#FF8D76] uppercase tracking-wider">Your Keepsake Summary</span>
                <h3 className="text-2xl font-extrabold">
                  {currentProduct.name} {selectedProductId === 'bundle' && activeBundle ? `(${activeBundle.name})` : ''}
                </h3>
                <p className="text-xs sm:text-sm text-[#FAF6EE]/80">
                  {selectedProductId === 'bundle' ? activeBundle?.description : currentProduct.description}
                </p>
              </div>

              <div className="flex flex-col sm:items-end gap-3 w-full sm:w-auto">
                <div className="text-center sm:text-right">
                  <span className="text-xs text-[#FAF6EE]/70 block">Item Subtotal</span>
                  <div className="flex items-baseline justify-center sm:justify-end gap-2">
                    {activeRegularSen && (
                      <span className="text-sm line-through text-[#FAF6EE]/50 font-semibold">{formatRM(activeRegularSen)}</span>
                    )}
                    <span className="text-3xl font-black text-[#FF8D76]">{formatRM(activePriceSen)}</span>
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
          <button onClick={() => setOrderStep('sales')} className="text-xs font-bold text-[#14233C] flex items-center gap-1.5 hover:text-[#E05A40]">
            <ArrowLeft className="w-4 h-4" /><span>Back to Keepsakes</span>
          </button>
          <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
            <h2 className="text-2xl font-black text-[#14233C]">Upload Your Photo</h2>
            <p className="text-sm text-[#14233C]/70">Upload 1 clear HD photo in JPG or PNG. Both items in a bundle use the same photo.</p>

            {!photoPreview ? (
              <label className="border-2 border-dashed border-[#14233C]/30 rounded-3xl p-8 flex flex-col items-center justify-center cursor-pointer bg-[#FAF6EE]/50">
                <Camera className="w-8 h-8 text-[#E05A40] mb-2" />
                <span className="font-bold text-sm">Click to upload photo (JPG or PNG)</span>
                <input type="file" accept="image/jpeg,image/png" onChange={handleFileChange} className="hidden" />
              </label>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl overflow-hidden border max-w-sm mx-auto aspect-[4/3] bg-[#FAF6EE]">
                  <img src={photoPreview} alt="Uploaded photo preview" className="w-full h-full object-contain" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="px-4 py-2 bg-[#FAF6EE] border border-[#14233C]/20 rounded-xl text-xs font-bold cursor-pointer hover:bg-[#14233C]/5 transition-colors">
                    <span>{uploading ? 'Uploading…' : 'Replace Photo'}</span>
                    <input type="file" accept="image/jpeg,image/png" onChange={handleFileChange} className="hidden" />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (photoPreview && photoPreview.startsWith('blob:')) {
                        URL.revokeObjectURL(photoPreview);
                      }
                      setPhotoFile(null);
                      setPhotoPreview(null);
                      setUploadedPhotoUrl(null);
                    }}
                    className="px-4 py-2 bg-gray-100 rounded-xl text-xs font-bold text-[#14233C]/75 hover:text-[#14233C]"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            {uploadError && <p className="text-xs font-bold text-red-600">{uploadError}</p>}

            <p className="text-xs text-[#14233C]/65">{DELIVERY_PROMISE_TEXT}</p>

            <button 
              disabled={!uploadedPhotoUrl || uploading}
              onClick={() => setOrderStep('details')}
              className={`w-full py-4 rounded-2xl font-bold text-sm ${uploadedPhotoUrl && !uploading ? 'bg-[#14233C] text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
            >
              {uploading ? 'Uploading photo…' : 'Continue to Delivery Details'}
            </button>
          </div>
        </div>
      )}

      {/* CHECKOUT FLOW: DETAILS */}
      {orderStep === 'details' && (
        <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
          <button onClick={() => setOrderStep('upload')} className="text-xs font-bold text-[#14233C] flex items-center gap-1.5">
            <ArrowLeft className="w-4 h-4" /><span>Back to Photo Upload</span>
          </button>
          <form onSubmit={handleValidateDeliveryAndContinue} className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
            <h2 className="text-2xl font-black text-[#14233C]">Customer & Delivery Details</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold">Full Name</label>
                <input type="text" required value={customer.fullName} onChange={e => setCustomer({...customer, fullName: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold">Email</label>
                  <input type="email" required value={customer.email} onChange={e => setCustomer({...customer, email: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-bold">Mobile Phone</label>
                  <input type="tel" required value={customer.mobile} onChange={e => setCustomer({...customer, mobile: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold">Street Address</label>
                <textarea required rows={2} value={customer.address} onChange={e => setCustomer({...customer, address: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-xs font-bold">Postcode</label>
                  <input type="text" required value={customer.postcode} onChange={e => setCustomer({...customer, postcode: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-bold">City</label>
                  <input type="text" required value={customer.city} onChange={e => setCustomer({...customer, city: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-bold">State</label>
                  <select value={customer.state} onChange={e => setCustomer({...customer, state: e.target.value})} className="w-full px-4 py-3 rounded-xl bg-[#FAF6EE] border text-sm">
                    {MALAYSIAN_STATES.map(st => <option key={st} value={st}>{st}</option>)}
                  </select>
                </div>
              </div>
              {deliveryError && <p className="text-xs font-bold text-red-600">{deliveryError}</p>}
            </div>
            <button type="submit" disabled={calculatingDelivery} className="w-full bg-[#14233C] text-white font-bold py-4 rounded-2xl text-sm">
              {calculatingDelivery ? 'Validating delivery...' : 'Review Order & Delivery Fee'}
            </button>
          </form>
        </div>
      )}

      {/* CHECKOUT FLOW: REVIEW */}
      {orderStep === 'review' && (
        <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
          <button onClick={() => setOrderStep('details')} className="text-xs font-bold text-[#14233C] flex items-center gap-1.5">
            <ArrowLeft className="w-4 h-4" /><span>Back to Details</span>
          </button>
          <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-xl border border-[#14233C]/10 space-y-6">
            <h2 className="text-2xl font-black text-[#14233C]">Order Summary & Review</h2>

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

            <div className="bg-[#FAF6EE] p-5 rounded-2xl space-y-3">
              <div className="flex justify-between font-bold">
                <span>{currentProduct.name} {selectedProductId === 'bundle' && activeBundle ? `(${activeBundle.name})` : ''}</span>
                <span>{formatRM(activePriceSen)}</span>
              </div>
              {activeSavingsSen && (
                <div className="flex justify-between text-xs font-bold text-emerald-700">
                  <span>Bundle 20% Discount</span>
                  <span>- {formatRM(activeSavingsSen)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs text-[#14233C]/70">
                <span>Delivery Fee ({customer.state})</span>
                <span>{formatRM(deliveryFeeSen)}</span>
              </div>
              <div className="flex justify-between pt-3 border-t font-black text-lg text-[#E05A40]">
                <span>Total Amount Due</span>
                <span>{formatRM(activePriceSen + deliveryFeeSen)}</span>
              </div>
            </div>
            <p className="text-xs text-[#14233C]/70 leading-relaxed">{DELIVERY_PROMISE_TEXT}</p>
            {orderError && <p className="text-xs font-bold text-red-600">{orderError}</p>}
            <button disabled={submittingOrder} onClick={handleConfirmAndCreateOrder} className="w-full bg-[#FF8D76] text-[#14233C] font-black py-4 rounded-2xl shadow-lg text-sm">
              {submittingOrder ? 'Saving Order...' : 'Continue to Payment Options'}
            </button>
          </div>
        </div>
      )}

      {/* PAYMENT & CUSTOMER ORDER STATUS PAGE (LINKED TO SAVED ORDER VIA SECURE TOKEN) */}
      {orderStep === 'payment' && currentOrder && (
        <div className="flex-1">
          <PaymentPage
            order={currentOrder}
            merchantConfig={merchantConfig}
            merchantConfigLoading={merchantConfigLoading}
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
              setStorefront(nextStorefront);
              setMerchantConfig(nextMerchant);
              setDeliveryFeeSen(nextStorefront.deliveryRatesSen.peninsular);
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
