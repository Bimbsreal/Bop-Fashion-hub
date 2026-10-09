-- A try-on request records consent and source images. It does not generate an image.

CREATE TABLE try_on_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  person_media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  garment_media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  garment_category text NOT NULL,
  garment_presentation text NOT NULL,
  design_project_id uuid REFERENCES design_projects (id) ON DELETE RESTRICT,
  revision_id uuid REFERENCES design_revisions (id) ON DELETE RESTRICT,
  visualization_id uuid REFERENCES visualization_concepts (id) ON DELETE RESTRICT,
  consent_purpose text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'draft',
  input_fingerprint text NOT NULL,
  idempotency_key text,
  ai_task_id uuid UNIQUE REFERENCES ai_tasks (id) ON DELETE RESTRICT,
  output_media_id uuid REFERENCES media_assets (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT try_on_requests_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  ),
  CONSTRAINT try_on_requests_images_distinct CHECK (person_media_id <> garment_media_id),
  CONSTRAINT try_on_requests_consent_known CHECK (consent_purpose = 'try_on_request'),
  CONSTRAINT try_on_requests_status_known CHECK (
    status IN ('draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT try_on_requests_presentation_known CHECK (
    garment_presentation IN ('catalog', 'worn', 'flat_lay', 'mannequin')
  ),
  CONSTRAINT try_on_requests_category_shape CHECK (
    garment_category ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(garment_category) <= 80
  ),
  CONSTRAINT try_on_requests_fingerprint_present CHECK (length(input_fingerprint) = 64),
  CONSTRAINT try_on_requests_idempotency_present CHECK (
    idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 80
  ),
  CONSTRAINT try_on_requests_revision_needs_project CHECK (
    revision_id IS NULL OR design_project_id IS NOT NULL
  ),
  CONSTRAINT try_on_requests_draft_has_no_task CHECK (
    status <> 'draft' OR ai_task_id IS NULL
  ),
  CONSTRAINT try_on_requests_output_only_after_success CHECK (
    output_media_id IS NULL OR status = 'succeeded'
  )
);

CREATE UNIQUE INDEX try_on_requests_idempotency_idx
  ON try_on_requests (created_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX try_on_requests_owner_user_idx ON try_on_requests (owner_user_id, created_at DESC);
CREATE INDEX try_on_requests_owner_organization_idx ON try_on_requests (owner_organization_id, created_at DESC);
CREATE INDEX try_on_requests_person_media_idx ON try_on_requests (person_media_id);
CREATE INDEX try_on_requests_garment_idx ON try_on_requests (garment_id);

CREATE TRIGGER try_on_requests_set_updated_at
  BEFORE UPDATE ON try_on_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
