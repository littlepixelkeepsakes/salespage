import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  checkSupabaseHealth,
  getSupabaseAdminClient,
  getSupabaseEnvConfig,
  uploadPrivateFile
} from '../src/server/supabase';

/**
 * Backup, migrate, and verify legacy local store.json + public/uploads customer photos
 * into Supabase PostgreSQL + private Storage buckets.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-supabase.ts
 *   npx tsx scripts/migrate-to-supabase.ts --remove-old-photos
 *
 * Old public customer photos are NEVER deleted unless:
 *   1. A timestamped backup was created first,
 *   2. Every order, photo, and receipt passed post-migration verification in Supabase, AND
 *   3. --remove-old-photos was explicitly passed.
 */

interface LegacyPrivateReceipt {
  id: string;
  storageFileName: string;
  originalFilename: string;
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  uploadedAt: string;
}

interface LegacyOrder {
  reference: string;
  accessToken?: string;
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
  paymentStatus: 'Awaiting payment' | 'Pending verification' | 'Receipt correction needed' | 'Paid';
  paymentMethod?: 'tng' | 'duitnow' | 'card' | null;
  transactionReference?: string;
  privateReceipt?: LegacyPrivateReceipt;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  paidAt?: string;
  verifiedByStaff?: boolean;
  verificationNote?: string;
  correctionReason?: string;
  lastCardAttemptMessage?: string;
  confirmationEmailStatus?: 'sent' | 'not_configured' | 'failed' | null;
  confirmationEmailSentAt?: string;
  confirmationEmailId?: string;
  confirmationEmailError?: string;
  confirmationEmailLastAttemptAt?: string;
  createdAt: string;
}

interface LegacyStore {
  orders?: Record<string, LegacyOrder>;
  adminCredential?: { salt: string; hash: string; claimedAt?: string };
  storeSettings?: Record<string, any>;
}

const rootDir = process.cwd();
const legacyStorageDir = path.resolve(rootDir, 'private_storage');
const legacyStorePath = path.resolve(legacyStorageDir, 'store.json');
const legacyReceiptsDir = path.resolve(legacyStorageDir, 'receipts');
const legacyPublicUploadsDir = path.resolve(rootDir, 'public', 'uploads');

const shouldRemoveOldPhotos = process.argv.includes('--remove-old-photos');

function detectMime(filePath: string): 'image/jpeg' | 'image/png' | 'application/pdf' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

function copyIfExists(src: string, dest: string) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

