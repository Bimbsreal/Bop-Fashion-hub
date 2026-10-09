"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { canPublish, prepareListingDraft, priceLabel, statusActions, type DraftFields } from "@/lib/commerce-form";

type Business = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  specialties: string[];
  description: string;
  inquiryNote: string;
  publication: string;
  verified: boolean;
  role: string | null;
};

type Pricing = { method: string; currency: string | null; amountMinor: number | null; amountMaxMinor: number | null; converted: boolean };
type Listing = {
  id: string;
  title: string;
  description: string;
  offering: string;
  status: string;
  availability: string;
  pricing: Pricing;
  organization: { id: string; name: string; slug: string };
  garment: { id: string; name: string; typeSlug: string } | null;
  role: string | null;
  verified: boolean;
};

type Garment = { id: string; name: string };

const kinds = ["studio", "tailor", "brand", "retailer"];
const emptyDraft: DraftFields = {
  offering: "custom_service",
  title: "",
  description: "",
  garmentId: "",
  designRevisionId: "",
  pricingMethod: "quote",
  currency: "",
  amountMinor: "",
  amountMaxMinor: "",
  availability: "unspecified",
  customizationNote: "",
  turnaroundNote: "",
};

export function CommerceDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [description, setDescription] = useState("");
  const [inquiryNote, setInquiryNote] = useState("");
  const [specialties, setSpecialties] = useState<string[]>(["tailor"]);
  const [publication, setPublication] = useState("draft");
  const [businessName, setBusinessName] = useState("");
  const [businessSlug, setBusinessSlug] = useState("");
  const [businessKind, setBusinessKind] = useState("tailor");
  const [listings, setListings] = useState<Listing[]>([]);
  const [draft, setDraft] = useState<DraftFields>(emptyDraft);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [publicListings, setPublicListings] = useState<Listing[]>([]);
  const [filters, setFilters] = useState({ offering: "", type: "", currency: "", organization: "", availability: "" });
  const [openListing, setOpenListing] = useState<Listing | null>(null);
  const [openBusiness, setOpenBusiness] = useState<Business | null>(null);

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
        if (!cancelled && response.ok && body.listings) setPublicListings(body.listings);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const business = businesses.find((item) => item.id === businessId) ?? null;
  const publisher = canPublish(business?.role ?? null);

  async function loadDiscovery(next: typeof filters) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value.trim()) params.set(key, value.trim());
    }
    const response = await fetch(`/api/v1/commerce/listings?${params.toString()}`);
    const body = (await response.json()) as { listings?: Listing[]; error?: { message: string } };
    if (!response.ok || !body.listings) {
      setNotice(body.error?.message ?? "Published listings could not be loaded.");
      setPublicListings([]);
      return;
    }
    setPublicListings(body.listings);
  }

  async function signIn(event: { preventDefault(): void }) {
    event.preventDefault();
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
    await refreshBusinesses();
  }

  async function registerAccount(event: { preventDefault(): void }) {
    event.preventDefault();
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
    await refreshBusinesses();
  }

  async function refreshBusinesses() {
    const [businessResponse, garmentResponse] = await Promise.all([
      fetch("/api/v1/commerce/businesses"),
      fetch("/api/v1/catalog/garments"),
    ]);
    if (!businessResponse.ok) {
      setNotice("Businesses could not be loaded.");
      return;
    }
    const body = (await businessResponse.json()) as { businesses: Business[] };
    setBusinesses(body.businesses);
    if (garmentResponse.ok) {
      const catalog = (await garmentResponse.json()) as { garments: Garment[] };
      setGarments(catalog.garments);
    }
    const next = body.businesses[0];
    if (next) {
      setBusinessId(next.id);
      applyBusiness(next);
      await refreshListings(next.id);
    }
  }

  function applyBusiness(next: Business) {
    setDescription(next.description);
    setInquiryNote(next.inquiryNote);
    setSpecialties(next.specialties);
    setPublication(next.publication);
  }

  async function refreshListings(id: string) {
    const response = await fetch(`/api/v1/commerce/businesses/${id}/listings`);
    const body = (await response.json()) as { listings?: Listing[]; error?: { message: string } };
    if (!response.ok || !body.listings) {
      setNotice(body.error?.message ?? "Listings could not be loaded.");
      setListings([]);
      return;
    }
    setListings(body.listings);
  }

  async function createBusiness(event: { preventDefault(): void }) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/v1/commerce/businesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: businessName, slug: businessSlug, kind: businessKind }),
    });
    const body = (await response.json()) as { business?: Business; error?: { message: string } };
    if (!response.ok || !body.business) {
      setNotice(body.error?.message ?? "The business could not be created.");
      return;
    }
    setBusinessName("");
    setBusinessSlug("");
    await refreshBusinesses();
    setNotice("Business profile saved as a draft. Creating a business does not verify it.");
  }

  async function saveProfile(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!business) return;
    setNotice("");
    const response = await fetch(`/api/v1/commerce/businesses/${business.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description, inquiryNote, specialties, publication }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "The profile could not be saved.");
      return;
    }
    await refreshBusinesses();
  }

  function toggleSpecialty(kind: string) {
    setSpecialties((current) => (current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]));
  }

  async function saveDraft(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!business) return;
    const prepared = prepareListingDraft(draft);
    if (!prepared.ok) {
      setNotice(prepared.message);
      return;
    }
    setNotice("");
    const response = await fetch(`/api/v1/commerce/businesses/${business.id}/listings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepared.body),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "The draft could not be saved.");
      return;
    }
    setDraft(emptyDraft);
    await refreshListings(business.id);
    setNotice("Draft saved. It is not public.");
  }

  async function changeStatus(listing: Listing, status: string) {
    setNotice("");
    const response = await fetch(`/api/v1/commerce/listings/${listing.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "That status change was not allowed.");
      return;
    }
    if (business) await refreshListings(business.id);
    await loadDiscovery(filters);
  }

  async function attachImage(listingId: string, file: File) {
    if (!business) return;
    setNotice("");
    const uploaded = await fetch(`/api/v1/media?organizationId=${business.id}&visibility=public`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-original-filename": file.name },
      body: file,
    });
    const uploadedBody = (await uploaded.json()) as { media?: { id: string }; error?: { message: string } };
    if (!uploaded.ok || !uploadedBody.media) {
      setNotice(uploadedBody.error?.message ?? "The image could not be stored.");
      return;
    }
    const attached = await fetch(`/api/v1/commerce/listings/${listingId}/media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: uploadedBody.media.id }),
    });
    const attachedBody = (await attached.json()) as { error?: { message: string } };
    if (!attached.ok) {
      setNotice(attachedBody.error?.message ?? "The image could not be attached.");
      return;
    }
    if (business) await refreshListings(business.id);
  }

  async function openPublicBusiness(id: string) {
    setNotice("");
    const response = await fetch(`/api/v1/commerce/businesses/${id}`);
    const body = (await response.json()) as { business?: Business; error?: { message: string } };
    if (!response.ok || !body.business) {
      setOpenBusiness(null);
      setNotice(body.error?.message ?? "That business profile is not public.");
      return;
    }
    setOpenBusiness(body.business);
  }

  async function openPublic(id: string) {
    setNotice("");
    const response = await fetch(`/api/v1/commerce/listings/${id}`);
    const body = (await response.json()) as { listing?: Listing; error?: { message: string } };
    if (!response.ok || !body.listing) {
      setOpenListing(null);
      setNotice(body.error?.message ?? "That listing is not public.");
      return;
    }
    setOpenListing(body.listing);
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Commerce</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Commerce</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/style">
            Style
          </Link>
          <Link className="text-ink underline" href="/orders">
            Orders
          </Link>
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        A listing is an offer from one business. The catalog garment stays shared. Prices stay in the currency the business entered.
        Nothing here takes payment or reserves stock.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}

      <section className="grid gap-4">
        <h2 className="text-sm tracking-[0.14em] uppercase">Published listings</h2>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void loadDiscovery(filters);
          }}
        >
          <Field label="Offering" value={filters.offering} onChange={(value) => setFilters({ ...filters, offering: value })} />
          <Field label="Garment type" value={filters.type} onChange={(value) => setFilters({ ...filters, type: value })} />
          <Field label="Currency" value={filters.currency} onChange={(value) => setFilters({ ...filters, currency: value })} />
          <Field label="Business slug" value={filters.organization} onChange={(value) => setFilters({ ...filters, organization: value })} />
          <Field label="Availability" value={filters.availability} onChange={(value) => setFilters({ ...filters, availability: value })} />
          <button className="border border-ink px-3 py-2 text-sm" type="submit">
            Apply filters
          </button>
        </form>
        {publicListings.length === 0 ? <p className="text-sm text-muted">No published listings match these filters.</p> : null}
        <ul className="grid gap-3">
          {publicListings.map((listing) => (
            <li key={listing.id} className="border border-ink/15 p-3">
              <button className="text-left" type="button" onClick={() => void openPublic(listing.id)}>
                <span className="block font-editorial text-2xl text-ink">{listing.title}</span>
                <span className="block text-sm text-muted">
                  {listing.organization.name} · {listing.offering.split("_").join(" ")} · {priceLabel(listing.pricing)} · {listing.availability}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {openListing ? (
          <article className="border border-ink/15 p-4">
            <h3 className="font-editorial text-2xl text-ink">{openListing.title}</h3>
            <p className="text-sm text-muted">
              {openListing.organization.name} · {priceLabel(openListing.pricing)}
              {openListing.pricing.converted ? "" : " · original currency"}
            </p>
            <p className="mt-2 text-sm leading-6">{openListing.description || "No description was provided."}</p>
            {openListing.garment ? <p className="mt-2 text-sm">Catalog garment: {openListing.garment.name}</p> : null}
            <button className="mt-3 text-sm underline" type="button" onClick={() => void openPublicBusiness(openListing.organization.id)}>
              Business profile
            </button>
          </article>
        ) : null}
        {openBusiness ? (
          <article className="border border-ink/15 p-4">
            <h3 className="font-editorial text-2xl text-ink">{openBusiness.name}</h3>
            <p className="text-sm text-muted">
              {openBusiness.specialties.join(", ")} · profile {openBusiness.publication}. Verification is not available.
            </p>
            <p className="mt-2 text-sm leading-6">{openBusiness.description || "No public description was provided."}</p>
            {openBusiness.inquiryNote ? <p className="mt-2 text-sm">Inquiry: {openBusiness.inquiryNote}</p> : null}
          </article>
        ) : null}
      </section>

      {signedIn ? null : (
        <form className="grid max-w-md gap-3">
          <h2 className="text-sm tracking-[0.14em] uppercase">Account</h2>
          <Field label="Display name" value={displayName} onChange={setDisplayName} />
          <Field label="Email" value={email} onChange={setEmail} />
          <label className="grid gap-1 text-sm">
            Password
            <input className="border border-ink/20 bg-paper px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="flex gap-3">
            <button className="bg-ink px-4 py-2 text-sm text-ivory" type="button" onClick={(event) => void signIn(event)}>
              Sign in
            </button>
            <button className="border border-ink px-4 py-2 text-sm" type="button" onClick={(event) => void registerAccount(event)}>
              Create account
            </button>
          </div>
        </form>
      )}

      {signedIn && businesses.length === 0 ? <p className="text-sm text-muted">You have no business profile.</p> : null}

      {signedIn ? (
        <form className="grid max-w-md gap-3" onSubmit={(event) => void createBusiness(event)}>
          <h2 className="text-sm tracking-[0.14em] uppercase">New business</h2>
          <Field label="Business name" value={businessName} onChange={setBusinessName} />
          <Field label="Slug" value={businessSlug} onChange={setBusinessSlug} />
          <label className="grid gap-1 text-sm">
            Primary kind
            <select className="border border-ink/20 bg-paper px-3 py-2" value={businessKind} onChange={(event) => setBusinessKind(event.target.value)}>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <button className="border border-ink px-3 py-2 text-sm" type="submit">
            Save business draft
          </button>
        </form>
      ) : null}

      {business ? (
        <section className="grid gap-6">
          <form className="grid gap-3" onSubmit={(event) => void saveProfile(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">{business.name}</h2>
            <p className="text-sm text-muted">
              Publication: {business.publication}. Role: {business.role}. Verification is not available.
            </p>
            <Field label="Public description" value={description} onChange={setDescription} />
            <Field label="Inquiry note" value={inquiryNote} onChange={setInquiryNote} />
            <fieldset className="grid gap-2 text-sm">
              <legend>Specialties</legend>
              {kinds.map((kind) => (
                <label key={kind} className="flex gap-2">
                  <input type="checkbox" checked={specialties.includes(kind)} onChange={() => toggleSpecialty(kind)} disabled={!publisher} />
                  {kind}
                </label>
              ))}
            </fieldset>
            <label className="grid gap-1 text-sm">
              Profile publication
              <select className="border border-ink/20 bg-paper px-3 py-2" value={publication} onChange={(event) => setPublication(event.target.value)} disabled={!publisher}>
                <option value="draft">draft</option>
                <option value="published">published</option>
              </select>
            </label>
            {publisher ? (
              <button className="border border-ink px-3 py-2 text-sm" type="submit">
                Save profile
              </button>
            ) : (
              <p className="text-sm text-muted">Only an owner or admin can update this profile.</p>
            )}
          </form>

          <form className="grid gap-3" onSubmit={(event) => void saveDraft(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">New listing</h2>
            <label className="grid gap-1 text-sm">
              Offering
              <select className="border border-ink/20 bg-paper px-3 py-2" value={draft.offering} onChange={(event) => setDraft({ ...draft, offering: event.target.value })}>
                <option value="ready_to_wear">ready to wear</option>
                <option value="made_to_order">made to order</option>
                <option value="custom_service">custom service</option>
                <option value="design_commission">design commission</option>
              </select>
            </label>
            <Field label="Title" value={draft.title} onChange={(value) => setDraft({ ...draft, title: value })} />
            <Field label="Description" value={draft.description} onChange={(value) => setDraft({ ...draft, description: value })} />
            <label className="grid gap-1 text-sm">
              Catalog garment
              <select className="border border-ink/20 bg-paper px-3 py-2" value={draft.garmentId} onChange={(event) => setDraft({ ...draft, garmentId: event.target.value })}>
                <option value="">No garment</option>
                {garments.map((garment) => (
                  <option key={garment.id} value={garment.id}>
                    {garment.name}
                  </option>
                ))}
              </select>
            </label>
            <Field label="Design revision id" value={draft.designRevisionId} onChange={(value) => setDraft({ ...draft, designRevisionId: value })} />
            <label className="grid gap-1 text-sm">
              Pricing
              <select className="border border-ink/20 bg-paper px-3 py-2" value={draft.pricingMethod} onChange={(event) => setDraft({ ...draft, pricingMethod: event.target.value })}>
                <option value="fixed">fixed</option>
                <option value="starting">starting</option>
                <option value="range">range</option>
                <option value="quote">quote required</option>
              </select>
            </label>
            <Field label="Currency" value={draft.currency} onChange={(value) => setDraft({ ...draft, currency: value })} />
            <Field label="Amount in minor units" value={draft.amountMinor} onChange={(value) => setDraft({ ...draft, amountMinor: value })} />
            <Field label="Maximum minor units" value={draft.amountMaxMinor} onChange={(value) => setDraft({ ...draft, amountMaxMinor: value })} />
            <label className="grid gap-1 text-sm">
              Availability
              <select className="border border-ink/20 bg-paper px-3 py-2" value={draft.availability} onChange={(event) => setDraft({ ...draft, availability: event.target.value })}>
                <option value="unspecified">unspecified</option>
                <option value="available">available</option>
                <option value="unavailable">unavailable</option>
              </select>
            </label>
            <Field label="Customization" value={draft.customizationNote} onChange={(value) => setDraft({ ...draft, customizationNote: value })} />
            <Field label="Turnaround" value={draft.turnaroundNote} onChange={(value) => setDraft({ ...draft, turnaroundNote: value })} />
            <button className="border border-ink px-3 py-2 text-sm" type="submit">
              Save draft
            </button>
          </form>

          <div className="grid gap-3">
            <h2 className="text-sm tracking-[0.14em] uppercase">This business</h2>
            {listings.length === 0 ? <p className="text-sm text-muted">This business has no listings.</p> : null}
            <ul className="grid gap-3">
              {listings.map((listing) => (
                <li key={listing.id} className="grid gap-2 border border-ink/15 p-3">
                  <p className="font-editorial text-2xl text-ink">{listing.title}</p>
                  <p className="text-sm text-muted">
                    {listing.status} · {listing.offering.split("_").join(" ")} · {priceLabel(listing.pricing)} · {listing.availability}
                  </p>
                  {publisher ? (
                    <div className="flex flex-wrap gap-2">
                      {statusActions(listing.status, business.role).map((status) => (
                        <button key={status} className="border border-ink px-3 py-2 text-sm" type="button" onClick={() => void changeStatus(listing, status)}>
                          {status}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted">Only an owner or admin can publish, pause, or archive.</p>
                  )}
                  {listing.status === "archived" ? <p className="text-sm text-muted">Archived listings stay archived.</p> : null}
                  {listing.status !== "archived" ? (
                    <label className="text-sm">
                      Public image
                      <input
                        className="mt-1 block text-sm"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void attachImage(listing.id, file);
                        }}
                      />
                    </label>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <input className="border border-ink/20 bg-paper px-3 py-2" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
