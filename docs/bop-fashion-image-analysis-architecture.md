# Bop fashion image analysis architecture

Status of this document: written after `sql/migrations/006_garment_analysis.sql` was applied to the disposable local PostgreSQL 18 cluster, the analysis tests passed, and the `/analysis` page was exercised with the simulated adapter. The desk fixture used for that browser check was removed, and the local cluster was stopped.

The capability is **implemented and simulated**. It is **not operational** with a real provider. No paid API is called. A simulated result is not an observation of the photograph.

Labels:

- **IMPLEMENTED** — present and exercised.
- **SIMULATED** — produced by the test adapter and labeled as such.
- **NOT OPERATIONAL** — no real model is configured or verified.
- **NOT IMPLEMENTED** — intentionally absent.
- **NOT VERIFIED** — not checked in this phase.

## Purpose and scope

An authorized person can submit one existing media asset and receive a structured garment-attribute draft. The draft can be reviewed. Accepted values can be copied onto a catalog garment the person may edit. The draft does not silently change the catalog.

This phase does not generate images, vary images, try garments on a body, measure a person, predict fit, or recommend a wardrobe.

## Existing architecture reused

- AI tasks, claiming, retries, timeouts, and cancellation in the orchestration worker.
- Media reads and the rule that an input must be a ready JPEG, PNG, or WebP original the caller can access.
- Catalog terms and garment ownership. Apply writes through the existing `garment_terms` and `garment_type_id` columns.
- Sessions and the user-or-organization owner rule.

No second queue, media store, or auth system was added.

## Analysis workflow

1. `POST /api/v1/analyses` checks the session, rejects an external image URL, and checks the media asset.
2. The same orchestration path creates a `fashion.garment_attribute_extraction` task and a `garment_analyses` row. The response is `202` with status `queued`.
3. A worker claims the task outside the HTTP request.
4. The test adapter, when enabled, returns a document. The worker validates it before saving attributes.
5. The caller reads `GET /api/v1/analyses/:id`.
6. The caller accepts, rejects, or corrects individual attributes.
7. `POST /api/v1/analyses/:id/apply` writes only accepted or corrected catalog terms, and only where that does not overwrite existing terms unless `replaceKinds` says so.

## Capability registry

The identifier is `fashion.garment_attribute_extraction`.

| Environment | Registry state |
| --- | --- |
| Default (`AI_TEST_PROVIDER` off) | Registered. Not configured. Not available. **Not operational.** |
| `AI_TEST_PROVIDER=1` | Registered, configured, and available through the test adapter. `simulated: true`. **Not operational.** |

Other fashion capabilities stay unconfigured.

## Provider adapter

**SIMULATED** adapter id `test`. It declares this capability only when the test flag is on. It does not read the image bytes. `modelId` is null. Usage is `unreported`. Cost is null. The summary is: `Simulated garment-attribute fixture. No model was called and the image was not inspected.`

A non-simulated result is rejected with `A real analysis provider is not configured.` That keeps a fixture from being stored as a genuine analysis.

The test flag is off by default.

## Input schema

`POST /api/v1/analyses` accepts `mediaId` and, for an organization-owned task, `organizationId`. One image is required. `url`, `imageUrl`, `href`, and `src` are rejected. Provider, model, and credential fields are rejected.

When the test adapter is enabled, `outcome` may be `succeed`, `partial`, `fixture`, `malformed`, `invalid_type`, `temporary_failure`, `permanent_failure`, `timeout`, `unsupported`, or `hang`. When the adapter is off, `outcome` is rejected.

## Output schema

Schema version: `garment-attributes.v1`.

Each attribute has `value`, `basis` (`observed`, `inferred`, or `unknown`), `note`, `confidence`, `confidenceSource`, `reviewStatus`, and `fiberEstablished`.

`unknown` requires a null value and a null confidence. Omitted attributes are stored as unknown. The model is not forced to fill them.

`fiberEstablished` is always false. `apparent_material` cannot use basis `observed`, because a photograph does not prove silk, cotton, wool, Ankara, Aso Oke, or any other fiber. A pattern that resembles Ankara is not stored as that textile. Kente remains both a material term and a tradition term in the catalog; this capability does not choose one from an image.

A simulated provider result cannot use basis `observed`. An inferred simulated value must carry the note `Simulated fixture. This was not read from the image.` No numeric confidence is invented. Provider confidence is stored only when the provider sends a number from 0 to 1 with `confidenceSource: "provider"`. The test adapter sends neither.

There are no fields for a person's identity, age, health, or ethnicity. Those keys are rejected.

## Attribute taxonomy

Catalog-backed keys, applied only when the slug already exists:

| Attribute | Catalog kind |
| --- | --- |
| `primary_type` | `garment_type` |
| `category` | `category` |
| `pattern` | `pattern` |
| `style` | `style` |
| `tradition` | `tradition` |
| `dominant_colors`, `secondary_colors` | `color` |
| `silhouette` | `silhouette` |
| `length` | `length` |
| `sleeve` | `sleeve` |
| `neckline` | `neckline` |
| `occasion` | `occasion` |

