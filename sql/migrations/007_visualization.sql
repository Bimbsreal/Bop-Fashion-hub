-- A visualization concept organizes existing references. It does not generate an image.

CREATE TABLE visualization_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  notes text NOT NULL DEFAULT '',
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  visibility text NOT NULL DEFAULT 'private',
  status text NOT NULL DEFAULT 'draft',
  method text NOT NULL DEFAULT 'reference_board',
  design_project_id uuid REFERENCES design_projects (id) ON DELETE RESTRICT,
  revision_id uuid REFERENCES design_revisions (id) ON DELETE RESTRICT,
  garment_id uuid REFERENCES garments (id) ON DELETE RESTRICT,
  preview_media_id uuid REFERENCES media_assets (id) ON DELETE RESTRICT,
  preview_origin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visualization_concepts_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  ),
  CONSTRAINT visualization_concepts_title_present CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT visualization_concepts_notes_length CHECK (length(notes) <= 4000),
  CONSTRAINT visualization_concepts_visibility_known CHECK (visibility IN ('private', 'public')),
  CONSTRAINT visualization_concepts_status_known CHECK (status IN ('draft', 'arranged', 'archived')),
  CONSTRAINT visualization_concepts_method_known CHECK (
    method IN ('reference_board', 'concept_preview', 'manual_variation')
  ),
  CONSTRAINT visualization_concepts_preview_origin_known CHECK (
    preview_origin IS NULL OR preview_origin IN ('original_reference', 'manual_upload', 'design_revision')
  ),
  CONSTRAINT visualization_concepts_preview_pair CHECK (
    (preview_media_id IS NULL AND preview_origin IS NULL)
    OR (preview_media_id IS NOT NULL AND preview_origin IS NOT NULL)
  ),
  CONSTRAINT visualization_concepts_revision_needs_project CHECK (
    revision_id IS NULL OR design_project_id IS NOT NULL
  )
);

CREATE INDEX visualization_concepts_owner_user_idx ON visualization_concepts (owner_user_id);
CREATE INDEX visualization_concepts_owner_organization_idx ON visualization_concepts (owner_organization_id);
CREATE INDEX visualization_concepts_updated_idx ON visualization_concepts (updated_at DESC, id DESC);
CREATE INDEX visualization_concepts_project_idx ON visualization_concepts (design_project_id);
CREATE INDEX visualization_concepts_garment_idx ON visualization_concepts (garment_id);
CREATE INDEX visualization_concepts_preview_idx ON visualization_concepts (preview_media_id);

CREATE TRIGGER visualization_concepts_set_updated_at
  BEFORE UPDATE ON visualization_concepts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE visualization_references (
  concept_id uuid NOT NULL REFERENCES visualization_concepts (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  origin text NOT NULL,
  note text NOT NULL DEFAULT '',
  PRIMARY KEY (concept_id, media_id),
  CONSTRAINT visualization_references_position_unique UNIQUE (concept_id, position),
  CONSTRAINT visualization_references_position_positive CHECK (position BETWEEN 1 AND 24),
  CONSTRAINT visualization_references_origin_known CHECK (
    origin IN ('original_reference', 'manual_upload', 'design_revision')
  ),
  CONSTRAINT visualization_references_note_length CHECK (length(note) <= 240)
);

CREATE INDEX visualization_references_media_idx ON visualization_references (media_id);
