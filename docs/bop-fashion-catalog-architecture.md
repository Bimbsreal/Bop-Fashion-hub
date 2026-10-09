# Bop fashion catalog architecture

Status of this document: written after `sql/migrations/002_fashion_catalog.sql` was applied to the disposable local PostgreSQL 18 cluster and the catalog tests passed. The platform audit in `docs/bop-platform-foundation-audit.md` describes an earlier tree and is not the current schema. The core model reused here is the one in `docs/bop-core-domain-architecture.md`.

Labels:

- **IMPLEMENTED** — present and exercised.
- **PARTIALLY IMPLEMENTED** — a real boundary exists, but only part of the product behavior.
- **PLANNED** — reserved, not built.
- **NOT IMPLEMENTED** — intentionally absent.
- **NOT VERIFIED** — not checked in this phase.

The public landing page was not changed. The African fashion film still uses the local file `footer video.mp4`.

## 1. Existing catalog structures reused

**IMPLEMENTED.** No second garment, product, or media table was added.

Reused from the core foundation:

- `users` and `user_profiles` for the person.
- `organizations` and `organization_memberships` for studios, tailors, brands, and retailers.
- `garments` as the design record, with the single-owner check.
- `fashion_terms` and `garment_terms` for controlled vocabulary.
- `media_assets` and `garment_media` for metadata and garment links.
- Domain modules `fashion.ts`, `media.ts`, `access.ts`, and `identity.ts`.
- Migration runner `schema_migrations`. `001_core_foundation.sql` was not rewritten.

There was no product, listing, designer-profile, or size table to extend. Those concepts were either added beside the garment or left for later.

## 2. Garment domain model

**IMPLEMENTED.** A garment is a design, not a listing. `garments` still has one owner: a user or an organization, never both.

Columns used by the catalog:

- `id`, `name`, `description`
- `garment_type_id` — one term whose kind is `garment_type`
- `owner_user_id` or `owner_organization_id`
- `created_by_user_id` — the person who created it, including when an organization owns it
- `visibility` — `private` or `public`
- `created_at`, `updated_at`

`created_by_user_id` is nullable only so older rows can be migrated. New catalog writes set it to the acting user. Ownership transfer is **NOT IMPLEMENTED**.

Other descriptive links live in `garment_terms`, not in extra columns on `garments`. The catalog API replaces those links by kind and slug, so a slug that exists in two kinds is not ambiguous. The older `termSlugs` helper still rejects an ambiguous slug.

## 3. Category taxonomy

**IMPLEMENTED** as flat, database-backed terms. Kind `category` is for discovery. Seeded categories from the foundation remain: Traditional, Contemporary, Streetwear, Formalwear, Footwear, Accessories, Occasions.

A garment may have several categories. Hierarchical categories are **NOT IMPLEMENTED**. A parent pointer was not added, because no browse tree has been specified. Multiple labels already let a garment sit in more than one place.

Categories are not styles. `contemporary` can exist as both a category and a style because uniqueness is `(kind, slug)`.

## 4. Fabric and material model

**IMPLEMENTED** as `fashion_terms` of kind `material`, linked through `garment_terms`. Materials are not garment types.

Seeded materials:

- From the foundation: Ankara, Aso Oke, Adire, Lace, George, Kente
- Added for the catalog: Denim, Cotton, Linen, Silk

Ankara stays a material. The name does not claim that every Ankara cloth is one print, and it does not assign the cloth to one country. Adire remains the existing term `Adire`, not a second “Adire fabric” row.

## 5. Pattern model

**IMPLEMENTED** as kind `pattern`. A pattern is not a material. Seeded patterns: Floral, Geometric, Striped, Plain, Abstract. A garment may have more than one pattern term. No rule forces a material to own a single pattern.

## 6. Style model

**IMPLEMENTED** as kind `style`. A garment may have several styles. Seeded styles: Contemporary African fashion (foundation), Contemporary, Traditional, Streetwear, Formal, Casual, Minimalist.

