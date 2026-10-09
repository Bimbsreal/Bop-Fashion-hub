-- Commercial listings are offers by an organization. They are not catalog garments and not orders.

CREATE TABLE organization_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  description text NOT NULL DEFAULT '',
  inquiry_note text NOT NULL DEFAULT '',
  logo_media_id uuid REFERENCES media_assets (id) ON DELETE RESTRICT,
  publication text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_profiles_description_length CHECK (length(description) <= 2000),
  CONSTRAINT organization_profiles_inquiry_length CHECK (length(inquiry_note) <= 500),
  CONSTRAINT organization_profiles_publication_known CHECK (publication IN ('draft', 'published'))
);

CREATE TABLE organization_specialties (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind text NOT NULL,
  PRIMARY KEY (organization_id, kind),
  CONSTRAINT organization_specialties_kind_known CHECK (kind IN ('studio', 'tailor', 'brand', 'retailer'))
);

CREATE TABLE commercial_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  offering text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  garment_id uuid REFERENCES garments (id) ON DELETE RESTRICT,
  size_label_id uuid REFERENCES size_labels (id) ON DELETE RESTRICT,
  design_revision_id uuid REFERENCES design_revisions (id) ON DELETE RESTRICT,
  pricing_method text NOT NULL,
  currency text,
  amount_minor integer,
  amount_max_minor integer,
  availability text NOT NULL DEFAULT 'unspecified',
  customization_note text NOT NULL DEFAULT '',
  turnaround_note text NOT NULL DEFAULT '',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_listings_offering_known CHECK (
    offering IN ('ready_to_wear', 'made_to_order', 'custom_service', 'design_commission')
  ),
  CONSTRAINT commercial_listings_title_present CHECK (length(btrim(title)) > 0 AND length(title) <= 120),
  CONSTRAINT commercial_listings_description_length CHECK (length(description) <= 2000),
  CONSTRAINT commercial_listings_status_known CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  CONSTRAINT commercial_listings_pricing_known CHECK (pricing_method IN ('fixed', 'starting', 'range', 'quote')),
  CONSTRAINT commercial_listings_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT commercial_listings_amounts_nonnegative CHECK (
    (amount_minor IS NULL OR amount_minor >= 0)
    AND (amount_max_minor IS NULL OR amount_max_minor >= 0)
  ),
  CONSTRAINT commercial_listings_price_shape CHECK (
    (pricing_method = 'quote' AND currency IS NULL AND amount_minor IS NULL AND amount_max_minor IS NULL)
    OR (pricing_method IN ('fixed', 'starting') AND currency IS NOT NULL AND amount_minor IS NOT NULL AND amount_max_minor IS NULL)
    OR (
      pricing_method = 'range'
      AND currency IS NOT NULL
      AND amount_minor IS NOT NULL
      AND amount_max_minor IS NOT NULL
      AND amount_max_minor >= amount_minor
    )
  ),
  CONSTRAINT commercial_listings_ready_garment CHECK (offering <> 'ready_to_wear' OR garment_id IS NOT NULL),
  CONSTRAINT commercial_listings_commission_revision CHECK (
    offering <> 'design_commission' OR design_revision_id IS NOT NULL
  ),
  CONSTRAINT commercial_listings_size_needs_garment CHECK (size_label_id IS NULL OR garment_id IS NOT NULL),
  CONSTRAINT commercial_listings_availability_known CHECK (availability IN ('available', 'unavailable', 'unspecified')),
  CONSTRAINT commercial_listings_customization_length CHECK (length(customization_note) <= 500),
  CONSTRAINT commercial_listings_turnaround_length CHECK (length(turnaround_note) <= 500)
);

CREATE INDEX commercial_listings_organization_idx ON commercial_listings (organization_id, updated_at DESC);
CREATE INDEX commercial_listings_published_idx ON commercial_listings (published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX commercial_listings_garment_idx ON commercial_listings (garment_id);

CREATE TABLE commercial_listing_media (
  listing_id uuid NOT NULL REFERENCES commercial_listings (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  PRIMARY KEY (listing_id, media_id)
);

CREATE TABLE commercial_listing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES commercial_listings (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_listing_events_status_known CHECK (
    to_status IN ('draft', 'published', 'paused', 'archived')
    AND (from_status IS NULL OR from_status IN ('draft', 'published', 'paused', 'archived'))
  )
);

CREATE INDEX commercial_listing_events_listing_idx ON commercial_listing_events (listing_id, created_at);
