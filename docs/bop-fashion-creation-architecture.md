# Bop fashion creation architecture

Status of this document: written after `sql/migrations/004_design_projects.sql` was applied to the disposable local PostgreSQL 18 cluster and the design tests passed. Earlier notes live in `docs/bop-core-domain-architecture.md`, `docs/bop-fashion-catalog-architecture.md`, and `docs/bop-media-asset-architecture.md`. The platform audit predates this schema.

Labels:

- **IMPLEMENTED** — present and exercised.
- **PARTIALLY IMPLEMENTED** — a real boundary exists, but only part of the behavior.
- **PLANNED** — reserved, not built.
- **NOT IMPLEMENTED** — intentionally absent.
- **NOT VERIFIED** — not checked in this phase.

Landing-page files were not moved or renamed. The African fashion film still uses the local file `footer video.mp4` through `lib/landing-assets.ts`.

## 1. Design-project domain model

**IMPLEMENTED.** A design project is its own record. It is not a garment, a commercial offer, or an order.

| Field | Role |
| --- | --- |
| `id` | Stable project identifier. It does not depend on the current images. |
| `name` | Required, trimmed, at most 160 characters |
| `description` | Living design notes. Empty is allowed. At most 8000 characters |
| `owner_user_id` or `owner_organization_id` | Exactly one owner |
| `created_by_user_id` | The person who created the project |
| `status` | `draft`, `in_progress`, `ready_for_review`, or `archived` |
| `visibility` | `private` or `public` |
| `created_at`, `updated_at` | Timestamps. Updates refresh `updated_at` |

There is no provider field and no AI job column on this table.

## 2. Project lifecycle

**IMPLEMENTED** on the server. A status change must be one of these moves:

| From | Allowed next status |
| --- | --- |
| `draft` | `in_progress`, `archived` |
| `in_progress` | `ready_for_review`, `archived` |
| `ready_for_review` | `in_progress`, `archived` |
| `archived` | `in_progress` |

`draft` cannot jump to `ready_for_review`. The project update route rejects a `status` field. Status changes use `POST /api/v1/design-projects/:id/status`.

Archiving and reopening require a steward: the owning user, or an organization owner or admin. An archived project cannot be renamed, re-described, linked, or revised until it is reopened.

This is not an approval workflow. Project status is not an AI-processing status.

## 3. Garment relationships

**IMPLEMENTED** as links, not copies. `design_project_garments` points at an existing catalog garment.

Roles are `primary` and `reference`. A project has at most one primary garment. Setting a new primary demotes the previous one to `reference`. The same garment can be linked only once.

The actor must already be able to read that garment. A private garment owned by someone else is rejected and no link is stored. Deleting a project does not delete the garment. Deleting a garment that is still linked is refused by the foreign key.

Fabric, color, pattern, and other garment attributes stay on the catalog garment and its fashion terms. This phase does not add a second attribute table on the project.

## 4. Media relationships

**IMPLEMENTED** as links to existing `media_assets` rows. `design_project_media` roles are `sketch`, `reference`, `fabric`, `inspiration`, and `preview`.

`preview` is a label for a design image. It does not mean the image was generated.

Only an original asset can be linked. A thumbnail is rejected. The actor must already be able to read the asset. Responses do not include storage keys or disk paths. Bytes stay out of PostgreSQL and out of `public/`.

Metadata-only catalog media can be linked. That path still does not prove a file exists on disk.

## 5. Ownership and permissions

**IMPLEMENTED** with the existing owner rule: one user or one organization.

| Actor | Private project | Public project |
| --- | --- | --- |
| Owning user | Manage | Manage |
| Organization owner or admin | Manage | Manage |
| Active organization member | Edit while the project is open | Edit while the project is open |
| Anyone else | No read. The API returns 404 | Read only |
| Signed-out caller | No read | Read only. Writes return 401 |

Manage means archive, reopen, and delete. Edit means update notes and name, change visibility, link garments and media, and save a revision. Membership alone does not grant archive or delete.

Checks run in the domain service. The page does not enforce them.

## 6. Revision and versioning

**PARTIALLY IMPLEMENTED.** Creating a project writes revision 1 in the same transaction. A later `POST /api/v1/design-projects/:id/revisions` appends the next number. The unique key is `(design_project_id, revision_number)`.

A revision stores the project name, description, status, a note, the creator, the time, and the garment and media links that existed at that moment. Older rows are not updated when the project changes. A rename does not rewrite revision 1.

Ordinary updates do not create a revision by themselves. Saving a revision is explicit.

Restoring a project from a revision is **NOT IMPLEMENTED**. History can be read. It is not applied back onto the project.

