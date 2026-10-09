# Bop AI orchestration architecture

Status of this document: written after `sql/migrations/005_ai_orchestration.sql` was applied to the disposable local PostgreSQL 18 cluster and the AI tests passed. Earlier notes live in `docs/bop-core-domain-architecture.md`, `docs/bop-fashion-catalog-architecture.md`, `docs/bop-media-asset-architecture.md`, and `docs/bop-fashion-creation-architecture.md`.

Labels used here:

- **IMPLEMENTED** — present and exercised.
- **CONFIGURED** — a provider for that capability is selected from local configuration.
- **OPERATIONAL** — a real provider has performed the capability. None are operational.
- **SIMULATED** — a test adapter ran the path and labeled the result as simulated.
- **PLANNED** — reserved for a later phase.
- **NOT IMPLEMENTED** — intentionally absent.
- **NOT VERIFIED** — not checked in this phase.

Landing-page files were not moved or renamed. The African fashion film still uses `footer video.mp4` through `lib/landing-assets.ts`.

## 1. Orchestration architecture

**IMPLEMENTED** as modules inside the existing Express process. Fashion domain modules do not import a provider SDK.

| Concern | Where it lives |
| --- | --- |
| Design projects, garments, media | Existing domain modules |
| Task records, ownership, inputs, attempts, outputs, usage, events | `server/src/modules/ai-tasks.ts` |
| Provider contract and error categories | `server/src/modules/ai-provider.ts` |
| Test adapter | `server/src/modules/ai-test-provider.ts` |
| Capability list and input contracts | `server/src/modules/ai-capabilities.ts` |
| Claim, timeout, retry, stale recovery | `server/src/modules/ai-worker.ts` |

HTTP routes validate and store a task, then return. The worker runs afterward. A request is not held open until a provider finishes.

## 2. Capability registry

Fashion capability names are **registered** in code. Registration does not make them **configured**, **available**, or **operational**.

| Capability | This phase |
| --- | --- |
| `fashion.image_analysis` | Registered. Not configured. Not operational. |
| `fashion.design_generation` | Registered. Not configured. Not operational. |
| `fashion.image_variation` | Registered. Not configured. Not operational. |
| `fashion.garment_attribute_extraction` | Registered. Not configured. Not operational. |
| `fashion.virtual_try_on` | Registered. Not configured. Not operational. The generic task route still rejects media. Consented requests are recorded separately and do not generate an image. See `docs/bop-virtual-try-on-architecture.md`. |
| `fashion.style_recommendation` | Registered. Not configured. Not operational. |
| `fashion.fit_analysis` | Registered. Not configured. Not operational. Measurements are rejected. |
| `fashion.design_visualization` | Registered. Not configured. Not operational. No provider is attached, including the test adapter. |
| `test.orchestration` | **SIMULATED.** Present only when the test adapter is enabled. `operational` stays false. |

`GET /api/v1/ai/capabilities` returns `registered`, `configured`, `available`, `operational`, `disabled`, and `simulated`. With the default environment, every fashion row has `operational: false` and `configured: false`, and `test.orchestration` is omitted. When the test adapter is enabled it also declares `fashion.garment_attribute_extraction` as simulated and not operational. That capability is documented in `docs/bop-fashion-image-analysis-architecture.md`.

An unknown name is rejected. A registered name with no provider is rejected with `capability_unavailable`. The worker does not send that task to another provider.

## 3. Provider adapter interface

**IMPLEMENTED** as a small capability-based contract:

- `capabilities()` declares the names that adapter supports
- `available()` reports whether it can accept work
- `execute()` receives a task id, attempt, stable idempotency key, and the validated input
- failures are `ProviderFailure` values with a category

There is no plugin loader. The only adapter in the repository is the test adapter. Its id is `test`. With the test flag off it is not loaded. With the flag on it declares `test.orchestration` and the simulated garment-attribute capability, and no other `fashion.*` capability.

The orchestrator picks the first available adapter that declares the capability. It does not fail over to a second adapter.

## 4. Task domain model

**IMPLEMENTED** in `ai_tasks` and related tables.

A task has a stable id, a capability, one owner (user or organization), the creating user, an optional design-project id, validated input JSON, a provider id chosen by the server, a simulated flag, attempt counts, error category, and timestamps. Clients cannot set provider, model, or provider parameters.

Input images are rows in `ai_task_inputs` pointing at existing `media_assets`. File bytes are not stored on the task. Responses omit storage keys.

The design-project id is a reference. Completing a task does not add media to that project.

## 5. Task lifecycle

**IMPLEMENTED.** States are `queued`, `running`, `succeeded`, `failed`, and `cancelled`.

