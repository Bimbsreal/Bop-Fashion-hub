# Bop virtual try-on architecture

Status of this document: written after `sql/migrations/008_try_on.sql` was applied on the disposable local PostgreSQL 18 cluster, the try-on tests passed, and `/try-on` was exercised in a local browser. The desk account used for that browser check was removed. The landing page and `footer video.mp4` were left in place.

The request record and validation are **implemented**. Realistic virtual try-on is **not operational**. No provider is configured. No simulated image is produced. A recorded request is not a try-on result.

Labels:

- **IMPLEMENTED** — present and exercised.
- **NOT OPERATIONAL** — registered or reserved, with no configured provider.
- **NOT IMPLEMENTED** — intentionally absent.

## Purpose and scope

This phase records an authorized try-on request: a person image, a catalog garment image, a garment category taken from the catalog, a photograph presentation, and consent that covers that request only. The record can be read by its owner, cancelled while it is still a draft, and refused when someone asks to save a result.

No image is sent to a model. No output asset is created. `fashion.virtual_try_on` stays registered and unavailable.

This phase does not measure a body, predict fit, recommend a size, generate a fashion image, style an outfit, or take payment.

## Architecture audit

The following were inspected in the repository, not assumed from earlier documents.

| Area | Finding |
| --- | --- |
| Auth and profiles | Local sessions, `bop_session` cookie, register and login. Landing sign-in remains a placeholder. |
| Media | Originals and thumbnails in `.local/media`. Bytes are not stored in PostgreSQL. Private reads by outsiders return 404. |
| Catalog | Garments, terms, and `garment_media` roles. Agbada is a garment type. |
| Design | Projects and revisions. A revision must belong to the named project. |
| Visualization | Reference boards. `POST /visualizations/:id/generate` returns `capability_unavailable` and stores nothing. |
| AI orchestration | Database-backed worker. `fashion.virtual_try_on` is registered. No provider declares it, including the test adapter. |
| Generic AI tasks | `POST /api/v1/ai/tasks` accepts a design-project id for try-on and rejects media. A valid body still returns `capability_unavailable` and inserts no task. |

No second media store, queue, provider registry, or authentication system was added.

## Feasibility

No virtual try-on model or provider is configured. Environment variables hold no try-on credential, category list, price, rate limit, retention term, or model version. The test adapter declares `test.orchestration` and `fashion.garment_attribute_extraction` only. It does not declare `fashion.virtual_try_on`.

An image-generation model would not, by itself, be treated as garment-preserving try-on. No weights were downloaded and no external account was created.

Until a provider exists, these requirements are the selection criteria:

- It must accept two authorized media assets already stored by Bop: one person image and one garment image. It must not take an arbitrary remote URL.
- It must state which garment categories it supports. The capability view keeps `supportedCategories` empty until that list is real.
- It must return an image that Bop can validate and store as a new media asset. Success is not reported before that asset exists.
- It must expose a model identifier when the provider has one, plus failure, timeout, and rate-limit behavior.
- Cost is recorded only when the provider returns it. It is not estimated.
- Person images are not sent until the provider's retention and training terms are known and the request consent stays limited to that request.

Quality limits that a future provider would still have to disclose: garment shape, sleeves, necklines, patterns, length, pose, occlusion, color, textile detail, and layered clothing can all be wrong. A generated image would be a visualization. It would not be proof of physical fit, size, or measurements. This implementation invents no quality score.

## Input requirements

**IMPLEMENTED** for the request record. A provider has not accepted these inputs.

| Check | Rule |
| --- | --- |
| Formats | JPEG, PNG, or WebP. GIF is rejected. |
| Asset | Ready original with recorded width and height. Pending metadata and thumbnails are rejected. |
| Size | Shorter side at least 256 pixels. Longer side at most `MEDIA_MAX_EDGE` (default 8000). Bytes at most `MEDIA_MAX_BYTES` (default 8 MiB). |
| Pair | The person image and the garment image must be different assets. |
| Garment | The image must be linked to the named catalog garment. The category is that garment's type slug. A garment with no type is `unsupported_category`. |
| Presentation | `catalog`, `worn`, `flat_lay`, or `mannequin`. The caller states this. The server does not infer it from the pixels. |
| Rejected roles | `sketch`, `fabric`, `generated`, and `construction`. |
| Remote fields | `url`, `imageUrl`, `href`, `src`, `provider`, `generated`, and `storageKey` are rejected. |

Original images are not resized or overwritten to force a match.

## Capability contract

Identifier: `fashion.virtual_try_on`.

`GET /api/v1/try-on/capability` is anonymous and returns `registered: true`, `configured: false`, `operational: false`, `simulated: false`, `supportedCategories: []`, and `fitClaim: false`. The message is `Virtual try-on is not configured. No image was generated.`

The generic task route is unchanged. Person images are not queued there.

## Consent and privacy

**IMPLEMENTED** for the request record. Real-person processing by a model is **not enabled**.

- Creating a request requires `consent.purpose` of exactly `try_on_request`.
- A consent object that includes `training` is rejected. Upload consent is not a training grant.
- The row stores `consent_purpose` and `consented_at`. It does not store a face descriptor or an inferred attribute.
- Access follows the existing owner rule: one user or one active organization membership. There is no public try-on request. Outsiders receive 404.
- Responses include media ids and filenames the caller can already read. They do not include storage keys, file bytes, or provider payloads.
- The module does not log image bytes.
- Deleting a referenced media asset, garment, project, revision, or visualization is restricted while the request exists, so the source relationship cannot be detached by deleting the original.

