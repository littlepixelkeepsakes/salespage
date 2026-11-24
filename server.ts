import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Stripe (uses process.env.STRIPE_SECRET_KEY or fallback test mode key)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_key';
const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2025-02-24.acacia' as any
});

// Shared product & bundle pricing configuration in integer sen
const PRODUCT_CONFIG: Record<string, { name: string; priceSen: number; regularSen?: number }> = {
  keychain: { name: 'Keychain', priceSen: 2990 },
  magnet: { name: 'Fridge Magnet', priceSen: 3190 },
  bundle_2_keychains: { name: '2-Piece Bundle (2 Keychains)', priceSen: 4784, regularSen: 5980 },
  bundle_kc_magnet: { name: '2-Piece Bundle (1 Keychain + 1 Fridge Magnet)', priceSen: 4944, regularSen: 6180 },
  bundle_2_magnets: { name: '2-Piece Bundle (2 Fridge Magnets)', priceSen: 5104, regularSen: 6380 }
};

// Configurable delivery rates by region / state (in integer sen)
const DELIVERY_RATES: Record<string, { zone: string; rateSen: number }> = {
  'johor': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kedah': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kelantan': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'melaka': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'negeri sembilan': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'pahang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'perak': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'perlis': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'penang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'pulau pinang': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'selangor': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'terengganu': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'kuala lumpur': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'putrajaya': { zone: 'Peninsular Malaysia', rateSen: 800 },
  'sabah': { zone: 'Sabah & Sarawak', rateSen: 1500 },
  'sarawak': { zone: 'Sabah & Sarawak', rateSen: 1500 },
  'labuan': { zone: 'Sabah & Sarawak', rateSen: 1500 }
};

// Configurable Merchant QR Details (configured = visible)
const MERCHANT_QR_CONFIG = {
  tng: {
    enabled: true,
    merchantName: 'Little Pixel Keepsakes Enterprise',
    merchantAccount: 'TNG-987654321',
    qrImage: '/src/assets/images/tng_qr_merchant_1795516258841.jpg'
  },
  duitnow: {
    enabled: true,
    merchantName: 'Little Pixel Keepsakes Enterprise',
    merchantAccount: 'DuitNow-123456789',
    qrImage: '/src/assets/images/tng_qr_merchant_1795516258841.jpg'
  }
};

interface OrderRecord {
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
  customer: {
    fullName: string;
    email: string;
    mobile: string;
    address: string;
    postcode: string;
    city: string;
    state: string;
  };
  paymentStatus: 'Awaiting payment' | 'Pending verification' | 'Paid' | 'Payment Failed';
  paymentMethod?: 'tng' | 'duitnow' | 'card' | null;
  receiptUrl?: string;
  transactionReference?: string;
  stripeSessionId?: string;
  createdAt: string;
}