Agbada stays a `garment_type`. It is not also stored as a style, and it is not assigned to one country. Kente remains a material and now also has a separate `tradition` term with the same name. That second row records the textile tradition without replacing the material and without a regional claim.

Kind `tradition` is available for later terms. Only Kente is seeded there.

## 7. Size and measurement boundaries

**PARTIALLY IMPLEMENTED.** These concepts are separate:

| Concept | Status | Where |
| --- | --- | --- |
| Size system and label | IMPLEMENTED | `size_systems`, `size_labels`, `garment_size_labels` |
| Garment measurement definition and stated value | IMPLEMENTED | `measurement_definitions`, `garment_measurements` |
| Fit preference vocabulary | PARTIALLY IMPLEMENTED | Term kind `fit_preference` is allowed. No rows are seeded. |
| Body measurements | IMPLEMENTED separately | `docs/bop-body-measurement-architecture.md`. Not the same rows as garment dimensions |
| Fit analysis | IMPLEMENTED as dimensional comparison | `docs/bop-fit-analysis-architecture.md`. No brand size chart and no ease allowance |
| Personal styling | IMPLEMENTED separately | `docs/bop-personal-styling-architecture.md`. Reads existing terms. Does not add prices or occasion rows |

Letter labels XS, S, M, L, and XL belong to the `letter` size system. They do not store dimensions. Garment measurements use definitions `chest`, `waist`, `hip`, and `garment-length`, each in centimetres. Later definitions `garment-shoulder`, `garment-sleeve`, `garment-inseam`, and `garment-hem` are also garment dimensions. The unit lives on the definition. A value may be tied to one of the garment’s size labels. Two garments labeled M can store different chest values. Provenance is only `stated`. An entered inch or metre value is converted into centimetres and the original entry is kept. Nothing is inferred from photographs. The catalog does not calculate fit.

Attribute kinds that share `fashion_terms` instead of their own tables: `color`, `silhouette`, `sleeve`, `neckline`, `length`, `closure`, `occasion`, `season`, and `fit_preference`. Colors Black, White, Ivory, Indigo, and Gold are seeded. The other attribute kinds are empty until a real vocabulary is needed. One vocabulary table is enough: each value is validated by kind, can be queried, and does not need a JSON blob or a table per attribute.

## 8. Designer and tailor relationships

**PARTIALLY IMPLEMENTED.** A person still has one account. Creating a garment for an organization requires an active membership. `created_by_user_id` records that person. The organization remains the owner when `organizationId` is sent. A tailor or designer does not need a second account. Organization kind `tailor`, `studio`, `brand`, or `retailer` is unchanged.

Separate designer and tailor profile tables, dashboards, and collaborator grants are **NOT IMPLEMENTED**.

## 9. Media associations

**IMPLEMENTED** on the existing metadata tables. File bytes and the upload workflow are described in `docs/bop-media-asset-architecture.md`. Landing assets are not catalog rows.

`garment_media.role` now allows `primary`, `front`, `back`, `side`, `detail`, `fabric`, `sketch`, `construction`, `reference`, and `generated`. A garment does not need every role. Linking still requires the same owner on the garment and the media, and the actor must be allowed to edit that owner. Editors receive `storageKey`. Public readers do not.

## 10. Ownership and visibility rules

**IMPLEMENTED** on the server.

- `private`: only the owning user, or an active member of the owning organization, can read or change it. Other callers get 404, including anonymous callers.
- `public`: anyone can read it. Only an editor can change it. A failed edit is also 404, so a private id is not confirmed to a stranger.
- Public responses omit `storageKey`.
- Catalog list and get use the same rule. Filters cannot reveal private rows to the wrong caller.
- Setting `visibility` to `public` is the publication action. It does not create a commercial offer.

Shared collaborator lists are **PLANNED**. Row Level Security is still **NOT IMPLEMENTED**. The pool has one database role, so policies would not have a per-request user unless every catalog query ran inside a transaction that set that user. Authorization stays in the domain layer.

## 11. Implemented APIs

