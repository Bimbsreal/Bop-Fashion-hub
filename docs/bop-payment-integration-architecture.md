# Bop payment integration

Payment records are a **local, simulated foundation**. They are not a live payment integration. No card is charged, no provider is configured, and an order is never marked paid by this phase.

## Audit

Before this phase the repository had:

- Confirmed orders with an immutable `currency` and `agreed_amount_minor` snapshot in integer minor units. `paid` in the order JSON is always `false`. There is no paid column.
- Order idempotency keys, scoped to one customer and one listing. There was no shared idempotency service.
- No payment, wallet, ledger, refund, payout, escrow, or webhook tables.
- No payment provider and no payment credentials.
- A database-backed AI worker. It is not a payment queue. There is no Redis or message broker.
- In-process rate limiting for uploads. The same helper now limits payment initiation per API process. The database constraints are the durable guard.

Live checkout, provider signature verification, refunds, payouts, commissions, escrow, tax, and shipping remain absent.

## Decisions

An order is the commercial agreement. A payment intent is a request to pay that agreement. A payment attempt is one try. A provider event is a notification. A financial transaction is a ledger row. A reconciliation row records a comparison. These are separate tables. Order status is not reused as a payment status.

The only provider id is `development`. `simulated` is constrained to true and `real_money` is constrained to false. A production process cannot enable the adapter, even if `PAYMENT_SIMULATION=1`.

Initialization stores a pending intent and a `created` attempt. It does not write a ledger row and it does not change the order. A simulated confirmation writes one `simulated_capture` ledger row only after a verified development event. That row's confirmation is `simulated`. It is not evidence that an external account moved money.

This ledger is an append-only log of simulated captures. It is not double-entry accounting. Confirmed rows are not updated. A correction would be a later row. No correction kind is writable in this phase.

Refunds, partial refunds, authorization separate from capture, seller payouts, and wallets are not implemented. The payment state names `requires_action`, `authorized`, `partially_refunded`, and `refunded` are reserved and have no writer.

## Domain

| Record | Meaning |
| --- | --- |
| `payment_intents` | One requested payment for one order, copying that order's agreed minor amount and currency |
| `payment_attempts` | Numbered tries: created, simulated confirmation, failure, or cancellation |
| `payment_provider_events` | Development-adapter events, with a unique provider event id and a processing outcome |
| `financial_transactions` | One simulated capture per intent, tied to the order, attempt, and event |
| `payment_reconciliations` | A stored comparison. It does not change the payment state |

A customer can pay only an order they own, and only when the status is `confirmed`, `in_production`, `ready_for_fulfillment`, or `completed` and the order has a currency and agreed minor total. `submitted`, review, quotation, approval, `cancelled`, and `rejected` are rejected. An issued quotation that the customer has not accepted is not payable. The amount is read from the order row inside the transaction. The client cannot send an amount, currency, or state.

Changing the listing price later does not change the order snapshot and does not change the payment.

## States

| State | How it is reached |
| --- | --- |
| `pending` | Simulation initiation succeeded |
| `captured` | A verified development event reported capture. `realMoney` stays false |
| `failed` | A verified development failure event |
| `cancelled` | The customer cancelled a pending request |

Allowed moves are `pending` → `captured`, `pending` → `failed`, and `pending` → `cancelled`. Captured, failed, and cancelled do not move backward. A later failure event for a captured intent is stored as `ignored_stale` and leaves the state and the ledger row in place.

A repeated confirmation of an already captured intent returns the same intent and does not insert a second ledger row.

Order status stays where the business left it. `paid` on the order response stays false.

## Amounts

Values are integers in minor units from 0 through 1,000,000,000. JavaScript floating-point values are rejected by `wholeMinor`. The code never divides an amount by 100.

A known ISO 4217 exponent is stored beside the currency when the code is in the local map. NGN, USD, EUR, and GBP use exponent 2. JPY uses 0. KWD uses 3. Any other three-letter code that an order already accepted is stored with a null exponent. The integer is still the order's integer. Unknown codes are not converted and are not treated as two-decimal currencies.

Currencies are not converted. `externallyConfirmed` is always false.

## Adapter

`PaymentAdapter` can initialize, confirm, or fail. The domain service talks to that interface. The development adapter returns local references and verified events. It does not open a network connection.

`PAYMENT_SIMULATION=1` is required. `NODE_ENV=production` forces the adapter off. Tests pass `nodeEnv: "production"` with the flag set and receive `simulation_disabled`. No payment row is inserted.

