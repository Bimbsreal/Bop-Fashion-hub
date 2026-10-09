-- Personal styling stores preferences, a wardrobe list, outfits, and recommendation sessions.
-- A wardrobe row means the person added a catalog garment. It does not record a purchase.

CREATE TABLE styling_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT styling_profiles_notes_length CHECK (length(notes) <= 500)
);

CREATE TABLE styling_preferences (
  user_id uuid NOT NULL REFERENCES styling_profiles (user_id) ON DELETE CASCADE,
  polarity text NOT NULL,
  term_id uuid NOT NULL REFERENCES fashion_terms (id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, polarity, term_id),
  CONSTRAINT styling_preferences_polarity_known CHECK (polarity IN ('preferred', 'disliked'))
);

CREATE INDEX styling_preferences_term_idx ON styling_preferences (term_id);

CREATE TABLE wardrobe_items (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, garment_id)
);

CREATE INDEX wardrobe_items_garment_idx ON wardrobe_items (garment_id);

CREATE TABLE outfits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outfits_name_present CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  CONSTRAINT outfits_notes_length CHECK (length(notes) <= 500)
);

CREATE INDEX outfits_owner_idx ON outfits (owner_user_id, updated_at DESC);

CREATE TABLE outfit_items (
  outfit_id uuid NOT NULL REFERENCES outfits (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  role text NOT NULL,
  PRIMARY KEY (outfit_id, role),
  UNIQUE (outfit_id, garment_id),
  CONSTRAINT outfit_items_role_known CHECK (role IN ('top', 'bottom', 'one_piece', 'outerwear'))
);

CREATE INDEX outfit_items_garment_idx ON outfit_items (garment_id);

CREATE TABLE styling_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule_set text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL,
  source text NOT NULL,
  occasion_term_id uuid REFERENCES fashion_terms (id) ON DELETE RESTRICT,
  style_term_id uuid REFERENCES fashion_terms (id) ON DELETE RESTRICT,
  anchor_garment_id uuid REFERENCES garments (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT styling_sessions_rule_set_known CHECK (rule_set = 'style-rules.v1'),
  CONSTRAINT styling_sessions_status_known CHECK (status IN ('completed', 'insufficient_data')),
  CONSTRAINT styling_sessions_source_known CHECK (source IN ('catalog', 'wardrobe')),
  CONSTRAINT styling_sessions_summary_present CHECK (length(btrim(summary)) > 0)
);

CREATE INDEX styling_sessions_user_idx ON styling_sessions (user_id, created_at DESC);

CREATE TABLE styling_session_notes (
  session_id uuid NOT NULL REFERENCES styling_sessions (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  PRIMARY KEY (session_id, position),
  CONSTRAINT styling_session_notes_kind_known CHECK (kind IN ('match', 'limitation', 'assumption', 'attribute')),
  CONSTRAINT styling_session_notes_message_present CHECK (length(btrim(message)) > 0)
);

CREATE TABLE styling_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES styling_sessions (id) ON DELETE CASCADE,
  position integer NOT NULL,
  rule_match_count integer NOT NULL,
  saved_outfit_id uuid REFERENCES outfits (id) ON DELETE SET NULL,
  rejected_at timestamptz,
  UNIQUE (session_id, position),
  CONSTRAINT styling_recommendations_count_nonnegative CHECK (rule_match_count >= 0)
);

CREATE TABLE styling_recommendation_items (
  recommendation_id uuid NOT NULL REFERENCES styling_recommendations (id) ON DELETE CASCADE,
  garment_id uuid NOT NULL REFERENCES garments (id) ON DELETE RESTRICT,
  role text NOT NULL,
  PRIMARY KEY (recommendation_id, role),
  UNIQUE (recommendation_id, garment_id),
  CONSTRAINT styling_recommendation_items_role_known CHECK (role IN ('top', 'bottom', 'one_piece', 'outerwear'))
);

CREATE INDEX styling_recommendation_items_garment_idx ON styling_recommendation_items (garment_id);

CREATE TABLE styling_recommendation_notes (
  recommendation_id uuid NOT NULL REFERENCES styling_recommendations (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  PRIMARY KEY (recommendation_id, position),
  CONSTRAINT styling_recommendation_notes_kind_known CHECK (kind IN ('match', 'limitation', 'assumption', 'attribute')),
  CONSTRAINT styling_recommendation_notes_message_present CHECK (length(btrim(message)) > 0)
);
