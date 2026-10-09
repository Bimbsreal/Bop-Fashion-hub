-- Draft garment-attribute analysis. It does not change catalog rows by itself.

CREATE TABLE garment_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES ai_tasks (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  schema_version text NOT NULL,
  simulated boolean NOT NULL,
  provider_id text NOT NULL,
  model_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garment_analyses_schema_known CHECK (schema_version = 'garment-attributes.v1'),
  CONSTRAINT garment_analyses_provider_shape CHECK (
    length(btrim(provider_id)) BETWEEN 1 AND 40 AND provider_id !~ '[^A-Za-z0-9._-]'
  )
);

CREATE INDEX garment_analyses_media_idx ON garment_analyses (media_id);

CREATE TRIGGER garment_analyses_set_updated_at
  BEFORE UPDATE ON garment_analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE garment_analysis_attributes (
  analysis_id uuid NOT NULL REFERENCES garment_analyses (id) ON DELETE CASCADE,
  attribute_key text NOT NULL,
  value_json jsonb NOT NULL,
  basis text NOT NULL,
  note text NOT NULL DEFAULT '',
  confidence numeric(4, 3),
  confidence_source text,
  review_status text NOT NULL DEFAULT 'pending',
  reviewed_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  PRIMARY KEY (analysis_id, attribute_key),
  CONSTRAINT garment_analysis_attributes_basis_known CHECK (basis IN ('observed', 'inferred', 'unknown')),
  CONSTRAINT garment_analysis_attributes_review_known CHECK (
    review_status IN ('pending', 'accepted', 'rejected', 'corrected')
  ),
  CONSTRAINT garment_analysis_attributes_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT garment_analysis_attributes_confidence_source_known CHECK (
    confidence_source IS NULL OR confidence_source IN ('provider', 'application')
  ),
  CONSTRAINT garment_analysis_attributes_unknown_shape CHECK (
    basis <> 'unknown' OR (value_json = 'null'::jsonb AND confidence IS NULL)
  ),
  CONSTRAINT garment_analysis_attributes_note_length CHECK (length(note) <= 240)
);

CREATE TABLE garment_analysis_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES garment_analyses (id) ON DELETE CASCADE,
  attribute_key text,
  action text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garment_analysis_events_action_known CHECK (
    action IN ('accepted', 'rejected', 'corrected', 'applied', 'apply_skipped')
  ),
  CONSTRAINT garment_analysis_events_detail_length CHECK (length(detail) BETWEEN 1 AND 240)
);

CREATE INDEX garment_analysis_events_analysis_idx ON garment_analysis_events (analysis_id, created_at);

CREATE TABLE garment_analysis_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES garment_analyses (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  applied jsonb NOT NULL,
  skipped jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT garment_analysis_applications_json_arrays CHECK (
    jsonb_typeof(applied) = 'array' AND jsonb_typeof(skipped) = 'array'
  )
);

CREATE INDEX garment_analysis_applications_garment_idx ON garment_analysis_applications (garment_id);
CREATE INDEX garment_analysis_applications_analysis_idx ON garment_analysis_applications (analysis_id, created_at);