| From | To | When |
| --- | --- | --- |
| `queued` | `running` | A worker claims it |
| `queued` | `cancelled` | The owner or an active organization member cancels it |
| `running` | `succeeded` | The attempt finishes |
| `running` | `failed` | The attempt is not retryable, or the attempt limit is reached |
| `running` | `queued` | A retryable failure still has attempts left, or a stale claim is recovered |

A succeeded, failed, or cancelled task is not claimed again. Claim selects `queued` rows only.

Cancellation is guaranteed only while the task is `queued`. A `running` task returns `cancel_unsupported`. This phase does not tell a remote provider to stop, because no remote provider is called.

## 6. Background execution strategy

**IMPLEMENTED** with PostgreSQL, not a broker.

`runWorkerOnce` recovers stale `running` rows, then claims one `queued` row with `FOR UPDATE SKIP LOCKED`, commits, and only then calls the adapter. The provider call is outside the database transaction.

`AI_WORKER=1` makes the API process call that function about once a second. The default is off, so a restart does not erase queued rows and also does not run them until a worker is started. Tests call `runWorkerOnce` directly.

Stale recovery treats a `running` row whose lock is older than `AI_STALE_RUNNING_MS` (default 120000) as abandoned. If attempts remain, it returns the row to `queued`. If the attempt limit is already reached, it marks the row `failed`. The stale window is meant to be longer than the attempt timeout. A result that arrives after recovery has already moved the row is discarded.

A crash between claim and the result write can run the same task again. The adapter receives the task id as its idempotency key on every attempt.

## 7. Retry and failure handling

**IMPLEMENTED.** The category decides retry. A provider cannot mark an invalid request as retryable.

| Category | Retry |
| --- | --- |
| `temporary_network` | Yes, until `max_attempts` |
| `rate_limited` | Yes, until `max_attempts` |
| `timeout` | Yes, until `max_attempts` |
| `invalid_request` | No |
| `unsupported_capability` | No |
| `authentication` | No |
| `quota` | No |
| `invalid_response` | No |
| `permanent` | No |

The default limit is 3. Backoff starts at `AI_TASK_BACKOFF_MS` (default 200) and doubles, capped at 60 seconds. Tests use a zero backoff. The worker also stops an attempt that exceeds `AI_TASK_TIMEOUT_MS`.

No provider is substituted after a failure.

## 8. Provider configuration

**IMPLEMENTED** through environment variables. No API key is read, stored, or returned.

| Variable | Default | Role |
| --- | --- | --- |
| `AI_TEST_PROVIDER` | off | Enables the simulated adapter |
| `AI_WORKER` | off | Polls for queued tasks in the API process |
| `AI_TASK_MAX_ATTEMPTS` | 3 | Attempt limit stored on each new task |
| `AI_TASK_TIMEOUT_MS` | 10000 | Worker deadline |
| `AI_TASK_BACKOFF_MS` | 200 | Retry delay |
| `AI_STALE_RUNNING_MS` | 120000 | Abandoned-claim window |
| `AI_MAX_TASKS_PER_MINUTE` | 30 | Submission limit for one API process |

With the defaults, every fashion submission returns `capability_unavailable`. The test capability is not listed. An unconfigured provider is not reported as operational.

## 9. Input validation

**IMPLEMENTED** per capability. The raw body is not forwarded.

- Unknown fields and provider settings are rejected.
- Image capabilities require 1 to 4 media ids. Each asset must be readable by the caller, an original, `ready`, and JPEG, PNG, or WebP. Pending metadata and thumbnails are rejected.
- `fashion.design_generation` requires a readable design project and a note of at most 500 characters. The note is stored on the task input and is not returned in the task response. No provider receives it in this phase, because no provider is configured.
- On `POST /api/v1/ai/tasks`, try-on, styling, and fit accept a design-project id only. Media and measurement fields are rejected. A consented try-on request is recorded on `/api/v1/try-on` and still creates no AI task.
- `test.orchestration` accepts an outcome of `succeed`, `temporary_failure`, `permanent_failure`, `timeout`, `unsupported`, or `hang`, plus optional media and design-project ids.
- `Idempotency-Key` replays the same task for that user. A different payload with the same key returns 409.

## 10. Output provenance

**PARTIALLY IMPLEMENTED.** A successful test attempt writes `ai_task_outputs` with the provider id `test`, a null model id, `simulated: true`, and the summary `Simulated test result. No AI model was called and no image was produced.` `media_id` stays null. Original images are not overwritten.

The task response includes that summary, the provider id, the simulated flag, and `media: null`. It does not include a raw provider payload.

Attaching an output to a design project is **NOT IMPLEMENTED**.

## 11. Usage tracking