## Lifecycle

The table allows `draft`, `queued`, `running`, `succeeded`, `failed`, and `cancelled`, matching the AI task vocabulary.

Only `draft` and `cancelled` are reachable. A new request is inserted as `draft` with `ai_task_id` and `output_media_id` null. Cancelling a draft sets `cancelled`. Cancelling twice returns the cancelled row. Any other status returns `cancel_unsupported`. Those other statuses are not written by this phase.

A draft cannot have an AI task. An output asset can be stored only when status is `succeeded`. Nothing in this phase sets `succeeded`.

`POST /api/v1/try-on/:id/save` confirms the caller can read the request, then returns `invalid_result`: `No try-on result exists to save.` It does not copy an image onto a project.

## Data model

Migration `sql/migrations/008_try_on.sql` adds `try_on_requests`.

It references existing `users`, `organizations`, `media_assets`, `garments`, `design_projects`, `design_revisions`, `visualization_concepts`, and `ai_tasks`. Image bytes stay in the media store.

Optional links: design project, revision (only with that project), and visualization concept. Each must be readable by the caller before insert. An idempotency key, when sent, is unique per creator. The same key with a different person image, garment, presentation, category, project, revision, visualization, or consent purpose returns 409. A matching replay returns 200 and the same row.

## API

Base: `http://localhost:5000/api/v1/try-on`. The Next app rewrites `/api/v1` to that API.

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/capability` | none | Availability and input limits |
| `POST` | `/` | session | Validate and insert a draft. `201`, or `200` on idempotent replay |
| `GET` | `/` | session | List requests the caller can see |
| `GET` | `/:id` | session | Read one request |
| `POST` | `/:id/cancel` | session | Cancel a draft |
| `POST` | `/:id/save` | session | `invalid_result`. No result exists |

`POST /` is limited by `AI_MAX_TASKS_PER_MINUTE` (default 30) in the API process. The message is `Too many try-on requests. Try again shortly.`

Errors use the existing envelope and status mapping. Raw provider errors are not returned because no provider is called.

## Frontend

`/try-on` is a local workspace. It loads the capability message, lists the signed-in user's media and garments, previews the selected person and garment images through the existing media content route, and asks for request-scoped consent.

The action is **Record request**. It is not a generate button. After a successful save the page shows the draft or cancelled status, the server message, the category, and the statement that no result image exists and fit was not measured.

When `supportedCategories` is empty, the page says no garment category is supported by a provider. Sketch, swatch, construction, and generated roles are labeled not eligible. The server still rejects them if they are submitted.

## Provider configuration and cost

No try-on provider variable was added. Defaults stay unavailable: `configured` and `operational` are false, supported categories are empty, and `fitClaim` is false.

`AI_TEST_PROVIDER=1` does not make try-on simulated. The test adapter was not given this capability, so a test run cannot present a fixture image as a try-on.

No cost figure is stored. None was returned by a provider.

## Testing

`npm test` applies migrations and runs the existing server tests plus `server/test/try-on.test.ts`. Addresses use `@tryon.test` and are deleted afterward, including dependent rows.

Exercised:

- Capability flags stay false and supported categories stay empty.
- Anonymous create returns 401.
- Missing consent, a training flag, and an external URL are rejected.
- Another user's private image returns 404 and inserts no row.
- An image smaller than 256 pixels, a GIF, and a byte size above the limit are rejected.
- A sketch role is `unsupported_garment`.
- Another user's design project returns 404 and inserts no row.
- A consented catalog image on an Agbada garment inserts a draft with no output, no AI task, and unchanged storage keys.
- A stranger cannot read that request.
- Save returns `invalid_result`.
- The generic AI task route still rejects try-on media and inserts no task.
- Cancel moves the draft to `cancelled` and leaves output null.
- The same idempotency key replays one row. A different presentation with that key returns 409.

Not exercised, because no provider runs:

- A queued, running, or succeeded try-on task.
- Provider timeout, malformed output, or failed output persistence.
- A genuine generated image.

Automated tests make no paid external call.

A local browser session at `http://localhost:3000/try-on` signed in, loaded the unavailable message and the empty supported-category notice, previewed a person image and a garment image, refused a submit without consent, and then recorded a draft. The page showed status `draft`, category `agbada`, and the statement that no result image exists and fit was not measured. The landing page still showed its hero, and the footer video at `/landing/bop%20landing%20page%20UI/footer%20video.mp4` was playing.

## Current limitations

- No garment category is supported for generation.
- `queued`, `running`, `succeeded`, and `failed` are reserved and unused.
- There is no comparison view, because there is no generated image.
- Saving to a design or visualization project waits until a real output asset exists.
- Retention deletion of a person image is blocked while a request references it. A later phase can define a deletion workflow that removes the request and the image together.
- The catalog garment response can still include a storage key for an editor. That is existing catalog behavior. Try-on responses do not add it.

## Future integration

A later phase can add a provider adapter only after an explicit choice of provider. That adapter would resolve media through the current media module, enforce the limits above, create an AI task through the current orchestration layer, store a new output asset, and set the request to `succeeded` only after that asset is valid. Until then the capability remains unavailable.
