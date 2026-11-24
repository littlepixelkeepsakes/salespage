/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  Heart, 
  Package, 
  Truck, 
  ShieldCheck, 
  ChevronDown, 
  ChevronUp, 
  ArrowRight, 
  Check, 
  Camera, 
  Info,
  Gift,
  Upload,
  RefreshCw,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  CreditCard,
  QrCode,
  Download,
  Lock
} from 'lucide-react';

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

const GALLERY_ITEMS = [
  {
    category: 'Pet Portrait',
    title: 'Golden Retriever Buddy',
    description: 'Turned from a smartphone portrait into a vibrant beaded keychain.',
    image: '/src/assets/images/pet_bead_art_1795515646980.jpg',
    tag: 'Popular'
  },
  {
    category: 'Couple Keepsake',
    title: 'Anniversary Memory',
    description: 'Crafted into a charming fridge magnet with pastel cloud and heart details.',
    image: '/src/assets/images/couple_bead_art_1795515653017.jpg',
    tag: 'Best Seller'
  },
  {
    category: 'Family Portrait',
    title: 'Weekend Family Outing',
    description: 'Detailed multi-person pixel bead art keepsake mounted in a wooden frame.',
    image: '/src/assets/images/family_bead_art_1795515653155.jpg',
    tag: 'Special Gift'
  }
];

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
    answer: "Delivered within 14 days after payment is confirmed and we receive a usable photo. Each piece is meticulously handcrafted bead-by-bead in our Malaysian studio."
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

  // Flow State: 'sales' | 'upload' | 'details' | 'review' | 'payment' | 'success'
  const [orderStep, setOrderStep] = useState<'sales' | 'upload' | 'details' | 'review' | 'payment' | 'success'>('sales');

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

  // Order & Payment State
  const [submittingOrder, setSubmittingOrder] = useState<boolean>(false);
  const [currentOrder, setCurrentOrder] = useState<any | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  // Payment Page State
  const [merchantConfig, setMerchantConfig] = useState<any | null>(null);
  const [activePaymentMethod, setActivePaymentMethod] = useState<'tng' | 'duitnow' | 'card'>('tng');
  const [transactionRef, setTransactionRef] = useState<string>('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptUploading, setReceiptUploading] = useState<boolean>(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState<boolean>(false);

  // Check URL params on load for payment return states (?payment=success&ref=... or ?payment=cancelled&ref=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentStatusParam = params.get('payment');
    const refParam = params.get('ref');

    if (refParam) {
      // Fetch order details
      fetch(`/api/orders/${refParam}`)
        .then(res => res.json())
        .then(data => {
          if (data.success && data.order) {
            setCurrentOrder(data.order);
            if (paymentStatusParam === 'success' || data.order.paymentStatus === 'Paid') {
              setOrderStep('success');
            } else {
              setOrderStep('payment');
            }
          }
        })
        .catch(err => console.error('Failed to load order from ref:', err));
    }

    // Fetch merchant QR config
    fetch('/api/merchant-config')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setMerchantConfig(data.merchantConfig);
        }
      })
      .catch(err => console.error('Failed to load merchant config:', err));
  }, []);

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

      if (data.success) {
        setCurrentOrder(data.order);
        setSubmittingOrder(false);
        setOrderStep('payment');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setOrderError(data.error || 'Failed to create order.');
        setSubmittingOrder(false);
      }
    } catch (err) {
      setOrderError('Server error while saving order.');
      setSubmittingOrder(false);
    }
  };

  // Handle Manual QR Receipt Upload
  const handleReceiptUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiptFile || !transactionRef) {
      setReceiptError('Please enter transaction reference and attach receipt file.');
      return;
    }

    setReceiptUploading(true);
    setReceiptError(null);

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = reader.result as string;
        const res = await fetch('/api/upload-receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: currentOrder.reference,
            paymentMethod: activePaymentMethod,
            transactionReference: transactionRef,
            receiptBase64: base64Data,
            filename: receiptFile.name
          })
        });
        const data = await res.json();
        if (data.success) {
          setCurrentOrder(data.order);
          setReceiptUploading(false);
          setOrderStep('success');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          setReceiptError(data.error || 'Failed to upload receipt.');
          setReceiptUploading(false);
        }
      } catch (err) {
        setReceiptError('Server connection error.');
        setReceiptUploading(false);
      }
    };
    reader.readAsDataURL(receiptFile);
  };

  // Handle Stripe Checkout Payment
  const handleStripeCheckout = async () => {
    setStripeLoading(true);
    try {
      const res = await fetch('/api/create-stripe-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: currentOrder.reference,
          appUrl: window.location.origin
        })
      });
      const data = await res.json();
      if (data.success && data.url) {
        if (data.simulated) {
          // Simulated test fallback
          setCurrentOrder((prev: any) => ({ ...prev, paymentStatus: 'Paid' }));
          setOrderStep('success');
        } else {
          window.location.href = data.url;
        }
      } else {
        alert(data.error || 'Failed to start Stripe session.');
        setStripeLoading(false);
      }
    } catch (err) {
      alert('Network error connecting to payment gateway.');
      setStripeLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF6EE] text-[#14233C] font-sans antialiased selection:bg-[#FF8D76]/30">
      {/* Top Notification Bar */}
      <div className="bg-[#14233C] text-[#FAF6EE] py-2 px-4 text-xs font-medium text-center flex items-center justify-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[#FF8D76]" />
        <span>Handmade in Malaysia · Secure Payments · Delivered within 14 calendar days</span>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#FAF6EE]/90 backdrop-blur-md border-b border-[#14233C]/10 px-4 sm:px-8 py-3.5 transition-all">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => { if (orderStep === 'sales') setOrderStep('sales'); }}>
            <img 
              src="/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png" 
              alt="Logo" 
              className="w-10 h-10 object-contain rounded-xl shadow-sm"
            />
            <span className="font-bold text-lg sm:text-xl tracking-tight text-[#14233C]">
              Little Pixel Keepsakes
            </span>
          </div>

          <div className="text-xs font-bold text-[#E05A40] bg-[#FF8D76]/15 px-3 py-1.5 rounded-full">
            {orderStep === 'sales' ? 'Handmade Beaded Art' : `Checkout — Reference: ${currentOrder?.reference || 'Active'}`}
          </div>
        </div>
      </header>

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
                      src="/src/assets/images/hero_bead_art_showcase_1795515646405.jpg" 
                      alt="Showcase" 
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

          {/* Gallery & FAQ Sections */}
          <section id="gallery" className="py-16 px-4 sm:px-8 bg-white/50 border-y border-[#14233C]/10">
            <div className="max-w-6xl mx-auto">
              <div className="text-center space-y-3 mb-12">
                <span className="text-xs font-bold uppercase tracking-widest text-[#0284C7]">Gallery</span>
                <h2 className="text-3xl sm:text-4xl font-extrabold text-[#14233C]">From Photo to Bead Art</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {GALLERY_ITEMS.map((item, idx) => (
                  <div key={idx} className="bg-[#FAF6EE] rounded-3xl overflow-hidden border border-[#14233C]/10 shadow-lg flex flex-col">
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
                <div className="rounded-2xl overflow-hidden border max-w-sm mx-auto aspect-[4/3]">
                  <img src={photoPreview} alt="Preview" className="w-full h-full object-contain" />
                </div>
                <button onClick={() => { setPhotoPreview(null); setUploadedPhotoUrl(null); }} className="px-4 py-2 bg-gray-100 rounded-xl text-xs font-bold">Replace Photo</button>
              </div>
            )}

            {uploadError && <p className="text-xs font-bold text-red-600">{uploadError}</p>}

            <button 
              disabled={!uploadedPhotoUrl || uploading}
              onClick={() => setOrderStep('details')}
              className={`w-full py-4 rounded-2xl font-bold text-sm ${uploadedPhotoUrl && !uploading ? 'bg-[#14233C] text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
            >
              Continue to Delivery Details
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
            {orderError && <p className="text-xs font-bold text-red-600">{orderError}</p>}
            <button disabled={submittingOrder} onClick={handleConfirmAndCreateOrder} className="w-full bg-[#FF8D76] text-[#14233C] font-black py-4 rounded-2xl shadow-lg text-sm">
              {submittingOrder ? 'Saving Order...' : 'Continue to Payment Options'}
            </button>
          </div>
        </div>
      )}

      {/* PAYMENT PAGE */}
      {orderStep === 'payment' && currentOrder && (
        <div className="py-12 px-4 sm:px-8 max-w-3xl mx-auto space-y-8 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-2xl border border-[#14233C]/10 space-y-8">
            <div className="text-center space-y-2 border-b pb-6">
              <span className="text-xs font-bold text-[#FF8D76] uppercase tracking-wider">Secure Checkout</span>
              <h2 className="text-3xl font-black text-[#14233C]">Complete Your Payment</h2>
              <p className="text-sm font-bold text-[#E05A40]">Order Reference: {currentOrder.reference}</p>
            </div>

            {/* Order Cost Breakdown Box */}
            <div className="bg-[#FAF6EE] p-6 rounded-2xl space-y-3">
              <div className="flex justify-between text-sm font-semibold">
                <span>{currentOrder.productName} (Qty: {currentOrder.itemQuantity})</span>
                <span>{formatRM(currentOrder.subtotalSen)}</span>
              </div>
              {currentOrder.savingsSen && (
                <div className="flex justify-between text-xs font-bold text-emerald-700">
                  <span>Bundle Savings Applied</span>
                  <span>- {formatRM(currentOrder.savingsSen)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs text-[#14233C]/70">
                <span>Delivery Fee ({currentOrder.customer.state})</span>
                <span>{formatRM(currentOrder.deliveryFeeSen)}</span>
              </div>
              <div className="flex justify-between pt-3 border-t text-xl font-black text-[#14233C]">
                <span>Exact Amount Due</span>
                <span className="text-[#E05A40]">{formatRM(currentOrder.totalSen)}</span>
              </div>
            </div>

            {/* If order is pending verification */}
            {currentOrder.paymentStatus === 'Pending verification' ? (
              <div className="bg-amber-50 border-2 border-amber-300 p-6 rounded-2xl text-center space-y-3">
                <Clock className="w-10 h-10 text-amber-600 mx-auto" />
                <h3 className="font-bold text-lg text-amber-900">Receipt Pending Verification</h3>
                <p className="text-sm text-amber-800">We’ve received your receipt. We’ll confirm your order once we verify your payment.</p>
                <div className="text-xs text-amber-700">Reference: {currentOrder.transactionReference}</div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Payment Method Selector Tabs */}
                <div className="grid grid-cols-3 gap-3">
                  {merchantConfig?.tng?.enabled && (
                    <button 
                      onClick={() => setActivePaymentMethod('tng')}
                      className={`p-4 rounded-2xl border-2 font-bold text-xs sm:text-sm flex flex-col items-center gap-2 transition-all ${activePaymentMethod === 'tng' ? 'bg-[#14233C] text-white border-[#14233C]' : 'bg-white text-[#14233C] border-gray-200'}`}
                    >
                      <QrCode className="w-5 h-5" />
                      <span>Touch 'n Go eWallet</span>
                    </button>
                  )}
                  {merchantConfig?.duitnow?.enabled && (
                    <button 
                      onClick={() => setActivePaymentMethod('duitnow')}
                      className={`p-4 rounded-2xl border-2 font-bold text-xs sm:text-sm flex flex-col items-center gap-2 transition-all ${activePaymentMethod === 'duitnow' ? 'bg-[#14233C] text-white border-[#14233C]' : 'bg-white text-[#14233C] border-gray-200'}`}
                    >
                      <QrCode className="w-5 h-5" />
                      <span>DuitNow QR</span>
                    </button>
                  )}
                  <button 
                    onClick={() => setActivePaymentMethod('card')}
                    className={`p-4 rounded-2xl border-2 font-bold text-xs sm:text-sm flex flex-col items-center gap-2 transition-all ${activePaymentMethod === 'card' ? 'bg-[#14233C] text-white border-[#14233C]' : 'bg-white text-[#14233C] border-gray-200'}`}
                  >
                    <CreditCard className="w-5 h-5" />
                    <span>Card (Stripe)</span>
                  </button>
                </div>

                {/* Manual QR Payment View (TnG or DuitNow) */}
                {(activePaymentMethod === 'tng' || activePaymentMethod === 'duitnow') && merchantConfig?.[activePaymentMethod]?.enabled && (
                  <div className="bg-white p-6 rounded-2xl border-2 border-gray-200 space-y-6 animate-fadeIn">
                    <div className="text-center space-y-1">
                      <h3 className="font-extrabold text-lg text-[#14233C]">
                        {activePaymentMethod === 'tng' ? "Touch 'n Go eWallet QR" : "DuitNow QR"}
                      </h3>
                      <p className="text-xs text-[#14233C]/70">Scan QR using your mobile banking or eWallet app, check recipient name, and transfer exact amount.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-center">
                      <div className="flex flex-col items-center space-y-3">
                        <div className="w-48 h-48 bg-gray-100 rounded-2xl p-2 border-2 border-gray-300 shadow-sm">
                          <img 
                            src={merchantConfig[activePaymentMethod].qrImage} 
                            alt="Merchant QR" 
                            className="w-full h-full object-contain rounded-xl"
                          />
                        </div>
                        <a 
                          href={merchantConfig[activePaymentMethod].qrImage} 
                          download={`${activePaymentMethod}_merchant_qr.jpg`}
                          className="text-xs font-bold text-[#0284C7] hover:underline flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Save QR Image</span>
                        </a>
                      </div>

                      <div className="space-y-4 text-xs sm:text-sm">
                        <div className="bg-gray-50 p-4 rounded-xl space-y-2 border">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Recipient Name:</span>
                            <span className="font-bold text-[#14233C]">{merchantConfig[activePaymentMethod].merchantName}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Account ID:</span>
                            <span className="font-bold text-[#14233C]">{merchantConfig[activePaymentMethod].merchantAccount}</span>
                          </div>
                          <div className="flex justify-between pt-2 border-t">
                            <span className="text-gray-500 font-bold">Exact Amount Due:</span>
                            <span className="font-black text-[#E05A40] text-base">{formatRM(currentOrder.totalSen)}</span>
                          </div>
                        </div>

                        <form onSubmit={handleReceiptUpload} className="space-y-3">
                          <div>
                            <label className="text-xs font-bold text-[#14233C]">Transaction Reference / Approval ID</label>
                            <input 
                              type="text" 
                              required 
                              placeholder="e.g. TXN123456789"
                              value={transactionRef}
                              onChange={e => setTransactionRef(e.target.value)}
                              className="w-full px-3 py-2.5 rounded-xl border text-xs bg-[#FAF6EE]"
                            />
                          </div>

                          <div>
                            <label className="text-xs font-bold text-[#14233C]">Upload Payment Receipt (JPG, PNG, PDF)</label>
                            <input 
                              type="file" 
                              required 
                              accept="image/jpeg,image/png,application/pdf"
                              onChange={e => setReceiptFile(e.target.files?.[0] || null)}
                              className="w-full text-xs file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#14233C] file:text-white hover:file:bg-[#14233C]/90 mt-1"
                            />
                          </div>

                          {receiptError && <p className="text-xs font-bold text-red-600">{receiptError}</p>}

                          <button 
                            type="submit" 
                            disabled={receiptUploading}
                            className="w-full bg-[#14233C] text-white font-bold py-3 rounded-xl text-xs hover:bg-[#14233C]/90 shadow-md"
                          >
                            {receiptUploading ? 'Uploading receipt...' : 'Submit Payment Receipt for Verification'}
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                )}

                {/* Card Payment View (Stripe Checkout) */}
                {activePaymentMethod === 'card' && (
                  <div className="bg-white p-8 rounded-2xl border-2 border-gray-200 text-center space-y-6 animate-fadeIn">
                    <div className="w-16 h-16 bg-[#38BDF8]/15 text-[#0284C7] rounded-2xl flex items-center justify-center mx-auto">
                      <CreditCard className="w-8 h-8" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="font-extrabold text-xl text-[#14233C]">Credit or Debit Card (Stripe Checkout)</h3>
                      <p className="text-xs text-[#14233C]/70 max-w-sm mx-auto">Pay securely using Visa, Mastercard, or Apple Pay via Stripe hosted checkout.</p>
                    </div>

                    <button 
                      disabled={stripeLoading}
                      onClick={handleStripeCheckout}
                      className="w-full max-w-md bg-[#635BFF] text-white font-black py-4 rounded-2xl shadow-lg hover:bg-[#5851db] transition-all text-sm flex items-center justify-center gap-2 mx-auto"
                    >
                      {stripeLoading ? 'Opening Stripe Checkout...' : `Pay ${formatRM(currentOrder.totalSen)} with Stripe`}
                    </button>
                    <div className="text-xs text-gray-400 flex items-center justify-center gap-1">
                      <Lock className="w-3.5 h-3.5" />
                      <span>256-Bit SSL Encrypted Payment</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SUCCESS PAGE */}
      {orderStep === 'success' && currentOrder && (
        <div className="py-12 px-4 sm:px-8 max-w-2xl mx-auto space-y-8 animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-2xl border-2 border-emerald-500 space-y-6 text-center">
            <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-sm">
              <CheckCircle2 className="w-10 h-10" />
            </div>

            <div className="space-y-2">
              <span className="text-xs font-bold text-emerald-600 uppercase tracking-widest">Order & Payment Confirmation</span>
              <h2 className="text-3xl font-black text-[#14233C]">Reference: {currentOrder.reference}</h2>
              <p className="text-sm text-[#14233C]/75 max-w-md mx-auto">
                Status: <span className="font-bold text-[#E05A40]">“{currentOrder.paymentStatus}”</span>
              </p>
            </div>

            <div className="bg-[#FAF6EE] p-6 rounded-2xl border text-left space-y-2 text-xs">
              <div className="flex justify-between font-semibold">
                <span>Product:</span>
                <span>{currentOrder.productName}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total Paid:</span>
                <span className="font-black text-emerald-700">{formatRM(currentOrder.totalSen)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Delivery Window:</span>
                <span>Within 14 calendar days</span>
              </div>
            </div>

            <button 
              onClick={() => { setOrderStep('sales'); setCurrentOrder(null); window.history.replaceState({}, '', '/'); }}
              className="bg-[#14233C] text-white font-bold px-8 py-3.5 rounded-xl text-sm"
            >
              Back to Home
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
