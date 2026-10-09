-- Customer orders snapshot a published listing. They are not payments, stock reservations, or catalog edits.

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL REFERENCES commercial_listings (id) ON DELETE RESTRICT,
  offering text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL,
  pricing_method text NOT NULL,
  currency text,
  unit_amount_minor integer,
  agreed_amount_minor integer,
  list_currency text,
  list_amount_minor integer,
  list_amount_max_minor integer,
  quantity integer NOT NULL,
  availability_snapshot text NOT NULL,
  customization_note text NOT NULL DEFAULT '',
  garment_id uuid REFERENCES garments (id) ON DELETE RESTRICT,
  size_label_id uuid REFERENCES size_labels (id) ON DELETE RESTRICT,
  design_revision_id uuid REFERENCES design_revisions (id) ON DELETE RESTRICT,
  idempotency_key text,
  stock_reserved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_offering_known CHECK (
    offering IN ('ready_to_wear', 'made_to_order', 'custom_service', 'design_commission')
  ),
  CONSTRAINT orders_status_known CHECK (
    status IN (
      'submitted',
      'awaiting_business_review',
      'awaiting_quotation',
      'awaiting_customer_approval',
      'confirmed',
      'in_production',
      'ready_for_fulfillment',
      'completed',
      'cancelled',
      'rejected'
    )
  ),
  CONSTRAINT orders_pricing_known CHECK (pricing_method IN ('fixed', 'starting', 'range', 'quote')),
  CONSTRAINT orders_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT orders_list_currency_shape CHECK (list_currency IS NULL OR list_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT orders_amounts_nonnegative CHECK (
    (unit_amount_minor IS NULL OR unit_amount_minor >= 0)
    AND (agreed_amount_minor IS NULL OR agreed_amount_minor >= 0)
    AND (list_amount_minor IS NULL OR list_amount_minor >= 0)
    AND (list_amount_max_minor IS NULL OR list_amount_max_minor >= 0)
  ),
  CONSTRAINT orders_quantity_bounds CHECK (quantity >= 1 AND quantity <= 20),
  CONSTRAINT orders_availability_known CHECK (availability_snapshot IN ('available', 'unavailable', 'unspecified')),
  CONSTRAINT orders_customization_length CHECK (length(customization_note) <= 500),
  CONSTRAINT orders_title_present CHECK (length(btrim(title)) > 0 AND length(title) <= 120),
  CONSTRAINT orders_stock_not_reserved CHECK (stock_reserved = false),
  CONSTRAINT orders_idempotency_shape CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'
  ),
  CONSTRAINT orders_price_snapshot CHECK (
    (
      pricing_method = 'fixed'
      AND currency IS NOT NULL
      AND unit_amount_minor IS NOT NULL
      AND agreed_amount_minor IS NOT NULL
      AND agreed_amount_minor >= unit_amount_minor
    )
    OR (
      pricing_method <> 'fixed'
      AND (
        (currency IS NULL AND unit_amount_minor IS NULL AND agreed_amount_minor IS NULL)
        OR (currency IS NOT NULL AND agreed_amount_minor IS NOT NULL AND unit_amount_minor IS NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX orders_idempotency_idx ON orders (customer_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_customer_idx ON orders (customer_user_id, created_at DESC);
CREATE INDEX orders_organization_idx ON orders (organization_id, created_at DESC);

CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  kind text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_events_kind_known CHECK (
    kind IN ('submitted', 'status', 'quotation_issued', 'quotation_accepted', 'quotation_rejected', 'quotation_superseded')
  ),
  CONSTRAINT order_events_note_length CHECK (length(note) <= 500)
);

CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE TABLE order_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  issued_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  currency text NOT NULL,
  amount_minor integer NOT NULL,
  note text NOT NULL DEFAULT '',
  expires_at timestamptz,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_quotations_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT order_quotations_amount_nonnegative CHECK (amount_minor >= 0 AND amount_minor <= 1000000000),
  CONSTRAINT order_quotations_note_length CHECK (length(note) <= 500),
  CONSTRAINT order_quotations_status_known CHECK (
    status IN ('issued', 'accepted', 'rejected', 'superseded', 'expired')
  )
);

CREATE INDEX order_quotations_order_idx ON order_quotations (order_id, created_at);

CREATE TABLE order_media (
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  PRIMARY KEY (order_id, media_id)
);

CREATE TABLE order_measurement_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  measurement_id uuid NOT NULL REFERENCES body_measurements (id) ON DELETE RESTRICT,
  definition_slug text NOT NULL,
  canonical_cm numeric(8, 2) NOT NULL,
  entered_text text NOT NULL,
  entered_unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, measurement_id)
);

CREATE INDEX order_measurement_shares_order_idx ON order_measurement_shares (order_id);
