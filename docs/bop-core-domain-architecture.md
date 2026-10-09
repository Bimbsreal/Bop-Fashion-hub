# Bop core domain architecture

Status of this document: written after the core foundation migration was applied to a disposable local PostgreSQL 18 cluster and the foundation tests passed. Labels mean:

- **IMPLEMENTED** — present in this repository and exercised, or present as schema that the migration applied.
- **PLANNED** — a boundary is reserved, but the behavior is not built.
- **NOT IMPLEMENTED** — intentionally absent.
- **NOT VERIFIED** — not checked in this phase.

The public landing page is unchanged. The African fashion film still uses the local file `footer video.mp4`.

The fashion catalog phase extended this foundation. Current garment, taxonomy, measurement, visibility, and catalog API behavior is in `docs/bop-fashion-catalog-architecture.md`. Media uploads are in `docs/bop-media-asset-architecture.md`. Design projects are in `docs/bop-fashion-creation-architecture.md`. AI task orchestration is in `docs/bop-ai-orchestration-architecture.md`. Garment image analysis is in `docs/bop-fashion-image-analysis-architecture.md`. Reference-based visualization is in `docs/bop-fashion-visualization-architecture.md`. Virtual try-on is in `docs/bop-virtual-try-on-architecture.md`. Body measurement profiles are in `docs/bop-body-measurement-architecture.md`. Dimensional fit comparison is in `docs/bop-fit-analysis-architecture.md`. Personal styling is in `docs/bop-personal-styling-architecture.md`. Where this document still says those pieces are absent, the later document is the record.

## 1. Verified domain boundaries

The application is a modular monolith. The Next.js app serves the landing page. The Express process in `server/` is the only API. Domain functions in `server/src/modules/` own business rules and talk to PostgreSQL with parameterized SQL. There is no ORM and no separate service per domain.

| Boundary | Status | Where it lives |
| --- | --- | --- |
| Identity | IMPLEMENTED | `users`, `user_profiles`, `server/src/modules/identity.ts` |
| Organizations | IMPLEMENTED | `organizations`, `organization_memberships`, `server/src/modules/organizations.ts` |
| Fashion catalog foundation | IMPLEMENTED | `fashion_terms`, `garments`, `garment_terms`, `server/src/modules/fashion.ts` |
| Media metadata | IMPLEMENTED | `media_assets`, `garment_media`, `server/src/modules/media.ts` |
| Authorization | IMPLEMENTED in domain functions | `server/src/modules/access.ts` |
| Authentication | NOT IMPLEMENTED | No passwords, sessions, or auth middleware |
| Fashion professional profile beyond organization membership | NOT IMPLEMENTED | See section 3 |
| Body measurement profiles | IMPLEMENTED | See `docs/bop-body-measurement-architecture.md` |
| Dimensional fit comparison | IMPLEMENTED | See `docs/bop-fit-analysis-architecture.md`. Ease classification and fit prediction remain absent |
| Personal styling | IMPLEMENTED as catalog-tag assembly | See `docs/bop-personal-styling-architecture.md`. Learned styling remains absent |
| Commercial listings and orders | IMPLEMENTED as business offers and customer requests | See `docs/bop-fashion-commerce-architecture.md` and `docs/bop-order-management-architecture.md`. Inventory counts remain absent. Simulated payment records are in `docs/bop-payment-integration-architecture.md`. Live payments remain absent |

## 2. User and profile relationships

**IMPLEMENTED.** `users` is the account: email, display name, and status (`active` or `disabled`). Email is stored lowercase and must match a simple shape check. There is no password column.

`user_profiles` is one row per user (`user_id` is the primary key) and holds optional given and family names. Deleting a user deletes the profile (`ON DELETE CASCADE`).

One person has one account. That account can own resources directly and can belong to organizations. The landing-page sign-in dialog still collects nothing and does not call the API.

## 3. Organization and membership model

**IMPLEMENTED.** An organization has a name, unique slug, kind, and status. Kind is `studio`, `tailor`, `brand`, or `retailer`. Status is `active` or `archived`.

Membership is many-to-many. The primary key is `(organization_id, user_id)`. Role is `owner`, `admin`, or `member`. Status is `active`, `invited`, or `removed`. Creating an organization inserts an active owner membership for the creating user. `addMember` only inserts `admin` or `member`, and only when the actor is an active owner or admin of that organization.

A user can own or join more than one organization. An organization can have more than one user.

**Outstanding decision.** A freelance designer or tailor is represented by an organization they own, not by a second user account and not by a separate professional-profile table. Individual fashion preferences are **PLANNED** and have no table yet, because no preference fields are required in this phase.