Concurrent revision inserts can still collide on the unique key. The project row is locked while a revision is written, which serializes writers that use that lock. A crash between two statements is covered by the transaction. A unique-violation message from a raw insert was observed in the test. The HTTP path does not add a second translator for that database error beyond the existing error handler.

## 7. API endpoints

**IMPLEMENTED** under `/api/v1/design-projects`.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/` | Create a project and revision 1. `201` |
| `GET` | `/` | List projects the caller can see. `limit` defaults to 20 and stops at 50. `offset` stops at 10000. Optional `status` |
| `GET` | `/:id` | Read one project |
| `PATCH` | `/:id` | Change name, description, or visibility. Rejects `status` |
| `DELETE` | `/:id` | Steward delete. `204`. Cascades revisions and links |
| `POST` | `/:id/status` | Validated status change |
| `POST` | `/:id/garments` | Link a readable catalog garment |
| `DELETE` | `/:id/garments/:garmentId` | Remove that link |
| `POST` | `/:id/media` | Link a readable original media asset |
| `DELETE` | `/:id/media/:mediaId` | Remove that link |
| `POST` | `/:id/revisions` | Append a snapshot. Optional `note` |
| `GET` | `/:id/revisions` | Newest revision first, with the same page limits |

Unknown ids and private projects the caller cannot see return 404. A caller who can see a project but cannot change it receives 403. Invalid transitions return 400. Responses use `{ project }` or `{ revision }` and do not include raw database errors.

Catalog and media upload routes were not duplicated.

## 8. Database migrations

**IMPLEMENTED.** New file: `sql/migrations/004_design_projects.sql`.

Tables: `design_projects`, `design_project_garments`, `design_project_media`, `design_revisions`, `design_revision_garments`, `design_revision_media`.

`001_core_foundation.sql`, `002_fashion_catalog.sql`, and `003_media_files.sql` were not rewritten. The disposable cluster recorded all four files in `schema_migrations`. Applying migrations again is unchanged, covered by the existing migration test.

Deletion: project children cascade. Garment and media foreign keys from the link tables are `RESTRICT`, so those records survive a project delete and cannot be removed while a link remains. Owner and creator foreign keys are `RESTRICT`.

## 9. Frontend functionality

**NOT IMPLEMENTED.** The site still has the public landing page and a sign-in dialog that does not call the API. There is no authenticated application shell, so this phase did not add a design workspace screen.

The landing page was not redesigned. `public/landing/bop landing page UI/footer video.mp4` remains the film referenced by `africanFashionFilm`.

## 10. Tests and results

**IMPLEMENTED** in `server/test/design.test.ts`, using the existing `node:test` runner. Fixtures use `@design.test` addresses and `design-test-` organization slugs and are removed afterward.

Executed with `DATABASE_URL=postgres://bop@127.0.0.1:5433/bop`:

- `npm test`: 24 passed, 0 failed. That run includes the foundation, catalog, media, and design files.
- Design coverage that passed: create with revision 1; private read returns 404; public anonymous read; anonymous write returns 401; status cannot be patched; invalid `draft` to `ready_for_review` leaves the project in `draft`; a member can edit and cannot archive or delete; an owner can archive and reopen; an archived project rejects edits; garment and media links; a private foreign garment or media asset is not linked; a thumbnail is rejected; revision 2 keeps the later name and links while revision 1 keeps the earlier name; duplicate revision number 2 violates `design_revisions_number_unique`; revision history is paged; steward delete returns 204 and a later read returns 404.
- `npm run lint`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0. The home route was prerendered. The first production build in this phase failed typecheck on the design test and was rerun after that test was narrowed. The rerun succeeded.
- After the tests: `schema_migrations` contained `001` through `004`; `users`, `garments`, `media_assets`, and `design_projects` were 0; `fashion_terms` stayed 43.

Browser verification of the landing page was **NOT VERIFIED** in this phase because no landing file changed.

A failed revision insert inside an HTTP transaction, and recovery of files after a crash between disk and database, were **NOT VERIFIED**.

## 11. Future AI integration boundaries

**NOT IMPLEMENTED.** This phase does not call an image model, return a fake preview, or store a provider name on the project.

A later job can point at `design_projects.id`, a revision id, a garment id, and a media id. Those identifiers already exist. Reference boards that point at those records are described in `docs/bop-fashion-visualization-architecture.md`. Generated images, try-on, fit, and styling are out of scope.

## 12. Known limitations

- There is no design workspace UI.
- Notes are the project description. There is no separate note thread.
- Fabric, color, and pattern selections are not project-owned rows. They remain catalog terms on a linked garment, or a media role such as `fabric`.
- Revisions are not restored.
- Updates do not create revisions automatically.
- `preview` does not create an image.
- Public visibility is not a product listing.
- Row-level security is still off. Authorization is in the application, on one database role.
- The landing sign-in dialog still does not create a session.
