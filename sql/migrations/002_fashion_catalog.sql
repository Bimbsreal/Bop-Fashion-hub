-- Extends the core foundation. Does not rename or drop existing tables.
-- Visibility is private or public. Organization isolation stays on ownership.
-- Size labels and garment measurements are separate. There is no body-measurement table.

ALTER TABLE users
  ADD COLUMN password_hash text;

ALTER TABLE users
  ADD CONSTRAINT users_password_hash_present
  CHECK (password_hash IS NULL OR length(password_hash) > 0);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_present CHECK (length(token_hash) > 0),
  CONSTRAINT sessions_expiry_after_create CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

ALTER TABLE garments
  ADD COLUMN created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN visibility text NOT NULL DEFAULT 'private';

ALTER TABLE garments
  ADD CONSTRAINT garments_visibility_known CHECK (visibility IN ('private', 'public'));

UPDATE garments
SET created_by_user_id = owner_user_id
WHERE created_by_user_id IS NULL
  AND owner_user_id IS NOT NULL;

CREATE INDEX garments_type_idx ON garments (garment_type_id);
CREATE INDEX garments_public_created_idx ON garments (created_at DESC, id DESC)
  WHERE visibility = 'public';

ALTER TABLE fashion_terms DROP CONSTRAINT fashion_terms_kind_known;
ALTER TABLE fashion_terms ADD CONSTRAINT fashion_terms_kind_known CHECK (
  kind IN (
    'garment_type', 'material', 'pattern', 'style', 'category', 'tradition',
    'color', 'silhouette', 'sleeve', 'neckline', 'length', 'closure',
    'occasion', 'season', 'fit_preference'
  )
);

ALTER TABLE garment_media DROP CONSTRAINT garment_media_role_known;
ALTER TABLE garment_media ADD CONSTRAINT garment_media_role_known CHECK (
  role IN (
    'primary', 'front', 'back', 'side', 'detail', 'fabric', 'sketch',
    'construction', 'reference', 'generated'
  )
);

CREATE TABLE size_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT size_systems_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT size_systems_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE size_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  size_system_id uuid NOT NULL REFERENCES size_systems (id) ON DELETE CASCADE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT size_labels_label_present CHECK (length(btrim(label)) > 0),
  CONSTRAINT size_labels_system_label_unique UNIQUE (size_system_id, label)
);

CREATE TABLE garment_size_labels (
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE CASCADE,
  size_label_id uuid NOT NULL REFERENCES size_labels (id) ON DELETE RESTRICT,
  PRIMARY KEY (garment_id, size_label_id)
);

CREATE INDEX garment_size_labels_label_idx ON garment_size_labels (size_label_id);

CREATE TABLE measurement_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_definitions_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT measurement_definitions_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT measurement_definitions_unit_known CHECK (unit IN ('cm', 'mm', 'in'))
);

CREATE TABLE garment_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES measurement_definitions (id) ON DELETE RESTRICT,
  size_label_id uuid REFERENCES size_labels (id) ON DELETE RESTRICT,
  value numeric(8, 2) NOT NULL,
  provenance text NOT NULL DEFAULT 'stated',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garment_measurements_value_sane CHECK (value > 0 AND value < 10000),
  CONSTRAINT garment_measurements_provenance_known CHECK (provenance IN ('stated')),
  CONSTRAINT garment_measurements_one_value UNIQUE NULLS NOT DISTINCT (garment_id, definition_id, size_label_id)
);

CREATE INDEX garment_measurements_garment_idx ON garment_measurements (garment_id);

INSERT INTO fashion_terms (kind, name, slug) VALUES
  ('garment_type', 'Dress', 'dress'),
  ('garment_type', 'Shirt', 'shirt'),
  ('garment_type', 'Trousers', 'trousers'),
  ('garment_type', 'Skirt', 'skirt'),
  ('garment_type', 'Kaftan', 'kaftan'),
  ('garment_type', 'Jacket', 'jacket'),
  ('garment_type', 'Gown', 'gown'),
  ('material', 'Denim', 'denim'),
  ('material', 'Cotton', 'cotton'),
  ('material', 'Linen', 'linen'),
  ('material', 'Silk', 'silk'),
  ('pattern', 'Floral', 'floral'),
  ('pattern', 'Geometric', 'geometric'),
  ('pattern', 'Striped', 'striped'),
  ('pattern', 'Plain', 'plain'),
  ('pattern', 'Abstract', 'abstract'),
  ('style', 'Contemporary', 'contemporary'),
  ('style', 'Traditional', 'traditional'),
  ('style', 'Streetwear', 'streetwear'),
  ('style', 'Formal', 'formal'),
  ('style', 'Casual', 'casual'),
  ('style', 'Minimalist', 'minimalist'),
  ('color', 'Black', 'black'),
  ('color', 'White', 'white'),
  ('color', 'Ivory', 'ivory'),
  ('color', 'Indigo', 'indigo'),
  ('color', 'Gold', 'gold'),
  ('tradition', 'Kente', 'kente')
ON CONFLICT (kind, slug) DO NOTHING;

INSERT INTO size_systems (name, slug) VALUES ('Letter sizes', 'letter')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO size_labels (size_system_id, label)
SELECT size_systems.id, label
FROM size_systems
CROSS JOIN (VALUES ('XS'), ('S'), ('M'), ('L'), ('XL')) AS labels(label)
WHERE size_systems.slug = 'letter'
ON CONFLICT (size_system_id, label) DO NOTHING;

INSERT INTO measurement_definitions (slug, name, unit) VALUES
  ('chest', 'Chest', 'cm'),
  ('waist', 'Waist', 'cm'),
  ('hip', 'Hip', 'cm'),
  ('garment-length', 'Garment length', 'cm')
ON CONFLICT (slug) DO NOTHING;
