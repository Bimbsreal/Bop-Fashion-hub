-- Core domain foundation. Creates new tables only.
-- Row Level Security is intentionally not enabled: the API uses one pool
-- role, and there is no per-request database session yet. Authorization
-- is enforced in the domain layer until that session model exists.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_shape CHECK (email = lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT users_display_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_status_known CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  given_name text,
  family_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT organizations_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT organizations_kind_known CHECK (kind IN ('studio', 'tailor', 'brand', 'retailer')),
  CONSTRAINT organizations_status_known CHECK (status IN ('active', 'archived'))
);

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT memberships_role_known CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT memberships_status_known CHECK (status IN ('active', 'invited', 'removed'))
);

CREATE INDEX organization_memberships_user_active_idx
  ON organization_memberships (user_id)
  WHERE status = 'active';

CREATE TABLE fashion_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fashion_terms_kind_known CHECK (
    kind IN ('garment_type', 'material', 'pattern', 'style', 'category', 'tradition')
  ),
  CONSTRAINT fashion_terms_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT fashion_terms_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT fashion_terms_kind_slug_unique UNIQUE (kind, slug)
);

CREATE TABLE garments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  garment_type_id uuid REFERENCES fashion_terms (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garments_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT garments_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  )
);

CREATE INDEX garments_owner_user_idx ON garments (owner_user_id);
CREATE INDEX garments_owner_organization_idx ON garments (owner_organization_id);

CREATE TABLE garment_terms (
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES fashion_terms (id) ON DELETE RESTRICT,
  PRIMARY KEY (garment_id, term_id)
);

CREATE INDEX garment_terms_term_idx ON garment_terms (term_id);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  media_type text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  width_px integer,
  height_px integer,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  ),
  CONSTRAINT media_assets_type_known CHECK (media_type IN ('image', 'video', 'other')),
  CONSTRAINT media_assets_mime_present CHECK (length(btrim(mime_type)) > 0),
  CONSTRAINT media_assets_byte_size_nonnegative CHECK (byte_size >= 0),
  CONSTRAINT media_assets_width_positive CHECK (width_px IS NULL OR width_px > 0),
  CONSTRAINT media_assets_height_positive CHECK (height_px IS NULL OR height_px > 0),
  CONSTRAINT media_assets_status_known CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT media_assets_storage_key_present CHECK (length(btrim(storage_key)) > 0)
);

CREATE INDEX media_assets_owner_user_idx ON media_assets (owner_user_id);
CREATE INDEX media_assets_owner_organization_idx ON media_assets (owner_organization_id);

CREATE TABLE garment_media (
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'reference',
  PRIMARY KEY (garment_id, media_id),
  CONSTRAINT garment_media_role_known CHECK (role IN ('primary', 'reference', 'generated'))
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER organization_memberships_set_updated_at
  BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER garments_set_updated_at
  BEFORE UPDATE ON garments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_garment_type_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  term_kind text;
BEGIN
  IF NEW.garment_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO term_kind FROM fashion_terms WHERE id = NEW.garment_type_id;
  IF term_kind IS DISTINCT FROM 'garment_type' THEN
    RAISE EXCEPTION 'garment_type_id must reference a garment_type term';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER garments_enforce_type_kind
  BEFORE INSERT OR UPDATE OF garment_type_id ON garments
  FOR EACH ROW EXECUTE FUNCTION enforce_garment_type_kind();

INSERT INTO fashion_terms (kind, name, slug) VALUES
  ('material', 'Ankara', 'ankara'),
  ('material', 'Aso Oke', 'aso-oke'),
  ('material', 'Adire', 'adire'),
  ('material', 'Lace', 'lace'),
  ('material', 'George', 'george'),
  ('material', 'Kente', 'kente'),
  ('garment_type', 'Agbada', 'agbada'),
  ('style', 'Contemporary African fashion', 'contemporary-african'),
  ('category', 'Traditional', 'traditional'),
  ('category', 'Contemporary', 'contemporary'),
  ('category', 'Streetwear', 'streetwear'),
  ('category', 'Formalwear', 'formalwear'),
  ('category', 'Footwear', 'footwear'),
  ('category', 'Accessories', 'accessories'),
  ('category', 'Occasions', 'occasions')
ON CONFLICT (kind, slug) DO NOTHING;
