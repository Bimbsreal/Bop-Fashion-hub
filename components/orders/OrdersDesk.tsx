"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { businessStatusActions, customerCanCancel, orderPriceLabel, prepareOrder } from "@/lib/order-form";
import { canRequestPayment, preparePayment, simulatedPaymentLabel } from "@/lib/payment-form";

type Listing = {
  id: string;
  title: string;
  offering: string;
  availability: string;
  organization: { name: string };
  pricing: { method: string; currency: string | null; amountMinor: number | null; amountMaxMinor: number | null };
};

type Quote = { id: string; status: string; currency: string; amountMinor: number; note: string };
type Order = {
  id: string;
  title: string;
  status: string;
  offering: string;
  quantity: number;
  customizationNote: string;
  paid: boolean;
  stockReserved: boolean;
  customer: boolean;
  role: string | null;
  organization: { id: string; name: string };
  pricing: {
    method: string;
    currency: string | null;
    agreedAmountMinor: number | null;
    unitAmountMinor: number | null;
  };
  quotations: Quote[];
  events: { id: string; toStatus: string; kind: string }[];
  measurements: { definition: string; canonicalCm: string; enteredUnit: string }[];
};

type Business = { id: string; name: string; role: string | null };
type PaymentView = {
  id: string;
  orderId: string;
  state: string;
  amountMinor: number;
  currency: string;
  simulated: boolean;
  realMoney: boolean;
  externallyConfirmed: boolean;
};

