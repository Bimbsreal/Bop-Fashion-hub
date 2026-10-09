# Bop fashion commerce

Commercial listings are **implemented** for local development. Live checkout, inventory counts, shipping, and appointment booking are **not implemented**. Simulated payment records are separate. See `docs/bop-payment-integration-architecture.md`.

A catalog garment describes a fashion item. A commercial listing is an offer from one organization. Creating a business or publishing a listing does not verify either one. `verified` is always `false` in API responses and cannot be set by a client.

## Domain

| Concept | Meaning | Where |
| --- | --- | --- |
| Organization | The business. One primary kind: `studio`, `tailor`, `brand`, or `retailer` | `organizations`, `organization_memberships` |
| Business profile | Public description, inquiry note, logo, and profile publication | `organization_profiles` |
| Specialties | Extra kinds the same business may offer | `organization_specialties` |
| Commercial listing | One offer owned by one organization | `commercial_listings` |
| Listing media | Images the business attached to that offer | `commercial_listing_media` |
| Listing event | A recorded status change | `commercial_listing_events` |

There is no second organization table for designers, tailors, brands, or retailers. A tailor can also record a retailer specialty. The primary `organizations.kind` stays as it was created.

Orders live in the order phase. Simulated payment tables live in the payment phase. There is still no stock quantity or verification table.

## Catalog and listing

`garments` remains the shared catalog. A listing may point at a garment the actor can already read. Changing a listing price does not update the garment or another business's listing.

Offering types:

| Offering | Garment | Design revision |
| --- | --- | --- |
| `ready_to_wear` | Required | Optional |
| `made_to_order` | Optional | Optional |
| `custom_service` | Optional | Optional |
| `design_commission` | Optional | Required, and the revision's project must be owned by the same organization |

A tailoring service can be a `custom_service` with no garment. A user-owned design project cannot be attached to a business listing.

A size on a listing must already be assigned on that garment. The public listing view includes the garment name and identifying terms. It does not include measurements or storage keys. A private garment stays private on the catalog API.

Public design information is the project id, project name, and revision number. Revision notes and the project description are not returned.

## Pricing

Methods are `fixed`, `starting`, `range`, and `quote`.

Amounts are non-negative integers in minor units, from 0 through 1,000,000,000. Currency is a three-letter uppercase code stored as supplied. Quote listings store no currency and no amounts. A range requires a maximum at least as large as the minimum. Values are not converted. Responses include `converted: false`.

Availability is `available`, `unavailable`, or `unspecified`. Unspecified is the default. It is not a stock count.

## Lifecycle

New listings are `draft`.

| From | Allowed next |
| --- | --- |
| `draft` | `published`, `archived` |
| `published` | `paused`, `archived` |
| `paused` | `published`, `archived` |
| `archived` | none |

Status changes go through `POST /api/v1/commerce/listings/:id/status`. A listing update cannot set status. Entering `published` sets `published_at`. Other transitions leave that timestamp as it was. Archived listings cannot be edited.

Any active member can create and edit a listing that is not archived. Only an owner or admin can publish, pause, archive, or update the business profile. Someone who is not a member receives 404 for business and listing management, so the identifier is not confirmed. A member who tries to publish receives 403.

Public discovery returns listings whose status is `published` and whose organization is `active`. Draft, paused, and archived listings are omitted. An unpublished business profile is omitted from public profile reads.

## API

Base: `http://localhost:5000/api/v1`

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/commerce/businesses` | Signed-in member's businesses |
| `POST` | `/commerce/businesses` | Creates an organization and owner membership |
| `GET` | `/commerce/businesses/:id` | Members, or anyone if the profile is published |
| `PATCH` | `/commerce/businesses/:id` | Owner or admin |
| `GET` | `/commerce/businesses/:id/listings` | Active members |
| `POST` | `/commerce/businesses/:id/listings` | Active members, creates a draft |
| `GET` | `/commerce/listings` | Public discovery |
| `GET` | `/commerce/listings/:id` | Members, or anyone if the listing is published |
| `PATCH` | `/commerce/listings/:id` | Active members, not archived, no status field |
| `POST` | `/commerce/listings/:id/status` | Owner or admin |
| `POST` | `/commerce/listings/:id/media` | Active members, media owned by the same organization |

Discovery filters: `offering`, `type` (garment type slug), `style`, `material`, `organization` (slug), `currency`, `availability`, `minMinor`, `maxMinor`. A price bound includes `fixed`, `starting`, and `range` only. Quote listings drop out when a price bound is present. A missing price bound does not filter. Currency is not converted.

Clients cannot send `verified`, `payment`, `checkout`, `order`, or `url`.

## Database

Migration `sql/migrations/012_commerce.sql` adds the profile, specialty, listing, listing media, and listing event tables. Foreign keys use `RESTRICT` for garments, design revisions, and media, and `CASCADE` for listing media and events when a listing row is removed. Existing catalog, design, and organization rows are not rewritten.

Queries use the existing `pg` pool and parameterized SQL. There is no ORM.

## Workspace

`/commerce` is a local desk. It can create an account, save a business draft, choose specialties, save a listing draft, and publish, pause, or archive when the role allows it. Public discovery shows an empty state when nothing is published. Prices are shown in the stored currency and minor units. The marketing landing page is unchanged.

## Authorization

Membership is read from `organization_memberships` on the server. A business id from the client is not trusted by itself. Listing media must belong to the listing's organization. A public response includes a media id only when that asset's visibility is `public`. Private design revisions owned by another account are not found.

## Tests

`server/test/commerce.test.ts` covers unpublished profiles, unverified responses, draft privacy, member publish denial, cross-business price isolation, catalog measurement privacy, discovery filters, quote and range pricing, private design rejection, pause and archive, and private media hidden from the public listing.

`server/test/commerce-form.test.ts` covers the desk's draft checks: quote shape, currency case, fractional and negative amounts, range order, missing garment or design, and which roles see publish actions.

The suite command is `npm test`. The verification run for this phase passed 58 tests and failed 0.

## Limitations

- No live checkout, escrow, payout, commission, or refund. Simulated payments are documented separately.
- No inventory quantities and no reservation when a listing says `available`.
- No exchange rates.
- No business or listing verification workflow.
- No appointment booking.
- No moderation queue. Publication is the business owner's action.
- Profile and listing images can be attached through the existing media upload. The desk does not crop or moderate them.
- One organization still has one primary kind. Extra specialties are labels, not extra memberships.

## Later order processing

Customer orders that snapshot a published listing are described in `docs/bop-order-management-architecture.md`. Payment and stock reservation remain absent.