`apparent_material` is never copied onto a material term. `secondary_type`, `subcategory`, `tags`, texture, weave, sheen, drape, construction, layering, embellishment, and item count stay on the draft. African garment types such as `agbada` are ordinary `garment_type` slugs, not a separate system.

## Provenance

The analysis row stores the task id, media id, schema version, provider id, model id, and simulated flag. The task stores status, attempts, safe errors, and usage. Review and apply actions are stored in `garment_analysis_events` and `garment_analysis_applications`. Responses do not include storage keys or secrets.

## Database

**IMPLEMENTED** in `sql/migrations/006_garment_analysis.sql`.

Tables: `garment_analyses`, `garment_analysis_attributes`, `garment_analysis_events`, `garment_analysis_applications`.

The analysis cascades when its task is deleted. Media and garment links use `RESTRICT`. Migrations `001` through `005` were not rewritten.

## API

All routes require a session. Another user's private analysis or image returns 404.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/v1/analyses` | Queue an analysis. `202` |
| `GET` | `/api/v1/analyses` | List analyses the caller may see |
| `GET` | `/api/v1/analyses/:id` | Status, attributes, and apply history |
| `POST` | `/api/v1/analyses/:id/cancel` | Cancel only while the task is queued |
| `PATCH` | `/api/v1/analyses/:id/attributes/:key` | `accept`, `reject`, or `correct` |
| `POST` | `/api/v1/analyses/:id/apply` | Copy approved catalog terms onto a garment |

Unknown values cannot be accepted. A running task still cannot be cancelled. Invalid documents fail the task with `invalid_response` and leave the attribute list empty.

## Authorization

The caller must be able to read the image. Organization tasks follow active membership. Apply also requires permission to act for the garment owner. A private garment the caller cannot access returns 404, and its terms stay as they were.

## Human review

New attributes start as `pending`. Pending values are not applied. `accepted` and `corrected` values can be applied. `rejected` values are not applied. Existing catalog terms are kept unless the request includes that kind in `replaceKinds`. Material appearance is skipped even when accepted. Cotton already on a garment stayed in place when a garment type was replaced in the test.

## Error handling

Malformed and wrongly typed provider documents become `invalid_response`. Provider failures keep their category. Timeouts use the existing retry limit. Clients receive the safe message, not a stack or a raw provider body.

## Tests

`server/test/analysis.test.ts` uses the test adapter only. No paid call is made.

The first run failed the partial-document case because an omitted attribute was treated as a schema failure. Omitted attributes are now stored as unknown. The rerun of `npm test` passed: **33 passed, 0 failed**.

Covered cases include an unconfigured provider, an external URL, a private image, a private analysis, unknown material, a refused fiber observation, catalog overwrite protection, explicit replacement, partial documents, invalid types, permanent failure, timeout, cancellation, and the simulated fixture.

`npm run lint` and `npm run typecheck` passed after the analysis page was adjusted so the desk mounts on the client. `npm run build` passed earlier in this phase and prerendered `/` and `/analysis`. No paid call is part of those commands.

The analysis page was exercised in a local browser at `http://localhost:3000/analysis` with the test adapter and worker running. Sign-in, image selection, a succeeded simulated result, the labels Simulated and Not operational, unknown attributes shown as Not established, a human correction of primary type to the catalog slug `agbada`, and apply onto an empty garment all completed. The garment type in the local database became `agbada`. The landing page at `/` still showed the hero and the footer film at `/landing/bop landing page UI/footer video.mp4`. That browser pass used the simulated adapter. It is not evidence of a real model.

## Environment

No analysis credential is read.

| Variable | Role |
| --- | --- |
| `AI_TEST_PROVIDER=1` | Enables the simulated adapter. Leave this off for ordinary local use. |
| `AI_WORKER=1` | Lets the API process claim queued tasks. |
| `BOP_API_ORIGIN` | Optional. The `/analysis` page proxies `/api/v1` here. Default `http://127.0.0.1:5000`. |

## Real-provider activation

**NOT IMPLEMENTED.** A later change would add an adapter that declares only this capability, read a credential from an uncommitted variable, send the authorized original bytes, map errors into the existing categories, and return a document that passes `parseGarmentAnalysis`. It must not mark `apparent_material` as observed. It must not send a non-simulated result until that adapter is reviewed. `operational` stays false until a real task has completed against that provider.

## Frontend

**IMPLEMENTED** as a separate page at `/analysis`. It signs in through the existing session API, uploads or selects an image, starts an analysis, shows unknown values as "Not established", and applies accepted attributes. The interactive desk is mounted after the first paint so the server HTML and the first client render match. The landing page, hero, and footer video were not changed. `footer video.mp4` remains the film in `lib/landing-assets.ts`.

The landing sign-in dialog still does not call the API. The analysis page does not run unless the API is reachable through the local proxy. Without `AI_TEST_PROVIDER` and `AI_WORKER`, a submission stays unavailable or queued.

## Known limitations

- No real image has been analyzed by a model.
- The test adapter does not look at pixels.
- Confidence scores are not estimated by the application.
- Secondary type, tags, and material appearance are not catalog writes.
- The in-process rate limit is not shared across processes.
- Row-level security is still off.

## Future integration

Visualization, styling, and try-on can point at the same analysis id and media id. They should not add another task queue.