export function OrdersDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [listings, setListings] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [open, setOpen] = useState<Order | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [inbox, setInbox] = useState<Order[]>([]);
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteCurrency, setQuoteCurrency] = useState("NGN");
  const [payment, setPayment] = useState<PaymentView | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void fetch("/api/v1/commerce/listings")
      .then(async (response) => {
        const body = (await response.json()) as { listings?: Listing[] };
        if (!cancelled && response.ok && body.listings) setListings(body.listings);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const business = businesses.find((item) => item.id === businessId) ?? null;

  async function registerAccount() {
    setNotice("");
    const response = await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, displayName, password }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "The account could not be created.");
      return;
    }
    setSignedIn(true);
    await refreshMine();
  }

  async function signIn() {
    setNotice("");
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      setNotice("Sign-in did not succeed.");
      return;
    }
    setSignedIn(true);
    await refreshMine();
  }

  async function refreshMine() {
    const [orderResponse, businessResponse] = await Promise.all([
      fetch("/api/v1/orders"),
      fetch("/api/v1/commerce/businesses"),
    ]);
    if (orderResponse.ok) {
      const body = (await orderResponse.json()) as { orders: Order[] };
      setOrders(body.orders);
    }
    if (businessResponse.ok) {
      const body = (await businessResponse.json()) as { businesses: Business[] };
      setBusinesses(body.businesses);
      const next = body.businesses[0];
      if (next) {
        setBusinessId(next.id);
        await refreshInbox(next.id);
      }
    }
  }

  async function refreshInbox(id: string) {
    const response = await fetch(`/api/v1/orders?organizationId=${id}`);
    const body = (await response.json()) as { orders?: Order[]; error?: { message: string } };
    if (!response.ok || !body.orders) {
      setNotice(body.error?.message ?? "Business orders could not be loaded.");
      setInbox([]);
      return;
    }
    setInbox(body.orders);
  }

  async function submitOrder() {
    if (!selected) return;
    const prepared = prepareOrder({
      listingId: selected.id,
      offering: selected.offering,
      quantity,
      customizationNote: note,
    });
    if (!prepared.ok) {
      setNotice(prepared.message);
      return;
    }
    setNotice("");
    const response = await fetch("/api/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepared.body),
    });
    const body = (await response.json()) as { order?: Order; error?: { message: string } };
    if (!response.ok || !body.order) {
      setNotice(body.error?.message ?? "The order could not be submitted.");
      return;
    }
    setOpen(body.order);
    setNote("");
    await refreshMine();
    setNotice("Order submitted. Payment is not collected.");
  }

  async function openOrder(id: string) {
    const response = await fetch(`/api/v1/orders/${id}`);
    const body = (await response.json()) as { order?: Order; error?: { message: string } };
    if (!response.ok || !body.order) {
      setNotice(body.error?.message ?? "That order is not available.");
      return;
    }
    setOpen(body.order);
    await loadPayment(id);
  }

  async function loadPayment(orderId: string) {
    const response = await fetch(`/api/v1/payments?orderId=${orderId}`);
    if (!response.ok) {
      setPayment(null);
      return;
    }
    const body = (await response.json()) as { payments?: PaymentView[] };
    const current = body.payments?.find((item) => item.state === "pending" || item.state === "captured") ?? body.payments?.[0] ?? null;
    setPayment(current);
  }

  async function requestSimulated(orderId: string) {
    setNotice("");
    const response = await fetch("/api/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preparePayment(orderId)),
    });
    const body = (await response.json()) as { payment?: PaymentView; error?: { message: string } };
    if (!response.ok || !body.payment) {
      setNotice(body.error?.message ?? "The simulated payment could not be requested.");
      return;
    }
    setPayment(body.payment);
    setNotice("Simulated payment requested. No card was charged.");
  }

  async function confirmSimulated(paymentId: string) {
    setNotice("");
    const response = await fetch(`/api/v1/payments/${paymentId}/simulation/confirm`, { method: "POST" });
    const body = (await response.json()) as { payment?: PaymentView; error?: { message: string } };
    if (!response.ok || !body.payment) {
      setNotice(body.error?.message ?? "The simulated confirmation was not recorded.");
      return;
    }
    setPayment(body.payment);
    setNotice("Simulated confirmation stored. The order is not marked paid.");
  }

  async function cancelSimulated(paymentId: string) {
    setNotice("");
    const response = await fetch(`/api/v1/payments/${paymentId}/cancel`, { method: "POST" });
    const body = (await response.json()) as { payment?: PaymentView; error?: { message: string } };
    if (!response.ok || !body.payment) {
      setNotice(body.error?.message ?? "The simulated payment could not be cancelled.");
      return;
    }
    setPayment(body.payment);
    setNotice("Simulated payment cancelled. No money moved.");
  }

  async function post(path: string, payload?: unknown) {
    setNotice("");
    const response = await fetch(path, {
      method: "POST",
      headers: payload === undefined ? undefined : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await response.json()) as { order?: Order; error?: { message: string } };
    if (!response.ok || !body.order) {
      setNotice(body.error?.message ?? "That order action was not allowed.");
      return;
    }
    setOpen(body.order);
    await refreshMine();
    if (businessId) await refreshInbox(businessId);
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Orders</h1>
      </main>
    );
  }

  const issued = open?.quotations.find((item) => item.status === "issued") ?? null;

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Orders</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/commerce">
            Commerce
          </Link>
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        An order records a request against a published listing. The agreed amount stays in the listing currency. Submitting an order
        does not take payment or reserve stock.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}

      <section className="grid gap-3">
        <h2 className="text-sm tracking-[0.14em] uppercase">Published listings</h2>
        {listings.length === 0 ? <p className="text-sm text-muted">No published listings are available to order.</p> : null}
        <ul className="grid gap-3">
          {listings.map((listing) => (
            <li key={listing.id}>
              <button className="border border-ink/15 p-3 text-left" type="button" onClick={() => setSelected(listing)}>
                <span className="block font-editorial text-2xl text-ink">{listing.title}</span>
                <span className="block text-sm text-muted">
                  {listing.organization.name} · {listing.offering.split("_").join(" ")} · {listing.pricing.method} · {listing.availability}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOrder();
            }}
          >
            <h3 className="font-editorial text-2xl text-ink">{selected.title}</h3>
            <p className="text-sm text-muted">Availability on the listing is not a stock count.</p>
            <label className="grid gap-1 text-sm">
              Quantity
              <input className="border border-ink/20 bg-paper px-3 py-2" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              Customization
              <input className="border border-ink/20 bg-paper px-3 py-2" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button className="border border-ink px-3 py-2 text-sm" type="submit" disabled={!signedIn}>
              Submit order
            </button>
            {signedIn ? null : <p className="text-sm text-muted">Sign in before submitting an order.</p>}
          </form>
        ) : null}
      </section>

      {signedIn ? null : (
        <form className="grid max-w-md gap-3">
          <h2 className="text-sm tracking-[0.14em] uppercase">Account</h2>
          <label className="grid gap-1 text-sm">
            Display name
            <input className="border border-ink/20 bg-paper px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Email
            <input className="border border-ink/20 bg-paper px-3 py-2" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Password
            <input className="border border-ink/20 bg-paper px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="flex gap-3">
            <button className="bg-ink px-4 py-2 text-sm text-ivory" type="button" onClick={() => void signIn()}>
              Sign in
            </button>
            <button className="border border-ink px-4 py-2 text-sm" type="button" onClick={() => void registerAccount()}>
              Create account
            </button>
          </div>
        </form>
      )}

      {signedIn ? (
        <section className="grid gap-3">
          <h2 className="text-sm tracking-[0.14em] uppercase">Your orders</h2>
          {orders.length === 0 ? <p className="text-sm text-muted">You have no orders.</p> : null}
          <ul className="grid gap-2">
            {orders.map((order) => (
              <li key={order.id}>
                <button className="text-left text-sm underline" type="button" onClick={() => void openOrder(order.id)}>
                  {order.title} · {order.status} · {orderPriceLabel({ ...order.pricing, quantity: order.quantity })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <article className="grid gap-3 border border-ink/15 p-4">
          <h2 className="font-editorial text-2xl text-ink">{open.title}</h2>
          <p className="text-sm text-muted">
            {open.organization.name} · {open.status} · {orderPriceLabel({ ...open.pricing, quantity: open.quantity })}
          </p>
          <p className="text-sm">This order is not marked paid. Stock is not reserved.</p>
          {open.customer && canRequestPayment(open.status, open.pricing.agreedAmountMinor, open.pricing.currency) ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted">
                {payment ? simulatedPaymentLabel(payment.state) : "A simulated payment can be requested. It does not charge a card."}
              </p>
              {payment ? (
                <p className="text-sm">
                  {payment.currency} {payment.amountMinor} minor units · {payment.state} · simulated {String(payment.simulated)} · real money{" "}
                  {String(payment.realMoney)}
                </p>
              ) : null}
              {payment?.state === "pending" ? (
                <div className="flex gap-2">
                  <button className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void confirmSimulated(payment.id)}>
                    Record simulated confirmation
                  </button>
                  <button className="px-3 py-2 text-sm underline" type="button" onClick={() => void cancelSimulated(payment.id)}>
                    Cancel simulated payment
                  </button>
                </div>
              ) : null}
              {!payment || payment.state === "failed" || payment.state === "cancelled" ? (
                <button className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void requestSimulated(open.id)}>
                  Request simulated payment
                </button>
              ) : null}
            </div>
          ) : null}
          {open.customizationNote ? <p className="text-sm">{open.customizationNote}</p> : null}
          {open.measurements.length > 0 ? (
            <ul className="text-sm">
              {open.measurements.map((item) => (
                <li key={item.definition}>
                  {item.definition}: {item.canonicalCm} cm
                </li>
              ))}
            </ul>
          ) : null}
          <ol className="text-sm text-muted">
            {open.events.map((event) => (
              <li key={event.id}>
                {event.kind}: {event.toStatus}
              </li>
            ))}
          </ol>
          {open.customer && customerCanCancel(open.status) ? (
            <button className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void post(`/api/v1/orders/${open.id}/cancel`)}>
              Cancel order
            </button>
          ) : null}
          {open.customer && issued ? (
            <div className="flex gap-2">
              <button className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void post(`/api/v1/orders/${open.id}/quotations/${issued.id}/accept`)}>
                Accept {issued.currency} {issued.amountMinor}
              </button>
              <button className="px-3 py-2 text-sm underline" type="button" onClick={() => void post(`/api/v1/orders/${open.id}/quotations/${issued.id}/reject`)}>
                Reject quotation
              </button>
            </div>
          ) : null}
        </article>
      ) : null}

      {signedIn && businesses.length === 0 ? <p className="text-sm text-muted">You have no business orders to manage.</p> : null}
      {business ? (
        <section className="grid gap-3">
          <h2 className="text-sm tracking-[0.14em] uppercase">{business.name} orders</h2>
          <p className="text-sm text-muted">Role: {business.role}. A member can read orders. An owner or admin can move them.</p>
          {inbox.length === 0 ? <p className="text-sm text-muted">This business has no orders.</p> : null}
          <ul className="grid gap-3">
            {inbox.map((order) => (
              <li key={order.id} className="grid gap-2 border border-ink/15 p-3">
                <button className="text-left" type="button" onClick={() => void openOrder(order.id)}>
                  <span className="font-editorial text-2xl text-ink">{order.title}</span>
                  <span className="block text-sm text-muted">
                    {order.status} · {orderPriceLabel({ ...order.pricing, quantity: order.quantity })}
                  </span>
                </button>
                <div className="flex flex-wrap gap-2">
                  {businessStatusActions(order.status, order.offering, order.pricing.method, business.role).map((status) => (
                    <button key={status} className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void post(`/api/v1/orders/${order.id}/status`, { status })}>
                      {status}
                    </button>
                  ))}
                </div>
                {order.status === "awaiting_quotation" && (business.role === "owner" || business.role === "admin") ? (
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!/^\d+$/.test(quoteAmount.trim()) || !/^[A-Z]{3}$/.test(quoteCurrency.trim())) {
                        setNotice("Enter a three-letter currency and a whole minor-unit amount.");
                        return;
                      }
                      void post(`/api/v1/orders/${order.id}/quotations`, { currency: quoteCurrency.trim(), amountMinor: Number(quoteAmount.trim()) });
                    }}
                  >
                    <input className="border border-ink/20 bg-paper px-3 py-2 text-sm" value={quoteCurrency} onChange={(event) => setQuoteCurrency(event.target.value)} />
                    <input className="border border-ink/20 bg-paper px-3 py-2 text-sm" value={quoteAmount} onChange={(event) => setQuoteAmount(event.target.value)} />
                    <button className="border border-ink px-3 py-2 text-sm" type="submit">
                      Issue quotation
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
