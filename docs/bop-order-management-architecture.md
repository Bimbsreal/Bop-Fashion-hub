# Bop order management

Customer orders against published commercial listings are **implemented** for local development. Payment, refunds, stock reservation, shipping, and tax calculation are **not implemented**.

Submitting an order records a request. It does not collect money, and it does not reserve a garment.

## Domain

| Concept | Meaning | Where |
| --- | --- | --- |
| Order | One customer's request to one organization, tied to one listing | `orders` |
| Order event | A recorded submission, status change, or quotation action | `order_events` |
| Quotation | A proposed total the customer must accept before a quoted order is confirmed | `order_quotations` |
| Shared measurement | The specific current body records the customer attached | `order_measurement_shares` |
| Order media | Reference images the customer owns and attached | `order_media` |

There is no cart draft table. A successful submission creates the order in its first active state. A failed submission stores nothing.

The listing row is not the historical price. The order copies the title, description, offering, pricing method, list amounts, currency, quantity, garment, size label, and design revision at submission time.

## Order types

The listing offering selects the fulfillment path.

| Offering | Fixed price | Starting, range, or quote |
| --- | --- | --- |
| `ready_to_wear` | Submitted, then confirmed, ready for fulfillment, completed | Quotation, then the same fulfillment path |
| `made_to_order` | Submitted, then confirmed, in production, ready, completed | Quotation, then the production path |
| `custom_service` | Business review, then confirmed and the production path | Quotation, then the production path |
| `design_commission` | Same as a custom service | Same as a custom service |

Ready-to-wear quantity is a whole number from 1 to 20. Other offerings are a single request. Custom services and design commissions require a customization note.

A listing with availability `unavailable` cannot be ordered. `available` and `unspecified` can be ordered. Neither value is a stock count. `stock_reserved` is constrained to false.

## Lifecycle

These states are not interchangeable.

| State | Meaning |
| --- | --- |
| `submitted` | A priced product or made-to-order request is waiting for the business |
| `awaiting_business_review` | A fixed-price custom or design request is waiting for the business |
| `awaiting_quotation` | The business has not issued a current quotation |
| `awaiting_customer_approval` | A quotation is waiting for the customer |
| `confirmed` | The agreed total is stored on the order |
| `in_production` | Custom or made-to-order work is underway |
| `ready_for_fulfillment` | The business marked the work ready. This is not a shipment |
| `completed` | The business recorded completion |
| `rejected` | The business declined the request before confirmation |
| `cancelled` | The customer or an owner or admin withdrew the request before confirmation |

Valid business status changes:

- Fixed ready-to-wear: `submitted` → `confirmed` or `rejected`; `confirmed` → `ready_for_fulfillment`; `ready_for_fulfillment` → `completed`.
- Fixed made-to-order: `submitted` → `confirmed` or `rejected`; `confirmed` → `in_production`; `in_production` → `ready_for_fulfillment`; `ready_for_fulfillment` → `completed`.
- Fixed custom service or design commission: `awaiting_business_review` → `confirmed` or `rejected`, then the production path.
- Quoted orders: confirmation happens only when the customer accepts a quotation. After that, ready-to-wear uses the fulfillment path and the other offerings use the production path.

Cancellation is available from `submitted`, `awaiting_business_review`, `awaiting_quotation`, and `awaiting_customer_approval`. A confirmed order has no cancellation action. No refund right or production-loss policy is stored. That decision is unresolved.

The customer cannot set an arbitrary status. Only an owner or admin of the selling organization can move business states. A member can read the organization's orders and receives 403 on those changes. Someone outside the order receives 404.

## Quotations

A quotation is a proposed order total in one currency, in minor units. Creating it does not accept it.

The customer accepts or rejects the issued quotation on their order. Acceptance copies that currency and total onto the order and sets `confirmed`. A later quotation cannot replace an accepted total.