async function run() {
  console.log('=== Little Pixel Keepsakes: Supabase Backup, Migration & Verification ===');

  // Step 1: Verify Supabase connectivity, schema, and private buckets first
  const health = await checkSupabaseHealth(true);
  if (!health.configured) {
    console.error('Supabase is not ready:', health.issue);
    process.exit(1);
  }
  const cfg = getSupabaseEnvConfig();
  const client = getSupabaseAdminClient();

  // Step 2: Back up all existing local files BEFORE migrating anything
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(rootDir, 'migration_backups', timestamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const backedUpFiles: string[] = [];
  if (copyIfExists(legacyStorePath, path.join(backupDir, 'private_storage', 'store.json'))) {
    backedUpFiles.push('private_storage/store.json');
  }
  if (fs.existsSync(legacyReceiptsDir)) {
    for (const file of fs.readdirSync(legacyReceiptsDir)) {
      const src = path.join(legacyReceiptsDir, file);
      if (fs.statSync(src).isFile()) {
        copyIfExists(src, path.join(backupDir, 'private_storage', 'receipts', file));
        backedUpFiles.push(`private_storage/receipts/${file}`);
      }
    }
  }

  const legacyPublicPhotos: string[] = [];
  if (fs.existsSync(legacyPublicUploadsDir)) {
    for (const file of fs.readdirSync(legacyPublicUploadsDir)) {
      const src = path.join(legacyPublicUploadsDir, file);
      if (fs.statSync(src).isFile() && /\.(png|jpe?g)$/i.test(file)) {
        copyIfExists(src, path.join(backupDir, 'public', 'uploads', file));
        backedUpFiles.push(`public/uploads/${file}`);
        legacyPublicPhotos.push(file);
      }
    }
  }

  fs.writeFileSync(
    path.join(backupDir, 'backup_manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), backedUpFiles }, null, 2),
    'utf-8'
  );
  console.log(`Backup created at ${backupDir} (${backedUpFiles.length} file(s) backed up).`);

  // Step 3: Read legacy store.json if present
  const legacy: LegacyStore = fs.existsSync(legacyStorePath)
    ? (JSON.parse(fs.readFileSync(legacyStorePath, 'utf-8')) as LegacyStore)
    : {};

  // 3a. Migrate claimed staff admin credential
  if (legacy.adminCredential?.salt && legacy.adminCredential?.hash) {
    const { error } = await client.from('staff_accounts').upsert(
      {
        username: 'admin',
        display_name: 'Primary Staff Admin',
        role: 'admin',
        password_salt: legacy.adminCredential.salt,
        password_hash: legacy.adminCredential.hash,
        is_active: true
      },
      { onConflict: 'username' }
    );
    if (error) throw new Error(`Failed migrating staff_accounts: ${error.message}`);
    console.log('Migrated staff_accounts credential.');
  }

  // 3b. Migrate store_settings
  if (legacy.storeSettings) {
    const s = legacy.storeSettings;
    const { error } = await client.from('store_settings').upsert(
      {
        id: 'default',
        logo_url: s.logoUrl || '/assets/aistudio/Beaded_heart_keepsakes_logo_4fef68e3.png',
        hero_image_url: s.heroImageUrl || '/src/assets/images/hero_bead_art_showcase_1795515646405.jpg',
        product_images: s.productImages || {},
        gallery_items: s.galleryItems || [],
        delivery_rate_peninsular_sen: s.deliveryRatesSen?.peninsular ?? 800,
        delivery_rate_east_malaysia_sen: s.deliveryRatesSen?.eastMalaysia ?? 1500,
        whatsapp_support_number: s.whatsappSupportNumber || '',
        tng_override_enabled: s.qrOverrides?.tng?.enabled ?? null,
        tng_override_recipient_name: s.qrOverrides?.tng?.recipientName || '',
        tng_override_qr_image: s.qrOverrides?.tng?.qrImage || '',
        duitnow_override_enabled: s.qrOverrides?.duitnow?.enabled ?? null,
        duitnow_override_recipient_name: s.qrOverrides?.duitnow?.recipientName || '',
        duitnow_override_qr_image: s.qrOverrides?.duitnow?.qrImage || ''
      },
      { onConflict: 'id' }
    );
    if (error) throw new Error(`Failed migrating store_settings: ${error.message}`);
    console.log('Migrated store_settings.');
  }

  // 3c. Migrate orders, private photos, receipts, and email notifications
  const ordersList = Object.values(legacy.orders || {});
  const verifiedChecks: Array<{ reference: string; photoPath: string; receiptPath?: string }> = [];

  for (const order of ordersList) {
    let photoStoragePath = `orders/${order.reference}/legacy_photo.png`;
    let photoMimeType: 'image/jpeg' | 'image/png' = 'image/png';
    let photoSizeBytes: number | null = null;
    let photoOriginalName: string | null = null;

    if (order.photoUrl?.startsWith('/uploads/')) {
      const localFile = path.basename(order.photoUrl);
      const localPhotoPath = path.join(legacyPublicUploadsDir, localFile);
      if (fs.existsSync(localPhotoPath)) {
        const buf = fs.readFileSync(localPhotoPath);
        const mime = detectMime(localPhotoPath);
        photoMimeType = mime === 'image/png' ? 'image/png' : 'image/jpeg';
        photoSizeBytes = buf.length;
        photoOriginalName = localFile;
        photoStoragePath = `orders/${order.reference}/${localFile}`;
        await uploadPrivateFile({
          bucket: cfg.photosBucket,
          storagePath: photoStoragePath,
          buffer: buf,
          contentType: photoMimeType,
          upsert: true
        });
      }
    }

    const { data: savedOrder, error: orderErr } = await client
      .from('orders')
      .upsert(
        {
          reference: order.reference,
          access_token: order.accessToken || crypto.randomBytes(24).toString('base64url'),
          product_id: order.productId,
          bundle_id: order.bundleId ?? null,
          product_name: order.productName,
          item_quantity: order.itemQuantity,
          subtotal_sen: order.subtotalSen,
          regular_subtotal_sen: order.regularSubtotalSen ?? null,
          savings_sen: order.savingsSen ?? null,
          delivery_fee_sen: order.deliveryFeeSen,
          total_sen: order.totalSen,
          photo_storage_bucket: cfg.photosBucket,
          photo_storage_path: photoStoragePath,
          photo_original_filename: photoOriginalName,
          photo_mime_type: photoMimeType,
          photo_size_bytes: photoSizeBytes,
          customer_full_name: order.customer.fullName,
          customer_email: order.customer.email,
          customer_mobile: order.customer.mobile,
          customer_address: order.customer.address,
          customer_postcode: order.customer.postcode,
          customer_city: order.customer.city,
          customer_state: order.customer.state,
          payment_status: order.paymentStatus,
          payment_method: order.paymentMethod ?? null,
          paid_at: order.paidAt ?? null,
          verified_by_staff: Boolean(order.verifiedByStaff),
          verification_note: order.verificationNote ?? null,
          correction_reason: order.correctionReason ?? null,
          last_card_attempt_message: order.lastCardAttemptMessage ?? null,
          created_at: order.createdAt
        },
        { onConflict: 'reference' }
      )
      .select('id, reference')
      .single();

    if (orderErr || !savedOrder) {
      throw new Error(`Failed migrating order ${order.reference}: ${orderErr?.message}`);
    }

    let receiptStoragePath: string | undefined;
    if (order.privateReceipt) {
      const localReceiptPath = path.join(legacyReceiptsDir, path.basename(order.privateReceipt.storageFileName));
      if (fs.existsSync(localReceiptPath)) {
        const buf = fs.readFileSync(localReceiptPath);
        receiptStoragePath = `orders/${order.reference}/${path.basename(order.privateReceipt.storageFileName)}`;
        await uploadPrivateFile({
          bucket: cfg.receiptsBucket,
          storagePath: receiptStoragePath,
          buffer: buf,
          contentType: order.privateReceipt.mimeType,
          upsert: true
        });
      }
    }

    if (order.paymentMethod) {
      const paymentStatusMapped =
        order.paymentStatus === 'Paid'
          ? 'paid'
          : order.paymentStatus === 'Pending verification'
            ? 'pending_verification'
            : order.paymentStatus === 'Receipt correction needed'
              ? 'correction_needed'
              : 'pending';

      const { error: payErr } = await client.from('payments').insert({
        order_id: savedOrder.id,
        order_reference: order.reference,
        payment_method: order.paymentMethod,
        status: paymentStatusMapped,
        amount_sen: order.totalSen,
        currency: 'myr',
        transaction_reference: order.transactionReference ?? null,
        receipt_storage_bucket: receiptStoragePath ? cfg.receiptsBucket : null,
        receipt_storage_path: receiptStoragePath ?? null,
        receipt_original_filename: order.privateReceipt?.originalFilename ?? null,
        receipt_mime_type: order.privateReceipt?.mimeType ?? null,
        receipt_size_bytes: order.privateReceipt?.sizeBytes ?? null,
        receipt_uploaded_at: order.privateReceipt?.uploadedAt ?? null,
        stripe_session_id: order.stripeSessionId ?? null,
        stripe_payment_intent_id: order.stripePaymentIntentId ?? null,
        verified_by_staff: Boolean(order.verifiedByStaff),
        verification_note: order.verificationNote ?? null,
        rejection_reason: order.correctionReason ?? null,
        paid_at: order.paidAt ?? null
      });
      if (payErr && !payErr.message.includes('duplicate key')) {
        throw new Error(`Failed migrating payment for ${order.reference}: ${payErr.message}`);
      }
    }

    if (order.confirmationEmailStatus) {
      const { error: emailErr } = await client.from('email_notifications').upsert(
        {
          order_id: savedOrder.id,
          order_reference: order.reference,
          notification_type: 'order_confirmation',
          provider: order.confirmationEmailStatus === 'not_configured' ? 'none' : 'resend',
          recipient_email: order.customer.email,
          subject: `Order Confirmed — Little Pixel Keepsakes (${order.reference})`,
          status: order.confirmationEmailStatus,
          provider_message_id: order.confirmationEmailId ?? null,
          error_message: order.confirmationEmailError ?? null,
          sent_at: order.confirmationEmailSentAt ?? null,
          last_attempt_at: order.confirmationEmailLastAttemptAt || order.paidAt || order.createdAt
        },
        { onConflict: 'order_id,notification_type' }
      );
      if (emailErr) {
        throw new Error(`Failed migrating email notification for ${order.reference}: ${emailErr.message}`);
      }
    }

    verifiedChecks.push({
      reference: order.reference,
      photoPath: photoStoragePath,
      receiptPath: receiptStoragePath
    });
  }

  // Step 4: Verify every migrated record and private storage object in Supabase
  let allVerified = true;
  for (const check of verifiedChecks) {
    const { data: row, error: rowErr } = await client
      .from('orders')
      .select('reference, photo_storage_path')
      .eq('reference', check.reference)
      .maybeSingle();

    if (rowErr || !row) {
      console.error(`Verification FAILED: order ${check.reference} not found in Supabase.`);
      allVerified = false;
      continue;
    }

    const { error: photoErr } = await client.storage.from(cfg.photosBucket).download(check.photoPath);
    if (photoErr) {
      console.error(`Verification FAILED: photo ${check.photoPath} missing in ${cfg.photosBucket}.`);
      allVerified = false;
    }

    if (check.receiptPath) {
      const { error: rcptErr } = await client.storage.from(cfg.receiptsBucket).download(check.receiptPath);
      if (rcptErr) {
        console.error(`Verification FAILED: receipt ${check.receiptPath} missing in ${cfg.receiptsBucket}.`);
        allVerified = false;
      }
    }
  }

  if (!allVerified) {
    console.error('Migration verification failed. Legacy public customer photos were NOT removed.');
    process.exit(1);
  }

  console.log(`Verification PASSED for ${verifiedChecks.length} migrated order(s).`);

  // Step 5: Remove legacy public customer photos ONLY if explicitly requested after verification passed
  if (shouldRemoveOldPhotos) {
    for (const file of legacyPublicPhotos) {
      const fullPath = path.join(legacyPublicUploadsDir, file);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`Removed legacy public customer photo: public/uploads/${file}`);
      }
    }
  } else if (legacyPublicPhotos.length > 0) {
    console.log(
      `Found ${legacyPublicPhotos.length} legacy file(s) in public/uploads/ (backed up to ${backupDir}). Re-run with --remove-old-photos after reviewing your backup to remove them.`
    );
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
