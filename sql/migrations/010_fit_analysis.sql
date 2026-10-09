-- A fit analysis stores the dimensions it compared. It does not apply an ease allowance.

CREATE TABLE fit_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES measurement_profiles (id) ON DELETE RESTRICT,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  garment_category text,
  rule_set text NOT NULL,
  classification text NOT NULL,
  summary text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fit_analyses_rule_set_known CHECK (rule_set = 'fit-rules.v1'),
  CONSTRAINT fit_analyses_classification_known CHECK (
    classification IN (
      'potentially_compatible',
      'potentially_restrictive',
      'potentially_loose',
      'mixed',
      'insufficient_data',
      'unsupported_garment',
      'requires_verification'
    )
  ),
  CONSTRAINT fit_analyses_summary_present CHECK (length(btrim(summary)) > 0),
  CONSTRAINT fit_analyses_category_shape CHECK (
    garment_category IS NULL OR garment_category ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

CREATE INDEX fit_analyses_profile_idx ON fit_analyses (profile_id, created_at DESC);
CREATE INDEX fit_analyses_garment_idx ON fit_analyses (garment_id);

CREATE TABLE fit_analysis_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES fit_analyses (id) ON DELETE CASCADE,
  size_system text,
  size_label text,
  body_definition text NOT NULL,
  garment_definition text NOT NULL,
  body_measurement_id uuid NOT NULL REFERENCES body_measurements (id) ON DELETE RESTRICT,
  garment_measurement_id uuid NOT NULL REFERENCES garment_measurements (id) ON DELETE RESTRICT,
  body_canonical_cm numeric(8, 2) NOT NULL,
  garment_canonical_cm numeric(8, 2) NOT NULL,
  difference_cm numeric(8, 2) NOT NULL,
  body_source text NOT NULL,
  body_verification text NOT NULL,
  body_recorded_at timestamptz NOT NULL,
  garment_provenance text NOT NULL,
  CONSTRAINT fit_analysis_comparisons_size_pair CHECK (
    (size_system IS NULL AND size_label IS NULL) OR (size_system IS NOT NULL AND size_label IS NOT NULL)
  ),
  CONSTRAINT fit_analysis_comparisons_values_positive CHECK (
    body_canonical_cm > 0 AND garment_canonical_cm > 0
  ),
  CONSTRAINT fit_analysis_comparisons_source_known CHECK (
    body_source IN ('user_entered', 'tailor_recorded', 'professionally_verified', 'imported', 'ai_estimated')
  ),
  CONSTRAINT fit_analysis_comparisons_verification_known CHECK (body_verification IN ('unverified', 'verified'))
);

CREATE INDEX fit_analysis_comparisons_analysis_idx ON fit_analysis_comparisons (analysis_id);

CREATE TABLE fit_analysis_notes (
  analysis_id uuid NOT NULL REFERENCES fit_analyses (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  PRIMARY KEY (analysis_id, position),
  CONSTRAINT fit_analysis_notes_kind_known CHECK (kind IN ('missing', 'limitation', 'assumption')),
  CONSTRAINT fit_analysis_notes_message_present CHECK (length(btrim(message)) > 0)
);