## 4. Resource ownership strategy

**IMPLEMENTED** for garments and media assets. Exactly one owner is required:

- `owner_user_id` set and `owner_organization_id` null, or
- `owner_organization_id` set and `owner_user_id` null.

The check constraints are `garments_one_owner` and `media_assets_one_owner`. Both foreign keys use `ON DELETE RESTRICT`, so an owner cannot be removed while garments or media still point at them. Memberships and profiles use `ON DELETE CASCADE` because they cannot outlive the user or organization.

`assertCanActForOwner` allows the owning user to act on a personal resource. It allows any active member to act on an organization resource. Non-members are rejected. This is server-side. The frontend is not an authorization boundary.

There is no generic ownership table. Ownership columns exist only on resources that have an owner.

## 5. Fashion domain model

**IMPLEMENTED** as a design record, not a product listing.

`garments` stores id, the single owner, name, description, optional `garment_type_id`, and timestamps.

`fashion_terms` stores a controlled vocabulary. `kind` is one of `garment_type`, `material`, `pattern`, `style`, `category`, or `tradition`. Uniqueness is `(kind, slug)`, so the same slug may later exist in two kinds. Names and slugs are required. Slugs are lowercase tokens.

`garment_terms` links a garment to many terms. A garment type is not just another unlabeled tag: `garment_type_id` must reference a term whose kind is `garment_type`. The trigger `enforce_garment_type_kind` rejects any other kind. `setGarmentType` only selects `garment_type` terms.

`createGarment` accepts term slugs only when each slug matches exactly one term. If a slug is later reused across kinds, that call fails until the caller can name the kind. That disambiguation is **PLANNED**.

Colors and sizes are **NOT IMPLEMENTED** as their own tables. They can be added later as term kinds or as structured size rows when a real size system is specified. Putting them in now would invent a size model the product does not have yet.

## 6. African fashion classification

**IMPLEMENTED** as first-class terms, not a miscellaneous bucket. Seeded rows, applied by the migration:

| Kind | Terms |
| --- | --- |
| material | Ankara, Aso Oke, Adire, Lace, George, Kente |
| garment_type | Agbada |
| style | Contemporary African fashion |
| category | Traditional, Contemporary, Streetwear, Formalwear, Footwear, Accessories, Occasions |

These concepts stay distinct. Ankara is a material. Agbada is a garment type. Contemporary African fashion is a style. A garment may reference several of them through `garment_terms`, and its type through `garment_type_id`.

New terms can be inserted later without a schema change. The seed does not claim historical origin, region, or technique beyond the names themselves. `tradition` exists as a kind so a future term can be recorded separately from material and style. No tradition rows are seeded.

## 7. Media metadata and storage strategy

**IMPLEMENTED** as metadata, with local file storage added later. `media_assets` stores id, the single owner, media type (`image`, `video`, `other`), MIME type, byte size, unique storage key, optional pixel dimensions, status (`pending`, `ready`, `failed`), and timestamps. There is no `bytea` column. The current upload, thumbnail, and access behavior is in `docs/bop-media-asset-architecture.md`.

`garment_media` links a garment and a media row with role `primary`, `reference`, or `generated`. `linkGarmentMedia` requires the same owner on both rows and requires the actor to be allowed to act for that owner.

**PLANNED:** object storage behind `storage_key`. No provider is configured. Landing-page images and `footer video.mp4` stay in `public/landing/` and are not media-asset rows.

Access in this phase is ownership, not a separate permission list. A permission table is **PLANNED** if private sharing is required later. Body photographs and measurements are **NOT IMPLEMENTED** and must not be added to this media table without a separate access review.

## 8. API and business logic boundaries

**IMPLEMENTED** HTTP surface:

- `GET /api/v1/health` — runs `SELECT 1`. Returns 503 when `DATABASE_URL` is missing or the database is unreachable. The response does not include driver errors.

The process listens on `127.0.0.1`. JSON bodies are limited to 100kb. Unknown routes return JSON 404. `DomainError` becomes 403 for `forbidden` and 400 otherwise. Any other error becomes a generic 500.

Routes do not contain catalog or membership rules. Those live in `server/src/modules/`. Database access is `pg` `Pool` plus explicit transactions in the migration runner and in tests.

Mutating HTTP endpoints are **NOT IMPLEMENTED**. Domain functions are ready for a later authenticated API. Exposing them before authentication would make ownership checks depend on a client-supplied user id.

## 9. Database constraints and indexes

