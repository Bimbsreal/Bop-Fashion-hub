-- Body measurement profiles are personal records. They are not garment dimensions,
-- size labels, or account profiles. Canonical length is centimetres.

ALTER TABLE measurement_definitions
  ADD COLUMN subject text NOT NULL DEFAULT 'garment',
  ADD COLUMN min_cm numeric(8, 2),
  ADD COLUMN max_cm numeric(8, 2);

ALTER TABLE measurement_definitions
  ADD CONSTRAINT measurement_definitions_subject_known CHECK (subject IN ('garment', 'body')),
  ADD CONSTRAINT measurement_definitions_body_bounds CHECK (
    (subject = 'garment' AND min_cm IS NULL AND max_cm IS NULL)
    OR (
      subject = 'body'
      AND min_cm IS NOT NULL
      AND max_cm IS NOT NULL
      AND min_cm > 0
      AND max_cm > min_cm
      AND max_cm < 10000
    )
  );

ALTER TABLE garment_measurements
  ADD COLUMN entered_value numeric(12, 4),
  ADD COLUMN entered_unit text;

UPDATE garment_measurements
SET entered_value = value, entered_unit = 'cm'
WHERE entered_value IS NULL OR entered_unit IS NULL;

ALTER TABLE garment_measurements
  ALTER COLUMN entered_value SET NOT NULL,
  ALTER COLUMN entered_unit SET NOT NULL,
  ADD CONSTRAINT garment_measurements_entered_positive CHECK (entered_value > 0),
  ADD CONSTRAINT garment_measurements_entered_unit_known CHECK (entered_unit IN ('cm', 'm', 'in'));

INSERT INTO measurement_definitions (slug, name, unit, subject) VALUES
  ('garment-shoulder', 'Garment shoulder width', 'cm', 'garment'),
  ('garment-sleeve', 'Garment sleeve length', 'cm', 'garment'),
  ('garment-inseam', 'Garment inseam', 'cm', 'garment'),
  ('garment-hem', 'Garment hem width', 'cm', 'garment')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO measurement_definitions (slug, name, unit, subject, min_cm, max_cm) VALUES
  ('chest-circumference', 'Chest circumference', 'cm', 'body', 40, 200),
  ('waist-circumference', 'Waist circumference', 'cm', 'body', 30, 200),
  ('hip-circumference', 'Hip circumference', 'cm', 'body', 40, 220),
  ('shoulder-width', 'Shoulder width', 'cm', 'body', 20, 80),
  ('neck-circumference', 'Neck circumference', 'cm', 'body', 20, 70),
  ('arm-length', 'Arm length', 'cm', 'body', 30, 100),
  ('sleeve-length', 'Sleeve length', 'cm', 'body', 20, 100),
  ('upper-arm-circumference', 'Upper-arm circumference', 'cm', 'body', 15, 70),
  ('wrist-circumference', 'Wrist circumference', 'cm', 'body', 10, 35),
  ('inseam', 'Inseam', 'cm', 'body', 40, 120),
  ('outseam', 'Outseam', 'cm', 'body', 50, 140),
  ('thigh-circumference', 'Thigh circumference', 'cm', 'body', 25, 110),
  ('knee-circumference', 'Knee circumference', 'cm', 'body', 20, 70),
  ('ankle-circumference', 'Ankle circumference', 'cm', 'body', 12, 40),
  ('torso-length', 'Torso length', 'cm', 'body', 30, 90),
  ('back-width', 'Back width', 'cm', 'body', 20, 70)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE measurement_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL,
  notes text NOT NULL DEFAULT '',
  preferred_unit text NOT NULL DEFAULT 'cm',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_profiles_name_present CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT measurement_profiles_notes_length CHECK (length(notes) <= 500),
  CONSTRAINT measurement_profiles_unit_known CHECK (preferred_unit IN ('cm', 'm', 'in')),
  CONSTRAINT measurement_profiles_status_known CHECK (status IN ('active', 'archived'))
);

CREATE INDEX measurement_profiles_subject_idx ON measurement_profiles (subject_user_id, created_at DESC);

CREATE TABLE measurement_profile_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES measurement_profiles (id) ON DELETE CASCADE,
  grantee_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission text NOT NULL,
  granted_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT measurement_profile_grants_permission_known CHECK (permission IN ('read', 'record', 'verify'))
);

CREATE UNIQUE INDEX measurement_profile_grants_active_idx
  ON measurement_profile_grants (profile_id, grantee_user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE body_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES measurement_profiles (id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES measurement_definitions (id) ON DELETE RESTRICT,
  entered_text text NOT NULL,
  entered_value numeric(12, 4) NOT NULL,
  entered_unit text NOT NULL,
  canonical_cm numeric(8, 2) NOT NULL,
  source text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified',
  verified_at timestamptz,
  verified_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  recorded_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  note text NOT NULL DEFAULT '',
  record_status text NOT NULL DEFAULT 'current',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT body_measurements_entered_text CHECK (
    entered_text ~ '^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,3})?$'
  ),
  CONSTRAINT body_measurements_entered_positive CHECK (entered_value > 0),
  CONSTRAINT body_measurements_canonical_positive CHECK (canonical_cm > 0 AND canonical_cm < 10000),
  CONSTRAINT body_measurements_unit_known CHECK (entered_unit IN ('cm', 'm', 'in')),
  CONSTRAINT body_measurements_source_known CHECK (
    source IN ('user_entered', 'tailor_recorded', 'professionally_verified', 'imported', 'ai_estimated')
  ),
  CONSTRAINT body_measurements_verification_known CHECK (verification_status IN ('unverified', 'verified')),
  CONSTRAINT body_measurements_verified_pair CHECK (
    (verification_status = 'unverified' AND verified_at IS NULL AND verified_by_user_id IS NULL)
    OR (verification_status = 'verified' AND verified_at IS NOT NULL AND verified_by_user_id IS NOT NULL)
  ),
  CONSTRAINT body_measurements_professional_is_verified CHECK (
    source <> 'professionally_verified' OR verification_status = 'verified'
  ),
  CONSTRAINT body_measurements_note_length CHECK (length(note) <= 240),
  CONSTRAINT body_measurements_status_known CHECK (record_status IN ('current', 'superseded', 'archived'))
);

CREATE UNIQUE INDEX body_measurements_current_idx
  ON body_measurements (profile_id, definition_id)
  WHERE record_status = 'current';

CREATE INDEX body_measurements_history_idx
  ON body_measurements (profile_id, definition_id, recorded_at DESC);

CREATE TRIGGER measurement_profiles_set_updated_at
  BEFORE UPDATE ON measurement_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
