# Bop fashion visualization architecture

Status of this document: written after `sql/migrations/007_visualization.sql` was applied on the disposable local PostgreSQL 18 cluster, the visualization tests passed, and `/visualize` was exercised in a local browser. The desk fixture used for that browser check was removed, and the local cluster was stopped.

The capability to arrange references is **implemented**. Image generation is **not operational**. No paid API is called. A selected reference is not a generated design.

Labels:

- **IMPLEMENTED** — present and exercised.
- **NOT OPERATIONAL** — registered or reserved, with no configured provider.
- **NOT IMPLEMENTED** — intentionally absent.

## Purpose and scope

An authorized person can create a visualization concept, attach images they can already read, order those references, and point the concept at a catalog garment, a design project, and a design revision. The preview is one of those references. Removing a reference removes the association only.

This phase does not generate images, try a garment on a body, measure a person, predict fit, or recommend a wardrobe.

## Existing components reused

- Design projects, revisions, and the rule that a revision belongs to one project.
- Catalog garments and fashion terms, including Agbada.
- Media reads. An attached image must be an original the caller can access. Thumbnails are rejected.
- Ownership: one user or one organization. Private reads by outsiders return 404.
- The AI capability registry. `fashion.design_visualization` is registered and has no provider.

No second queue, media store, or auth system was added. Design projects were not rewritten into visualization records.

## Domain model

`visualization_concepts` is the board. It stores a title, notes, visibility, a workflow method, and a status.

| Field | Values |
| --- | --- |
| `method` | `reference_board`, `concept_preview`, `manual_variation` |
| `status` | `draft`, `arranged`, `archived` |
| `visibility` | `private` or `public`. Default `private` |

Optional links: `design_project_id`, `revision_id`, `garment_id`. A revision requires a design project, and the service rejects a revision from a different project. Changing the project without sending a new revision clears the previous revision.

`preview_media_id` and `preview_origin` point at a reference already on the concept. The first reference becomes the preview. There is no generated-origin value. The API field `generated` is always `false`.

`visualization_references` stores `media_id`, `position` from 1 to 24, `origin`, and a note.

| Origin | Meaning |
| --- | --- |
| `original_reference` | An existing image used as a reference |
| `manual_upload` | A file the person uploaded as a variation |
| `design_revision` | A reference tied to a design revision |

`generated` and `ai` are not accepted origins.

A public concept does not make its images public. A viewer who cannot read an image receives `available: false` and no filename. The content route still enforces media visibility.

## Reference management

Adding the same image twice returns 409. Removal deletes the association row and renumbers positions. The `media_assets` row remains. Reordering replaces positions inside one transaction and must include every current reference once.

Archived concepts reject edits until a steward reopens them.

## API routes

All under `/api/v1/visualizations`.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/` | Create a concept. `201` |
| `GET` | `/` | List concepts the caller can see |
| `GET` | `/:id` | Read one concept and its references |
| `PATCH` | `/:id` | Update title, notes, visibility, method, project, revision, garment, or preview. Rejects `status` and external URL fields |
| `POST` | `/:id/status` | `draft` to `arranged` or `archived`. Reopen goes back to `draft` |
| `POST` | `/:id/references` | Add an authorized original. `201` |
| `PATCH` | `/:id/references/:mediaId` | Edit the reference note |
| `DELETE` | `/:id/references/:mediaId` | Remove the association |
| `POST` | `/:id/references/order` | Reorder with the full media id list |
| `POST` | `/:id/generate` | Returns `capability_unavailable`. Creates no task and no image |

List limits match the rest of the API: `limit` defaults to 20 and stops at 50. `offset` stops at 10000.

## Authorization

| Actor | Private concept | Public concept |
| --- | --- | --- |
| Owning user | Manage | Manage |
| Organization owner or admin | Manage | Manage |
| Active organization member | Edit while open | Edit while open |
| Anyone else | 404 | Read only |
| Signed-out caller | 404 | Read only. Writes return 401 |

Manage includes archive and reopen. A caller who can read a concept but cannot change it receives 403 on a write. Garment, media, and design-project links use the existing read checks. A private record owned by someone else is not attached.

## Database

`sql/migrations/007_visualization.sql` adds `visualization_concepts` and `visualization_references`.

Concept children cascade on concept delete. Media, garment, project, and revision foreign keys are `RESTRICT`, so those records survive and cannot be removed while a concept still points at them. Owner and creator foreign keys are `RESTRICT`.

There is no ORM. SQL is parameterized through the existing pool.

## Frontend

**IMPLEMENTED** at `/visualize`. It signs in through the existing session API, lists concepts from the API, and shows an empty state when the list is empty. A concept shows its preview, reference origin, garment terms, and design project. The page says the preview is not a generated image. Requesting generation shows "Image generation is not configured."

The interactive desk mounts after the first paint so the server HTML and the first client render match. The landing page, hero, and footer video were not changed. `footer video.mp4` remains the film in `lib/landing-assets.ts`.

## AI generation boundary

`fashion.design_visualization` is registered beside the existing fashion capabilities. Its task input may include up to four media ids, a design project id, and a note of at most 500 characters. No adapter declares it, including the test adapter. `operational` stays false. `POST /api/v1/ai/tasks` with this capability returns `capability_unavailable` and stores no task.

`fashion.design_generation` and `fashion.image_variation` remain registered and not configured. This phase does not call them.

## Tests

`npm test`: **36 passed, 0 failed**. That run includes foundation, catalog, media, design, AI, analysis, and `server/test/visualization.test.ts`. No paid call was made.

Covered cases include private visibility, invalid titles, external URL rejection, reference add and duplicate rejection, ordering, thumbnail rejection, removal without deleting media, organization edit versus archive, unauthorized garment and project links, a revision from another project, and generation leaving both the task table and the media table unchanged.

`npm run lint` and `npm run typecheck` passed after the visualization page was added. `npm run build` passed and prerendered `/`, `/analysis`, and `/visualize`.

The page was exercised at `http://localhost:3000/visualize` with the API running and the test provider off. Sign-in, an empty concept list, creation of "Sleeve study", adding `sleeve.png` as an original reference, the caption "Original reference. This is not a generated image.", garment type Agbada, design project "Desk sleeve", the generation message "Image generation is not configured.", and removal of the reference while the image stayed selectable all completed. `/` still showed the hero, and the footer film loaded from `/landing/bop landing page UI/footer video.mp4`.

## Limitations

- Image generation is not implemented.
- A concept cannot be deleted from the API. It can be archived.
- Revisions can be associated. They are not restored onto the design project.
- Reference origin `design_revision` is stored when the caller sends it. The service does not copy revision media automatically.
- Making a concept public does not publish its images.
- Row-level security is still off.
- The landing sign-in dialog still does not call the API.

## Future extension

A reviewed generation adapter can declare `fashion.design_visualization`, accept the existing task input, and store a new media asset whose provenance says it was produced by that provider. Until that asset exists, the preview remains a reference. Try-on, fit, styling, and commerce stay out of scope.