**PARTIALLY IMPLEMENTED.** Each finished attempt writes `ai_usage_records`. The test adapter reports `source: unreported`. Input units, output units, image count, estimated cost, and currency are null. `duration_ms` is the worker clock, not a provider usage figure. No cost is invented. Users are not charged.

A billing system is **NOT IMPLEMENTED**.

## 12. Security and privacy

**IMPLEMENTED** for task access.

- Submission, listing, reading, and cancellation require a session.
- A private task returns 404 to another user. There is no public task visibility.
- Organization tasks are visible to active members of that organization only.
- Input media must already be readable by the caller.
- Task responses omit storage keys, credentials, and image bytes.
- Events store fixed messages. The worker log line is `{ scope: "ai", kind: "worker_error" }` with no request body.
- Submission is limited per user inside one process. That limit is not shared across processes.
- No private media is sent to an external provider. No body-measurement or try-on processing runs.

## 13. API endpoints

**IMPLEMENTED** under `/api/v1/ai`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/capabilities` | Registry with configured, available, operational, and simulated flags |
| `POST` | `/tasks` | Validate and queue. `202` with the task id. Replay with the same idempotency key returns `200` |
| `GET` | `/tasks` | Authorized tasks. `limit` defaults to 20 and stops at 50. `offset` stops at 10000. Optional `status` |
| `GET` | `/tasks/:id` | Status, safe error, result, and events |
| `POST` | `/tasks/:id/cancel` | Cancels a queued task. Running tasks return 409 |

## 14. Database migrations

**IMPLEMENTED.** New file: `sql/migrations/005_ai_orchestration.sql`.

Tables: `ai_tasks`, `ai_task_inputs`, `ai_task_attempts`, `ai_task_outputs`, `ai_usage_records`, `ai_task_events`.

Migrations `001` through `004` were not rewritten. The disposable cluster recorded `001` through `005`. Applying migrations again is covered by the existing migration test.

Task children cascade when the task is deleted. Media and design-project foreign keys are `RESTRICT`. Owner and creator foreign keys are `RESTRICT`.

## 15. Tests and results

**IMPLEMENTED** in `server/test/ai.test.ts`. Fixtures use `@ai.test` and `ai-test-` organization slugs and are removed afterward. The test adapter is enabled only on the test app. No paid API is called.

Executed with `DATABASE_URL=postgres://bop@127.0.0.1:5433/bop`:

- The first `npm test` in this phase failed 3 AI tests. Thumbnail ids were accepted because the media lookup can read a thumbnail the user owns. The task contract now rejects a non-original, and those assertions were corrected.
- The rerun passed: **30 passed, 0 failed**, including foundation, catalog, media, design, and AI tests.
- Coverage that passed: capability flags, unconfigured rejection, input and media checks, queued submission, idempotent replay, organization isolation, retry limit, permanent failure, timeout classification, worker deadline, queued cancellation, running cancellation refusal, stale failure, stale requeue, concurrent claims, rate limit, simulated provenance, and the stable task id sent on each retry.
- `npm run lint`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0. The home route was prerendered.
- After the tests: `schema_migrations` contained `001` through `005`; users, garments, media, design projects, and AI tasks were 0; `fashion_terms` stayed 43.

Browser verification of the landing page was **NOT VERIFIED** because no landing file changed.

A crash between the provider call and the result write was **NOT VERIFIED**. Provider idempotency beyond the test adapter was **NOT VERIFIED**, because no external provider is connected.

## 16. Known limitations

- No fashion capability is operational.
- The test adapter is not a model and must not be treated as one. Leave `AI_TEST_PROVIDER` off outside tests.
- The API worker is off unless `AI_WORKER=1`.
- Cancellation does not reach a remote process.
- Retries can repeat work if a future provider ignores the task id.
- Usage units and cost are empty.
- Outputs are text provenance rows, not files.
- The rate limit is per process.
- Row-level security is still off. Authorization is in the application.
- The landing sign-in dialog still does not create a session.

## 17. Steps required to connect a real AI provider

**NOT IMPLEMENTED.** A later adapter would:

1. Add a module that implements `AiProvider` and declares only the capabilities that provider will actually run.
2. Read its credential from an environment variable that is never committed, never logged, and never returned by the API.
3. Map that provider's errors into the existing categories.
4. Pass the task id as the idempotency key when the provider supports one, and document duplicate charges when it does not.
5. Store generated files through the media asset module, as new original assets, with the task output row pointing at that media id.
6. Mark the capability configured only when the credential and a successful health check exist. Leave `operational` false until a real task has completed.
7. Keep fashion modules dependent on task ids, not on that provider's response shape.

Do not point the test adapter at a paid API.