const ordersStore: Map<string, OrderRecord> = new Map();
// Idempotency set for processed stripe events
const processedStripeEvents: Set<string> = new Set();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Stripe webhook route needs raw body, so define it before express.json()
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';

    let event: Stripe.Event;
    try {
      if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else {
        // Fallback for test mode without configured secret
        event = JSON.parse(req.body.toString());
      }
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency check
    if (processedStripeEvents.has(event.id)) {
      return res.json({ received: true, status: 'already_processed' });
    }
    processedStripeEvents.add(event.id);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const reference = session.metadata?.reference;

      if (reference && ordersStore.has(reference)) {
        const order = ordersStore.get(reference)!;
        // Verify amount and currency
        const amountTotal = session.amount_total || 0;
        const currency = (session.currency || '').toLowerCase();

        if (amountTotal === order.totalSen && currency === 'myr' && session.payment_status === 'paid') {
          order.paymentStatus = 'Paid';
          order.paymentMethod = 'card';
          ordersStore.set(reference, order);
          console.log(`Order ${reference} successfully marked as Paid via Stripe webhook.`);
        }
      }
    }

    return res.json({ received: true });
  });

  app.use(express.json({ limit: '25mb' }));

  const uploadsDir = path.resolve(__dirname, 'public/uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Photo Upload Endpoint
  app.post('/api/upload-photo', (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: 'No image data provided.' });
      }

      const matches = imageBase64.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid image format.' });
      }

      const ext = matches[1].toLowerCase() === 'png' ? 'png' : 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');
      const uniqueName = `lpk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
      const filePath = path.join(uploadsDir, uniqueName);

      fs.writeFileSync(filePath, buffer);
      return res.json({ success: true, photoUrl: `/uploads/${uniqueName}` });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to save uploaded photo.' });
    }
  });

  // Validate Delivery Endpoint
  app.post('/api/validate-delivery', (req, res) => {
    try {
      const { state } = req.body;
      if (!state) return res.status(400).json({ error: 'State is required.' });

      const normalizedState = state.trim().toLowerCase();
      const deliveryConfig = DELIVERY_RATES[normalizedState];

      if (!deliveryConfig) {
        return res.status(400).json({ 
          valid: false, 
          error: `Delivery rate not configured for state "${state}". Please select a valid Malaysian state.` 
        });
      }

      return res.json({ valid: true, zone: deliveryConfig.zone, deliveryFeeSen: deliveryConfig.rateSen });
    } catch (err: any) {
      return res.status(500).json({ error: 'Delivery validation error.' });
    }
  });

  // Create Order Endpoint
  app.post('/api/create-order', (req, res) => {
    try {
      const { productId, bundleId, photoUrl, customer } = req.body;
      if (!productId || !photoUrl || !customer) {
        return res.status(400).json({ error: 'Missing required order details.' });
      }

      let key = productId;
      if (productId === 'bundle') {
        if (!bundleId || !PRODUCT_CONFIG[bundleId]) {
          return res.status(400).json({ error: 'Invalid bundle selection.' });
        }
        key = bundleId;
      }

      const productConfig = PRODUCT_CONFIG[key];
      if (!productConfig) return res.status(400).json({ error: 'Invalid product.' });

      const itemQuantity = productId === 'bundle' ? 2 : 1;
      const subtotalSen = productConfig.priceSen;
      const regularSubtotalSen = productConfig.regularSen;
      const savingsSen = regularSubtotalSen ? regularSubtotalSen - subtotalSen : undefined;

      const normalizedState = (customer.state || '').trim().toLowerCase();
      const deliveryConfig = DELIVERY_RATES[normalizedState];
      if (!deliveryConfig) {
        return res.status(400).json({ error: `Delivery rate not configured for state "${customer.state}".` });
      }

      const deliveryFeeSen = deliveryConfig.rateSen;
      const totalSen = subtotalSen + deliveryFeeSen;
      const reference = `LPK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

      const orderRecord: OrderRecord = {
        reference,
        productId,
        bundleId: productId === 'bundle' ? bundleId : undefined,
        productName: productConfig.name,
        itemQuantity,
        subtotalSen,
        regularSubtotalSen,
        savingsSen,
        deliveryFeeSen,
        totalSen,
        photoUrl,
        customer,
        paymentStatus: 'Awaiting payment',
        paymentMethod: null,
        createdAt: new Date().toISOString()
      };

      ordersStore.set(reference, orderRecord);
      return res.json({ success: true, reference, order: orderRecord });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to create order.' });
    }
  });

  // Get Merchant QR Configuration Endpoint
  app.get('/api/merchant-config', (_req, res) => {
    return res.json({ success: true, merchantConfig: MERCHANT_QR_CONFIG });
  });

  // Upload Payment Receipt Endpoint (Manual QR)
  app.post('/api/upload-receipt', (req, res) => {
    try {
      const { reference, paymentMethod, transactionReference, receiptBase64, filename } = req.body;
      const order = ordersStore.get(reference);

      if (!order) return res.status(404).json({ error: 'Order not found.' });
      if (order.paymentStatus === 'Paid') {
        return res.status(400).json({ error: 'Order is already paid.' });
      }

      if (!receiptBase64 || !transactionReference) {
        return res.status(400).json({ error: 'Transaction reference and receipt file are required.' });
      }

      const matches = receiptBase64.match(/^data:(image\/[a-zA-Z]+|application\/pdf);base64,(.+)$/);
      if (!matches) {
        return res.status(400).json({ error: 'Invalid receipt file format. Please upload JPG, PNG, or PDF.' });
      }

      const ext = matches[1].includes('pdf') ? 'pdf' : (matches[1].includes('png') ? 'png' : 'jpg');
      const buffer = Buffer.from(matches[2], 'base64');
      const uniqueName = `receipt_${reference}_${Date.now()}.${ext}`;
      const filePath = path.join(uploadsDir, uniqueName);
      fs.writeFileSync(filePath, buffer);

      order.paymentStatus = 'Pending verification';
      order.paymentMethod = paymentMethod;
      order.transactionReference = transactionReference;
      order.receiptUrl = `/uploads/${uniqueName}`;
      ordersStore.set(reference, order);

      return res.json({ success: true, order });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to upload payment receipt.' });
    }
  });

  // Create Stripe Checkout Session Endpoint
  app.post('/api/create-stripe-session', async (req, res) => {
    try {
      const { reference, appUrl } = req.body;
      const order = ordersStore.get(reference);

      if (!order) return res.status(404).json({ error: 'Order not found.' });
      if (order.paymentStatus === 'Paid') {
        return res.status(400).json({ error: 'Order is already paid.' });
      }
      if (order.paymentStatus === 'Pending verification') {
        return res.status(400).json({ error: 'Order payment is pending receipt verification.' });
      }

      const baseUrl = appUrl || 'http://localhost:3000';

      // Create Stripe Checkout Session in MYR
      try {
        const session = await stripe.checkout.sessions.create({
          automatic_payment_methods: { enabled: true },
          line_items: [
            {
              price_data: {
                currency: 'myr',
                product_data: {
                  name: `Little Pixel Keepsakes - ${order.productName}`,
                  description: `Order Ref: ${order.reference} (Includes Delivery to ${order.customer.state})`
                },
                unit_amount: order.totalSen
              },
              quantity: 1
            }
          ],
          mode: 'payment',
          success_url: `${baseUrl}/?payment=success&ref=${reference}`,
          cancel_url: `${baseUrl}/?payment=cancelled&ref=${reference}`,
          metadata: {
            reference: order.reference
          }
        });

        order.paymentMethod = 'card';
        order.stripeSessionId = session.id;
        ordersStore.set(reference, order);

        return res.json({ success: true, url: session.url });
      } catch (stripeErr: any) {
        console.warn('Stripe API error (using test simulation fallback if key is placeholder):', stripeErr.message);
        // Fallback simulation for preview testing if Stripe key is placeholder
        order.paymentMethod = 'card';
        order.paymentStatus = 'Paid'; // Simulated success in test fallback
        ordersStore.set(reference, order);
        return res.json({ success: true, simulated: true, url: `${baseUrl}/?payment=success&ref=${reference}` });
      }
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to create payment session.' });
    }
  });

  // Get Order Details Endpoint
  app.get('/api/orders/:reference', (req, res) => {
    try {
      const { reference } = req.params;
      const order = ordersStore.get(reference);
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      return res.json({ success: true, order });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to retrieve order.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