Rejecting a quotation returns the order to `awaiting_quotation` and keeps the rejected row. The next quotation is a new row. An earlier issued quotation is marked `superseded`.

A starting-price quotation must use the listing currency and must be at least the starting unit amount times quantity. A range quotation must fall inside that range times quantity. A quote-method listing has no stored price; the business supplies the currency and total. The platform does not invent either.

If `expires_at` is in the past, acceptance is refused. There is no background job that flips the row to `expired`.

## Price and currency

Fixed-price orders store `unit_amount_minor`, `agreed_amount_minor` as the integer product, and the listing currency. Quoted orders store the accepted total and leave the unit amount empty. `converted` is always false. `paid` is always false.

Changing the listing price later does not change the order. Currencies are not combined or converted.

## Measurements, design, and media

The customer may attach current measurement records from a profile they own. The order stores that definition, canonical centimetres, and the entered text and unit. It does not copy the profile notes, and it does not grant the business access to the rest of the profile. A business member who opens the profile API still receives 404.

The design snapshot is the revision already on the listing: project id, name, and revision number. Revision notes are not returned.

Reference images must be ready media owned by the customer. Order parties can request the bytes from `GET /api/v1/orders/:id/media/:mediaId/content`. That route checks the order, not a public media URL. The JSON response does not include the storage key.

## API

Base: `http://localhost:5000/api/v1`

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/orders` | Signed-in customer. Optional `Idempotency-Key` |
| `GET` | `/orders` | That customer's orders |
| `GET` | `/orders?organizationId=` | Active members of that business |
| `GET` | `/orders/:id` | Customer or a member of the selling business |
| `POST` | `/orders/:id/cancel` | Customer, or an owner or admin, before confirmation |
| `POST` | `/orders/:id/status` | Owner or admin, and only a listed next state |
| `POST` | `/orders/:id/quotations` | Owner or admin |
| `POST` | `/orders/:id/quotations/:quoteId/accept` | The customer |
| `POST` | `/orders/:id/quotations/:quoteId/reject` | The customer |
| `GET` | `/orders/:id/media/:mediaId/content` | Customer or a member, for media attached to that order |

A repeated idempotency key from the same customer and listing returns the existing order. The same key with a different listing is a conflict. A concurrent duplicate insert is rejected by the unique index; the request is not replayed inside the failed transaction.

Clients cannot send `status`, `currency`, `amountMinor`, `organizationId`, `paid`, `payment`, `price`, or `verified` when submitting an order.

Creation, status changes, and quotation acceptance run in one database transaction with the history row.

## Workspace

`/orders` lists published listings, submits an order, shows the customer's orders, and shows a business inbox when the signed-in person belongs to one. Quotation response and status buttons follow the same role and state rules. Empty lists stay empty.

## Tests

`server/test/order.test.ts` covers price snapshots, quantity, unpublished listings, idempotent retry, cross-customer and cross-business reads, member denial, completion order, quotation accept and reject, range bounds, expiration, measurement isolation, media ownership, and rollback when a measurement reference is missing.

`server/test/order-form.test.ts` covers the desk's draft checks and which buttons a role can see.

The suite command is `npm test`. The verification run for this phase passed 63 tests and failed 0.

## Limitations

- No live payment, refund, escrow, payout, or tax. A simulated payment record is separate and does not mark the order paid. See `docs/bop-payment-integration-architecture.md`.
- No stock decrement or reservation.
- No shipping integration.
- No stored draft or multi-listing cart. One order references one listing.
- No cancellation terms after confirmation.
- No automatic quotation expiry job.
- Idempotent retry is the saved key after a completed request. A simultaneous duplicate key is not merged.
- Business verification remains absent.

## Later payment and fulfillment

A simulated payment record can reference a confirmed order and its stored currency and agreed minor total. It does not reread the listing price, and it does not mark the order paid. See `docs/bop-payment-integration-architecture.md`. Fulfillment can later attach a handoff to `ready_for_fulfillment` without treating that state as a carrier booking.
