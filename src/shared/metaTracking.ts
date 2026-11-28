import type { SupportedCurrency } from '../types/order';

export type MetaProductContentId =
  | 'keychain'
  | 'fridge_magnet'
  | 'bundle_2_keychains'
  | 'bundle_keychain_magnet'
  | 'bundle_2_magnets'
  | 'portrait_frame';

export type MetaStandardEventName =
  | 'PageView'
  | 'ViewContent'
  | 'AddToCart'
  | 'InitiateCheckout'
  | 'AddPaymentInfo'
  | 'Purchase';

export interface MetaContentItem {
  id: MetaProductContentId;
  quantity: number;
  item_price: number;
}

export interface MetaEcommerceParams {
  content_ids: MetaProductContentId[];
  contents: MetaContentItem[];
  content_type: 'product';
  content_name?: string;
  value: number;
  currency: SupportedCurrency;
  num_items: number;
  order_id?: string;
}

/**
 * Maps internal productId / bundleId values to canonical Meta Pixel & CAPI product IDs:
 *   keychain | fridge_magnet | bundle_2_keychains | bundle_keychain_magnet | bundle_2_magnets | portrait_frame
 */
export function resolveMetaContentId(
  productId: string,
  bundleId?: string | null
): MetaProductContentId {
  const normalizedProduct = (productId || '').trim().toLowerCase();
  const normalizedBundle = (bundleId || '').trim().toLowerCase();

  if (normalizedProduct === 'bundle') {
    if (normalizedBundle === 'bundle_2_keychains') return 'bundle_2_keychains';
    if (normalizedBundle === 'bundle_2_magnets') return 'bundle_2_magnets';
    return 'bundle_keychain_magnet';
  }
  if (
    normalizedProduct === 'portrait_frame' ||
    normalizedProduct === 'portraitframe' ||
    normalizedProduct === 'custom_portrait_frame'
  ) {
    return 'portrait_frame';
  }
  if (normalizedProduct === 'magnet' || normalizedProduct === 'fridge_magnet') {
    return 'fridge_magnet';
  }
  if (normalizedProduct === 'bundle_2_keychains') return 'bundle_2_keychains';
  if (normalizedProduct === 'bundle_2_magnets') return 'bundle_2_magnets';
  if (normalizedProduct === 'bundle_kc_magnet' || normalizedProduct === 'bundle_keychain_magnet') {
    return 'bundle_keychain_magnet';
  }
  return 'keychain';
}

export function resolveMetaNumItems(
  productId: string,
  bundleId?: string | null,
  explicitItemQuantity?: number | null
): number {
  if (
    typeof explicitItemQuantity === 'number' &&
    Number.isInteger(explicitItemQuantity) &&
    explicitItemQuantity > 0
  ) {
    return explicitItemQuantity;
  }
  const contentId = resolveMetaContentId(productId, bundleId);
  return contentId.startsWith('bundle_') ? 2 : 1;
}

/**
 * Converts integer minor currency units (MYR sen / SGD cents) to a standard
 * 2-decimal major currency number (e.g. 3790 -> 37.9, 2290 -> 22.9).
 */
export function minorUnitsToMajorCurrency(minorUnits: number): number {
  if (!Number.isFinite(minorUnits) || minorUnits < 0) return 0;
  return Number((minorUnits / 100).toFixed(2));
}

/**
 * Generates a deterministic, stable Meta event_id for a verified Purchase event
 * bound strictly to the unique order reference. Shared verbatim by browser Pixel
 * and server-side Conversions API so Meta deduplicates both into one conversion.
 */
export function buildPurchaseEventId(orderReference: string): string {
  const cleanRef = (orderReference || '').trim().toUpperCase();
  return `purchase_${cleanRef}`;
}

/**
 * Builds canonical Meta ecommerce event parameters used identically by browser Pixel
 * and server-side Conversions API.
 */
export function buildMetaEcommerceParams(input: {
  productId: string;
  bundleId?: string | null;
  productName?: string | null;
  itemQuantity?: number | null;
  valueMinor: number;
  itemPriceMinor?: number | null;
  currency: SupportedCurrency;
  orderReference?: string | null;
}): MetaEcommerceParams {
  const contentId = resolveMetaContentId(input.productId, input.bundleId);
  const numItems = resolveMetaNumItems(input.productId, input.bundleId, input.itemQuantity);
  const value = minorUnitsToMajorCurrency(input.valueMinor);
  const itemPrice = minorUnitsToMajorCurrency(
    typeof input.itemPriceMinor === 'number' && input.itemPriceMinor >= 0
      ? input.itemPriceMinor
      : input.valueMinor
  );

  const params: MetaEcommerceParams = {
    content_ids: [contentId],
    contents: [
      {
        id: contentId,
        quantity: 1,
        item_price: itemPrice
      }
    ],
    content_type: 'product',
    value,
    currency: input.currency,
    num_items: numItems
  };

  if (input.productName && input.productName.trim()) {
    params.content_name = input.productName.trim().slice(0, 120);
  }
  if (input.orderReference && input.orderReference.trim()) {
    params.order_id = input.orderReference.trim();
  }

  return params;
}

const META_PIXEL_ID_REGEX = /^\d{5,25}$/;

export function isValidMetaPixelId(pixelId: string | null | undefined): boolean {
  return typeof pixelId === 'string' && META_PIXEL_ID_REGEX.test(pixelId.trim());
}