Provider failures use categories `timeout`, `invalid_response`, `permanent`, `retryable`, and `unavailable`. Timeout and unavailable responses are HTTP 503. Invalid and permanent responses are HTTP 400. Those failures are thrown before insert, so no intent remains. A confirm timeout records a failed attempt and leaves the intent pending.

There is no public webhook. `POST /api/v1/payments/events` is not a route. Provider signature verification is pending until a real provider is chosen. The development event path rejects `verified: false`, stores `processing = rejected`, and does not capture. Duplicate provider event ids do not add a second ledger row. Malformed event ids are rejected.

A client body cannot set `verified`, `state`, `amountMinor`, `currency`, `paid`, or `providerState`.

## Idempotency

Optional header `Idempotency-Key`, shaped `^[A-Za-z0-9_-]{8,80}$`. The unique key is `(customer_user_id, idempotency_key)`. The same key and order returns the existing intent. The same key and a different order is 409. A second key while a pending or captured intent exists for that order is 409.

One order can have one row in `pending`, `requires_action`, `authorized`, or `captured`. Failed and cancelled intents do not hold that slot, so a later request can start another simulated intent. The order row is locked with `FOR UPDATE` before the insert. A unique-index collision is recovered in a new transaction. It is not handled inside the aborted one.

In-memory rate limiting is 20 initiation calls per user per minute per process. It is not the only duplicate protection.

Pending intents expire 24 hours after creation. Expiry is checked when confirmation is requested. There is no background expiry job.

## Authorization

The customer initiates, confirms the simulation, fails it, and cancels it. A member of the selling business receives 403 for those actions. Someone outside the order receives 404. The customer and any active member can read the payment. Reconciliation is the customer, or an owner or admin. A member receives 403. Responses omit provider references and have no raw provider payload. No card number or security code is stored. Measurement and design notes are not copied onto the payment.

## Reconciliation

The HTTP reconciliation compares the stored state with itself, because no provider account exists. `pending` stays `pending_review`. A captured simulated intent is `matched_simulated`. Neither outcome marks the payment as real money or changes the order. A test can inject a different provider state. A mismatch is stored and the intent state is left unchanged.

## Refunds

No refund table and no refund route. A refund, when a provider exists, must reference a captured payment, must not exceed the captured minor amount, and must stay incomplete until that provider confirms it. This phase does not invent a cancellation or refund policy. Cancelling a pending simulated intent does not create a ledger row.

## API

Base: `http://localhost:5000/api/v1`

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/payments` | Customer of a payable order. Optional `Idempotency-Key`. `201`, or `200` when the same operation already exists |
| `GET` | `/payments` | That customer's payments. Optional `orderId` |
| `GET` | `/payments/:id` | Customer, or an active member of the selling business |
| `POST` | `/payments/:id/cancel` | Customer, and only from `pending` |
| `POST` | `/payments/:id/simulation/confirm` | Customer, simulation enabled, pending intent |
| `POST` | `/payments/:id/simulation/fail` | Customer, simulation enabled, pending intent |
| `POST` | `/payments/:id/reconciliation` | Customer, or an owner or admin |

Simulation routes return 400 `simulation_disabled` when the adapter is off.

## Migration

`sql/migrations/014_payments.sql` adds the five tables above. Foreign keys to orders, users, and organizations are `ON DELETE RESTRICT`. Financial rows are not cascaded away with an order.

## Tests

`server/test/payment.test.ts` and `server/test/payment-form.test.ts` cover agreed-amount copy, unpaid orders, quotation approval, unverified events, stale events, duplicate ledger rows, provider timeout and invalid responses, production lockout, idempotency, concurrency, reconciliation mismatch, and the `real_money` constraint.

The verification run of `npm test` passed 69 tests and failed 0. Scoped ESLint and `tsc --noEmit` exited 0. `next build` prerendered `/orders`.

## Before a real provider

- Choose a provider and follow its official sandbox guide.
- Verify webhooks with that provider's signature scheme over the raw body. Do not invent an algorithm.
- Keep card data on the provider's hosted or tokenized page.
- Store provider secrets only on the server, outside the repository.
- Allow `real_money` and a non-development provider id only behind that verified path.
- Do not treat this development confirmation as a successful charge.
- Add refund confirmation only after the provider's refund event is verified.
- Keep order status and payment status separate.

## Limitations

- No live payment, sandbox provider, or external API call.
- No card charge, refund, payout, escrow, commission, tax, or wallet.
- No double-entry books.
- No automatic reconciliation against an external statement.
- No background job for expiry.
- Rate limiting is per process and resets on restart.
- `requires_action` and `authorized` are unused.
- The orders desk can request and confirm the simulation. It does not collect card details.