**IMPLEMENTED** under `http://127.0.0.1:5000/api/v1`.

Local session, **PARTIALLY IMPLEMENTED**. It exists so catalog writes have an actor. It is not a full account product. The landing-page sign-in dialog is still a placeholder. There is no password reset, email verification, or session rotation beyond a 7-day httpOnly cookie.

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`

Passwords are hashed with scrypt. Only the hash is stored. The session cookie holds a random token. The database stores the SHA-256 of that token. Disabled users and unknown passwords fail with the same message.

Catalog:

- `POST /api/v1/catalog/garments` — create. Requires a session. Owner is the caller, or an organization the caller belongs to.
- `GET /api/v1/catalog/garments` — list accessible garments. Filters: `type`, `category`, `material`, `pattern`, `style`, `color`, `visibility`. `limit` defaults to 20 and maxes at 50. `offset` maxes at 10000.
- `GET /api/v1/catalog/garments/:id`
- `PATCH /api/v1/catalog/garments/:id` — name, description, visibility, terms, and size labels.
- `POST /api/v1/catalog/garments/:id/media`
- `POST /api/v1/catalog/garments/:id/measurements`

`GET /api/v1/health` is unchanged. Unknown routes return JSON 404. Domain errors use 401, 403, 404, or 400. Other errors return a generic 500. Database errors are not sent to the client.

## 12. Database migrations

| File | Status |
| --- | --- |
| `sql/migrations/001_core_foundation.sql` | Already applied. Not rewritten. |
| `sql/migrations/002_fashion_catalog.sql` | IMPLEMENTED and applied on the disposable cluster |

`002` adds `users.password_hash`, `sessions`, garment visibility and creator, the wider term-kind and media-role checks, size tables, measurement tables, the public-garment index, the garment-type index, and the seed rows above. It does not drop tables or delete existing term rows.

The runner takes a PostgreSQL advisory lock so two local migrators cannot apply the same file together. Verification used the gitignored cluster on `127.0.0.1:5433`. The system cluster on port 5432 was not changed.

## 13. Tests added

**IMPLEMENTED.**

- `server/test/foundation.test.ts` — previous identity, organization, garment, media, migration, and health checks.
- `server/test/catalog.test.ts` — Kente and Agbada kinds, private access, public reads without storage keys, organization isolation, material filter, pagination, distinct measurements for the same size label, duplicate measurement rejection, and rejection of Ankara used as a garment type.

Both files run through `npm test`. The verification run for this phase passed 13 tests. An earlier filter assertion expected two different pages to differ from a material-filtered row that was allowed to be the second page. That assertion was corrected and the suite was re-run.

## 14. Future AI integration points

**NOT IMPLEMENTED.** No provider fields were added to `garments`. No AI API is called. A later visualization, try-on, fit, styling, or extraction job should reference `garments.id`, `media_assets.id`, and `fashion_terms.id` rather than copying fashion meaning into a provider payload.

Structured filters use ordinary PostgreSQL indexes and joins. Semantic search, vector search, and visual search are **PLANNED** and are not required for the filters above.

## 15. Outstanding limitations

- Commercial listings are separate from catalog garments. See `docs/bop-fashion-commerce-architecture.md`. Prices are not stored on garments. Inventory counts and orders remain absent. Public catalog visibility is not a sales listing.
- Body measurements are recorded in `docs/bop-body-measurement-architecture.md`. Photo inference and fit calculation are **NOT IMPLEMENTED**.
- Collaborator sharing, hierarchical categories, and ownership transfer are **NOT IMPLEMENTED**.
- Attribute kinds other than color have no seeded vocabulary.
- Object storage is **PLANNED**. `storage_key` is still only a string.
- Landing sign-in does not call the API.
- Authentication is only the local catalog session. Rate limiting and CSRF tokens beyond `SameSite=Lax` are **NOT IMPLEMENTED**.
- Row Level Security is **NOT IMPLEMENTED**.
- Virtual try-on, generated imagery, styling recommendations, and payments are **NOT IMPLEMENTED**.
