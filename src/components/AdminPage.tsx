import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Lock,
  LogOut,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react';
import type { AdminConfigDiagnostics, OrderPublic } from '../types/order';

interface AdminPageProps {
  onBackToShop: () => void;
  onOpenOrderPayment: (reference: string) => void;
}

const formatRM = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

const getAccountToCheck = (order: OrderPublic): { accountTag: string; instruction: string } => {
  if (order.paymentMethod === 'tng') {
    return {
      accountTag: 'TNG — Touch ’n Go eWallet',
      instruction: 'Check incoming transfer in Touch ’n Go eWallet account'
    };
  }
  if (order.paymentMethod === 'duitnow') {
    return {
      accountTag: 'Public Bank — QR Pay',
      instruction: 'Check incoming transfer in Public Bank account'
    };
  }
  if (order.paymentMethod === 'card') {
    return {
      accountTag: 'Stripe Card Checkout',
      instruction: 'Confirmed automatically by Stripe webhook'
    };
  }
  return {
    accountTag: 'Not selected yet',
    instruction: 'Customer has not submitted payment yet'
  };
};

export default function AdminPage({ onBackToShop, onOpenOrderPayment }: AdminPageProps) {
  const [authMode, setAuthMode] = useState<'loading' | 'env' | 'claimed' | 'bootstrap_required'>('loading');
  // Session token kept strictly in React memory (never localStorage or sessionStorage)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [confirmPasscodeInput, setConfirmPasscodeInput] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [orders, setOrders] = useState<OrderPublic[]>([]);
  const [diagnostics, setDiagnostics] = useState<AdminConfigDiagnostics | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'awaiting' | 'paid'>('all');

  // Verification action state
  const [confirmingRef, setConfirmingRef] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState('');
  const [actionBusyRef, setActionBusyRef] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // In-app private receipt preview modal
  const [receiptPreview, setReceiptPreview] = useState<{
    reference: string;
    fileName: string;
    mimeType: string;
    objectUrl: string;
  } | null>(null);
  const [loadingReceiptRef, setLoadingReceiptRef] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/auth-status')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.mode) {
          setAuthMode(data.mode);
        } else {
          setAuthMode('env');
        }
      })
      .catch(() => setAuthMode('env'));
  }, []);

  // Revoke object URL on unmount or modal change
  useEffect(() => {
    return () => {
      if (receiptPreview?.objectUrl) {
        URL.revokeObjectURL(receiptPreview.objectUrl);
      }
    };
  }, [receiptPreview]);

  const fetchAdminOrders = useCallback(async (token: string) => {
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
      } else {
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
      fetchAdminOrders(authToken);
    }
  }, [authToken, fetchAdminOrders]);

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
    setConfirmingRef(null);
  };

  const handleViewReceipt = async (order: OrderPublic) => {
    if (!authToken) return;
    setLoadingReceiptRef(order.reference);
    setDashboardError(null);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(order.reference)}/receipt`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.status === 401) {
        setAuthToken(null);
        setAuthError('Session expired. Please sign in again.');
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setDashboardError(errData.error || 'Unable to load private receipt.');
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      setReceiptPreview({
        reference: order.reference,
        fileName: order.receiptFileName || 'receipt',
        mimeType: blob.type || order.receiptMimeType || 'image/jpeg',
        objectUrl
      });
    } catch {
      setDashboardError('Failed to fetch private receipt.');
    } finally {
      setLoadingReceiptRef(null);
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
        setActionFeedback(`Order ${reference} verified and marked as Paid.`);
      } else {
        setDashboardError(data.error || 'Could not mark order as paid.');
      }
    } catch {
      setDashboardError('Network error while verifying payment.');
    } finally {
      setActionBusyRef(null);
    }
  };

  const handleRejectReceipt = async (reference: string) => {
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
              'Incoming transfer could not be matched. Please verify recipient name and exact amount, then re-upload your receipt.'
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
        setActionFeedback(`Order ${reference} returned to Awaiting payment for receipt resubmission.`);
      } else {
        setDashboardError(data.error || 'Could not return receipt.');
      }
    } catch {
      setDashboardError('Network error while updating order.');
    } finally {
      setActionBusyRef(null);
    }
  };

  const filteredOrders = orders.filter(order => {
    if (filter === 'pending') return order.paymentStatus === 'Pending verification';
    if (filter === 'awaiting') return order.paymentStatus === 'Awaiting payment';
    if (filter === 'paid') return order.paymentStatus === 'Paid';
    return true;
  });

  const pendingCount = orders.filter(o => o.paymentStatus === 'Pending verification').length;
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
                : 'Staff Order Verification'}
            </h1>
            <p className="text-xs text-[#14233C]/70 leading-relaxed">
              {authMode === 'bootstrap_required'
                ? 'Create a one-time staff passcode to protect order verification and private payment receipts. Setting ADMIN_PASSCODE on the server always overrides this setup.'
                : 'Sign in with your staff passcode to inspect TNG and Public Bank payment receipts and confirm paid orders.'}
            </p>
          </div>

          {authMode === 'loading' ? (
            <p className="text-xs text-[#14233C]/60">Checking admin access status…</p>
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
            Staff Payment Verification
          </h1>
          <p className="text-xs text-[#14233C]/70">
            Check the exact account selected by the customer (TNG or Public Bank) before marking any
            manual QR order as Paid.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={loadingOrders}
            onClick={() => fetchAdminOrders(authToken)}
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

      {/* Independent Payment Method Configuration Health */}
      {diagnostics && (
        <section className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-4">
          <h2 className="text-sm font-bold text-[#14233C]">
            Active Payment Methods Configuration
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            {[diagnostics.tng, diagnostics.duitnow].map(item => (
              <div
                key={item.key}
                className="p-4 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[#14233C]">{item.label}</span>
                  <span
                    className={`font-bold ${item.configured ? 'text-emerald-800' : 'text-amber-800'}`}
                  >
                    {item.configured ? 'Visible' : 'Hidden'}
                  </span>
                </div>
                {item.configured ? (
                  <>
                    <p className="text-[#14233C]/75">Recipient: {item.recipientName}</p>
                    <p className="font-mono text-[11px] text-[#14233C]/60 truncate">
                      Image: {item.qrImage}
                    </p>
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

            <div className="p-4 rounded-xl bg-[#FAF6EE]/70 border border-[#14233C]/10 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-[#14233C]">Credit or Debit Card (Stripe)</span>
                <span
                  className={`font-bold ${
                    diagnostics.stripe.configured ? 'text-emerald-800' : 'text-[#14233C]/65'
                  }`}
                >
                  {diagnostics.stripe.configured
                    ? diagnostics.stripe.mode === 'test'
                      ? 'Test Mode'
                      : 'Live Mode'
                    : 'Not Configured'}
                </span>
              </div>
              <p className="text-[#14233C]/70">
                {diagnostics.stripe.configured
                  ? 'Card payments confirm automatically via verified Stripe webhook.'
                  : diagnostics.stripe.issue || 'QR options operate independently while Stripe is disabled.'}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Alerts / Feedback */}
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

      {/* Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-white border border-[#14233C]/12 rounded-xl">
          {(
            [
              { key: 'all', label: `All (${orders.length})` },
              { key: 'pending', label: `Pending Verification (${pendingCount})` },
              {
                key: 'awaiting',
                label: `Awaiting Payment (${orders.length - pendingCount - paidCount})`
              },
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

      {/* Orders List */}
      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#14233C]/12 p-10 text-center text-sm text-[#14233C]/65">
          {loadingOrders ? 'Loading orders…' : 'No orders match this filter.'}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredOrders.map(order => {
            const accountInfo = getAccountToCheck(order);
            const isPending = order.paymentStatus === 'Pending verification';
            const isPaid = order.paymentStatus === 'Paid';
            const isConfirming = confirmingRef === order.reference;

            return (
              <article
                key={order.reference}
                className="bg-white rounded-2xl border border-[#14233C]/12 p-6 space-y-4"
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1.5">
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
                              : 'text-[#14233C]/80'
                        }`}
                      >
                        {isPaid && <CheckCircle2 className="w-3.5 h-3.5" />}
                        {isPending && <Clock className="w-3.5 h-3.5" />}
                        <span>{order.paymentStatus}</span>
                      </span>
                    </div>

                    <p className="text-sm font-bold text-[#14233C]">
                      {order.customer.fullName} — {order.productName} (Qty {order.itemQuantity})
                    </p>
                    <p className="text-xs text-[#14233C]/70">
                      {order.customer.email} · {order.customer.mobile} · {order.customer.city},{' '}
                      {order.customer.state}
                    </p>
                  </div>

                  <div className="md:text-right shrink-0">
                    <p className="text-[11px] font-semibold text-[#14233C]/60">Saved Order Total</p>
                    <p className="text-xl font-extrabold tabular-nums text-[#E05A40]">
                      {formatRM(order.totalSen)}
                    </p>
                  </div>
                </div>

                {/* Account-to-Check & Receipt Row */}
                <div className="pt-4 border-t border-[#14233C]/10 grid grid-cols-1 md:grid-cols-12 gap-4 items-center text-xs">
                  <div className="md:col-span-5 space-y-0.5">
                    <p className="text-[#14233C]/60 font-semibold">Account to Check</p>
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

                  <div className="md:col-span-3 flex flex-wrap md:justify-end gap-2">
                    {order.receiptSubmitted && (
                      <button
                        type="button"
                        disabled={loadingReceiptRef === order.reference}
                        onClick={() => handleViewReceipt(order)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#14233C]/20 text-xs font-bold text-[#14233C] hover:bg-[#FAF6EE] transition-colors whitespace-nowrap shrink-0"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>
                          {loadingReceiptRef === order.reference ? 'Opening…' : 'View Receipt'}
                        </span>
                      </button>
                    )}

                    {isPending && !isConfirming && (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingRef(order.reference);
                          setVerifyNote('');
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Verify Payment</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onOpenOrderPayment(order.reference)}
                      className="px-3 py-2 rounded-xl text-xs font-semibold text-[#14233C]/70 hover:text-[#14233C] underline whitespace-nowrap shrink-0"
                    >
                      Customer Link
                    </button>
                  </div>
                </div>

                {/* Staff Explicit Confirmation Step before Marking Paid */}
                {isPending && isConfirming && (
                  <div className="pt-4 border-t border-[#14233C]/10 bg-[#FAF6EE] -mx-6 -mb-6 p-6 rounded-b-2xl space-y-4">
                    <div className="space-y-1 text-xs">
                      <p className="font-extrabold text-[#14233C] text-sm">
                        Confirm incoming payment before marking Paid
                      </p>
                      <p className="text-[#14233C]/80">
                        Verify that{' '}
                        <strong className="tabular-nums text-[#E05A40]">
                          {formatRM(order.totalSen)}
                        </strong>{' '}
                        arrived in <strong>{accountInfo.accountTag}</strong> matching reference{' '}
                        <strong className="font-mono">{order.transactionReference}</strong>.
                      </p>
                    </div>

                    <input
                      type="text"
                      maxLength={240}
                      placeholder="Optional staff verification note (or rejection reason)"
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
                        onClick={() => handleRejectReceipt(order.reference)}
                        className="px-4 py-2.5 rounded-xl border border-amber-700/30 bg-white text-amber-900 text-xs font-bold hover:bg-amber-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                      >
                        Request New Receipt
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

                {isPaid && order.verificationNote && (
                  <p className="text-xs text-emerald-900 pt-2 border-t border-[#14233C]/10">
                    Staff verification note: {order.verificationNote}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Private Receipt Preview Modal */}
      {receiptPreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Receipt preview for ${receiptPreview.reference}`}
          className="fixed inset-0 z-50 bg-[#14233C]/60 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden border border-[#14233C]/15">
            <div className="px-5 py-4 border-b border-[#14233C]/10 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-bold text-[#14233C] truncate">
                  Private Receipt · {receiptPreview.reference}
                </p>
                <p className="text-xs text-[#14233C]/65 truncate">{receiptPreview.fileName}</p>
              </div>
              <button
                type="button"
                onClick={() => setReceiptPreview(null)}
                aria-label="Close receipt preview"
                className="p-2 rounded-lg text-[#14233C]/70 hover:bg-[#FAF6EE] hover:text-[#14233C]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-auto flex-1 bg-[#FAF6EE] flex items-center justify-center">
              {receiptPreview.mimeType === 'application/pdf' ? (
                <iframe
                  src={receiptPreview.objectUrl}
                  title={`PDF receipt for ${receiptPreview.reference}`}
                  className="w-full h-[65vh] rounded-xl border border-[#14233C]/15 bg-white"
                />
              ) : (
                <img
                  src={receiptPreview.objectUrl}
                  alt={`Payment receipt for ${receiptPreview.reference}`}
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
