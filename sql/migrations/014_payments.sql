-- Simulated payment records. They do not charge a card, settle an order, or reserve stock.
-- real_money and simulated are constrained so a live capture cannot be stored in this phase.

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  purpose text NOT NULL DEFAULT 'order_payment',
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  minor_exponent smallint,
  state text NOT NULL,
  provider_id text NOT NULL,
  provider_reference text,
  idempotency_key text,
  simulated boolean NOT NULL,
  real_money boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_purpose CHECK (purpose = 'order_payment'),
  CONSTRAINT payment_intents_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_intents_amount CHECK (amount_minor >= 0 AND amount_minor <= 1000000000),
  CONSTRAINT payment_intents_exponent CHECK (minor_exponent IS NULL OR (minor_exponent >= 0 AND minor_exponent <= 3)),
  CONSTRAINT payment_intents_state CHECK (
    state IN (
      'pending',
      'requires_action',
      'authorized',
      'captured',
      'failed',
      'cancelled',
      'partially_refunded',
      'refunded'
    )
  ),
  CONSTRAINT payment_intents_provider CHECK (provider_id = 'development'),
  CONSTRAINT payment_intents_simulated CHECK (simulated = true),
  CONSTRAINT payment_intents_not_real CHECK (real_money = false),
  CONSTRAINT payment_intents_idempotency CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'
  ),
  CONSTRAINT payment_intents_reference CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 8 AND 80)
);

CREATE UNIQUE INDEX payment_intents_open_order_idx ON payment_intents (order_id)
  WHERE state IN ('pending', 'requires_action', 'authorized', 'captured');
CREATE UNIQUE INDEX payment_intents_idempotency_idx ON payment_intents (customer_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payment_intents_customer_idx ON payment_intents (customer_user_id, created_at DESC);
CREATE INDEX payment_intents_organization_idx ON payment_intents (organization_id, created_at DESC);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents (id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id, attempt_number),
  CONSTRAINT payment_attempts_number CHECK (attempt_number >= 1 AND attempt_number <= 20),
  CONSTRAINT payment_attempts_outcome CHECK (outcome IN ('created', 'simulated_confirmed', 'failed', 'cancelled')),
  CONSTRAINT payment_attempts_failure CHECK (
    failure_category IS NULL
    OR failure_category IN ('timeout', 'invalid_response', 'permanent', 'retryable', 'unavailable')
  )
);

CREATE INDEX payment_attempts_intent_idx ON payment_attempts (payment_intent_id, attempt_number);

CREATE TABLE payment_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  provider_event_id text NOT NULL,
  payment_intent_id uuid NOT NULL REFERENCES payment_intents (id) ON DELETE RESTRICT,
  verified boolean NOT NULL,
  processing text NOT NULL,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_event_id),
  CONSTRAINT payment_provider_events_provider CHECK (provider_id = 'development'),
  CONSTRAINT payment_provider_events_id CHECK (provider_event_id ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  CONSTRAINT payment_provider_events_processing CHECK (
    processing IN ('applied', 'duplicate', 'rejected', 'ignored_stale')
  ),
  CONSTRAINT payment_provider_events_summary CHECK (length(summary) <= 200)
);

CREATE INDEX payment_provider_events_intent_idx ON payment_provider_events (payment_intent_id, created_at);

CREATE TABLE financial_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents (id) ON DELETE RESTRICT,
  payment_attempt_id uuid REFERENCES payment_attempts (id) ON DELETE RESTRICT,
  provider_event_id uuid REFERENCES payment_provider_events (id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  confirmation text NOT NULL,
  simulated boolean NOT NULL,
  real_money boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transactions_kind CHECK (kind = 'simulated_capture'),
  CONSTRAINT financial_transactions_amount CHECK (amount_minor >= 0 AND amount_minor <= 1000000000),
  CONSTRAINT financial_transactions_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT financial_transactions_confirmation CHECK (confirmation = 'simulated'),
  CONSTRAINT financial_transactions_simulated CHECK (simulated = true),
  CONSTRAINT financial_transactions_not_real CHECK (real_money = false),
  UNIQUE (payment_intent_id, kind)
);

CREATE UNIQUE INDEX financial_transactions_event_idx ON financial_transactions (provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX financial_transactions_order_idx ON financial_transactions (order_id, created_at);

CREATE TABLE payment_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents (id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  internal_state text NOT NULL,
  provider_state text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_reconciliations_internal CHECK (
    internal_state IN (
      'pending', 'requires_action', 'authorized', 'captured', 'failed', 'cancelled',
      'partially_refunded', 'refunded'
    )
  ),
  CONSTRAINT payment_reconciliations_provider CHECK (
    provider_state IN (
      'pending', 'requires_action', 'authorized', 'captured', 'failed', 'cancelled',
      'partially_refunded', 'refunded', 'unknown'
    )
  ),
  CONSTRAINT payment_reconciliations_outcome CHECK (outcome IN ('matched_simulated', 'mismatch', 'pending_review'))
);

CREATE INDEX payment_reconciliations_intent_idx ON payment_reconciliations (payment_intent_id, created_at);