Migration: `sql/migrations/001_core_foundation.sql`. The runner creates `schema_migrations (id, applied_at)` and applies each new `.sql` file in its own transaction. Applied files are skipped. The system PostgreSQL service on port 5432 was not modified.

Constraints in the migration:

- Primary keys on every table. Membership and link tables use composite primary keys.
- Foreign keys as described above, with `RESTRICT` or `CASCADE` chosen per relationship.
- Unique email, unique organization slug, unique `(kind, slug)` on terms, unique `storage_key`.
- Check constraints for email shape, slugs, names, statuses, roles, kinds, the single-owner rule, non-negative byte size, and positive dimensions when present.
- `set_updated_at` triggers on users, profiles, organizations, memberships, garments, and media assets.
- `enforce_garment_type_kind` before insert or update of `garment_type_id`.

Indexes:

- `organization_memberships_user_active_idx` on `user_id` where `status = 'active'`.
- `garments_owner_user_idx`, `garments_owner_organization_idx`.
- `garment_terms_term_idx`.
- `media_assets_owner_user_idx`, `media_assets_owner_organization_idx`.

Primary keys and unique constraints already index their columns, so those indexes are not repeated.

Row Level Security is **PLANNED** and is not enabled. The pool uses one database role. There is no transaction-scoped user or organization setting yet. Enabling RLS on that pool would either block the application or trust a session variable the request path does not set. When sessions exist, the safe approach is to set a transaction-local user id at the start of each request transaction and write policies against that setting. Until then, `assertCanActForOwner` is the enforcement point.

## 10. Authorization approach

**IMPLEMENTED** in the domain layer only.

- Personal garment or media: only that user.
- Organization garment or media: any active member.
- Adding a member: active owner or admin of that organization. This function cannot create a second owner.
- Cross-organization access is denied.
- No frontend check is treated as authority.

**NOT IMPLEMENTED:** login, sessions, password hashes, role-to-permission matrices finer than owner/admin/member, and HTTP authorization middleware. Invited and removed memberships do not grant access, because queries require `status = 'active'`.

## 11. Implemented migrations

| File | Status |
| --- | --- |
| `sql/migrations/001_core_foundation.sql` | IMPLEMENTED and applied on the disposable local cluster |

The runner is `npm run db:migrate` (`server/src/db/migrate.ts`). Running it again reports that migrations are already applied. Tests call the same function and then roll their rows back, so seed terms remain and test users do not.

Verification used a new cluster created with PostgreSQL 18 `initdb` at `.local/pgdata` (gitignored), user `bop`, trust authentication, port 5433, listening on `127.0.0.1` only. `DATABASE_URL` for that run was `postgres://bop@127.0.0.1:5433/bop`. No password was stored in the repository. The system cluster on port 5432 was not changed. The disposable cluster is stopped after verification.

## 12. Tests added

**IMPLEMENTED:** `server/test/foundation.test.ts`, run with `npm test` (`node:test` via `tsx`). Each domain test uses a transaction that is rolled back.

Covered:

- User plus profile row, and one user in two organizations.
- A non-member cannot act for another organization, cannot add themselves, and cannot create a garment there.
- A garment has one owner, can reference Ankara, Agbada, and contemporary African fashion, and rejects two owners.
- A material term cannot be stored as `garment_type_id`.
- Media metadata has no `bytea` column, rejects a `..` storage key, rejects an outsider, and can be linked to a garment with the same owner.
- A second migration applies nothing.
- `GET /api/v1/health` returns ok when this database is up.

Results from the verification run are in the phase report. Do not treat an earlier failed health-check close as a product defect; the assertion was fixed and the suite was re-run.

## 13. Outstanding architectural decisions

- **Authentication.** **PLANNED.** The next phase should add local sessions on top of `users` and memberships before any mutating HTTP API. Passwords are **NOT IMPLEMENTED**.
- **Row Level Security.** **PLANNED** after request transactions can set the acting user. Not enabled now.
- **Term slugs shared by two kinds.** **PLANNED** to require kind plus slug in the garment API if that collision appears.
- **Colors, sizes, and individual preferences.** **NOT IMPLEMENTED** until a concrete model is specified.
- **Object storage and media bytes.** **PLANNED.** Metadata only today.
- **Commerce.** **PLANNED** as a separate offer/order model. A garment must not become the sales listing by adding price columns to `garments`.
- **Intelligence features** (measurement, fit, try-on, styling, AI creation). **NOT IMPLEMENTED.**
- **Connection to the existing Windows PostgreSQL service.** **NOT VERIFIED** for application use. Passwordless login to port 5432 is rejected, and that service's authentication was left unchanged.
