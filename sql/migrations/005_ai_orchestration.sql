-- AI task records. No image bytes, no provider credentials, no billing.

CREATE TABLE ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  design_project_id uuid REFERENCES design_projects (id) ON DELETE RESTRICT,
  idempotency_key text,
  input_fingerprint text NOT NULL,
  input jsonb NOT NULL,
  provider_id text,
  model_id text,
  simulated boolean NOT NULL DEFAULT false,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error_category text,
  error_message text,
  run_after timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tasks_one_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_organization_id IS NULL)
    OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)
  ),
  CONSTRAINT ai_tasks_capability_shape CHECK (capability ~ '^[a-z]+(\.[a-z_]+)+$'),
  CONSTRAINT ai_tasks_status_known CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT ai_tasks_attempts_valid CHECK (max_attempts > 0 AND attempt_count >= 0 AND attempt_count <= max_attempts),
  CONSTRAINT ai_tasks_error_category_known CHECK (
    error_category IS NULL OR error_category IN (
      'temporary_network',
      'rate_limited',
      'timeout',
      'invalid_request',
      'unsupported_capability',
      'authentication',
      'quota',
      'invalid_response',
      'permanent'
    )
  ),
  CONSTRAINT ai_tasks_error_message_length CHECK (
    error_message IS NULL OR length(error_message) <= 240
  ),
  CONSTRAINT ai_tasks_idempotency_shape CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9._:-]{8,80}$'
  ),
  CONSTRAINT ai_tasks_provider_shape CHECK (
    provider_id IS NULL OR (length(btrim(provider_id)) BETWEEN 1 AND 40 AND provider_id !~ '[^A-Za-z0-9._-]')
  ),
  CONSTRAINT ai_tasks_input_object CHECK (jsonb_typeof(input) = 'object')
);

CREATE UNIQUE INDEX ai_tasks_idempotency_idx
  ON ai_tasks (created_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX ai_tasks_claim_idx
  ON ai_tasks (run_after, created_at, id)
  WHERE status = 'queued';

CREATE INDEX ai_tasks_owner_user_idx ON ai_tasks (owner_user_id);
CREATE INDEX ai_tasks_owner_organization_idx ON ai_tasks (owner_organization_id);
CREATE INDEX ai_tasks_design_project_idx ON ai_tasks (design_project_id);

CREATE TRIGGER ai_tasks_set_updated_at
  BEFORE UPDATE ON ai_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ai_task_inputs (
  task_id uuid NOT NULL REFERENCES ai_tasks (id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  PRIMARY KEY (task_id, media_id),
  CONSTRAINT ai_task_inputs_position_positive CHECK (position > 0)
);

CREATE INDEX ai_task_inputs_media_idx ON ai_task_inputs (media_id);

CREATE TABLE ai_task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ai_tasks (id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  provider_id text NOT NULL,
  model_id text,
  status text NOT NULL,
  error_category text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  CONSTRAINT ai_task_attempts_number_unique UNIQUE (task_id, attempt_number),
  CONSTRAINT ai_task_attempts_number_positive CHECK (attempt_number > 0),
  CONSTRAINT ai_task_attempts_status_known CHECK (status IN ('succeeded', 'failed')),
  CONSTRAINT ai_task_attempts_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT ai_task_attempts_error_message_length CHECK (
    error_message IS NULL OR length(error_message) <= 240
  )
);

CREATE TABLE ai_task_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ai_tasks (id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES ai_task_attempts (id) ON DELETE CASCADE,
  media_id uuid REFERENCES media_assets (id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  model_id text,
  simulated boolean NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_task_outputs_one_per_attempt UNIQUE (attempt_id),
  CONSTRAINT ai_task_outputs_summary_present CHECK (length(btrim(summary)) > 0)
);

CREATE INDEX ai_task_outputs_media_idx ON ai_task_outputs (media_id);
CREATE INDEX ai_task_outputs_task_idx ON ai_task_outputs (task_id);

CREATE TABLE ai_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ai_tasks (id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES ai_task_attempts (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  model_id text,
  source text NOT NULL,
  input_units integer,
  output_units integer,
  image_count integer,
  duration_ms integer,
  estimated_cost_minor integer,
  currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_source_known CHECK (source IN ('provider', 'estimate', 'unreported')),
  CONSTRAINT ai_usage_units_nonnegative CHECK (
    (input_units IS NULL OR input_units >= 0)
    AND (output_units IS NULL OR output_units >= 0)
    AND (image_count IS NULL OR image_count >= 0)
    AND (duration_ms IS NULL OR duration_ms >= 0)
    AND (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0)
  ),
  CONSTRAINT ai_usage_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE TABLE ai_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ai_tasks (id) ON DELETE CASCADE,
  kind text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_task_events_kind_known CHECK (
    kind IN (
      'accepted',
      'started',
      'attempt_failed',
      'retry_scheduled',
      'completed',
      'permanently_failed',
      'cancelled'
    )
  ),
  CONSTRAINT ai_task_events_message_present CHECK (length(btrim(message)) > 0 AND length(message) <= 240)
);

CREATE INDEX ai_task_events_task_idx ON ai_task_events (task_id, created_at);
