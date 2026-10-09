-- Design projects are not garments, listings, or orders.
-- Revisions are append-only snapshots. They do not restore a project.

CREATE TABLE design_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  visibility text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_projects_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  ),
  CONSTRAINT design_projects_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT design_projects_status_known CHECK (
    status IN ('draft', 'in_progress', 'ready_for_review', 'archived')
  ),
  CONSTRAINT design_projects_visibility_known CHECK (visibility IN ('private', 'public'))
);

CREATE INDEX design_projects_owner_user_idx ON design_projects (owner_user_id);
CREATE INDEX design_projects_owner_organization_idx ON design_projects (owner_organization_id);
CREATE INDEX design_projects_public_created_idx ON design_projects (created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE TRIGGER design_projects_set_updated_at
  BEFORE UPDATE ON design_projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE design_project_garments (
  design_project_id uuid NOT NULL REFERENCES design_projects (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'reference',
  PRIMARY KEY (design_project_id, garment_id),
  CONSTRAINT design_project_garments_role_known CHECK (role IN ('primary', 'reference'))
);

CREATE UNIQUE INDEX design_project_garments_one_primary_idx
  ON design_project_garments (design_project_id)
  WHERE role = 'primary';

CREATE INDEX design_project_garments_garment_idx ON design_project_garments (garment_id);

CREATE TABLE design_project_media (
  design_project_id uuid NOT NULL REFERENCES design_projects (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'reference',
  PRIMARY KEY (design_project_id, media_id),
  CONSTRAINT design_project_media_role_known CHECK (
    role IN ('sketch', 'reference', 'fabric', 'inspiration', 'preview')
  )
);

CREATE INDEX design_project_media_media_idx ON design_project_media (media_id);

CREATE TABLE design_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design_project_id uuid NOT NULL REFERENCES design_projects (id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  note text NOT NULL DEFAULT '',
  project_name text NOT NULL,
  project_description text NOT NULL,
  project_status text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT design_revisions_number_unique UNIQUE (design_project_id, revision_number),
  CONSTRAINT design_revisions_name_present CHECK (length(btrim(project_name)) > 0),
  CONSTRAINT design_revisions_status_known CHECK (
    project_status IN ('draft', 'in_progress', 'ready_for_review', 'archived')
  )
);

CREATE TABLE design_revision_garments (
  revision_id uuid NOT NULL REFERENCES design_revisions (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  role text NOT NULL,
  PRIMARY KEY (revision_id, garment_id),
  CONSTRAINT design_revision_garments_role_known CHECK (role IN ('primary', 'reference'))
);

CREATE TABLE design_revision_media (
  revision_id uuid NOT NULL REFERENCES design_revisions (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  role text NOT NULL,
  PRIMARY KEY (revision_id, media_id),
  CONSTRAINT design_revision_media_role_known CHECK (
    role IN ('sketch', 'reference', 'fabric', 'inspiration', 'preview')
  )
);
