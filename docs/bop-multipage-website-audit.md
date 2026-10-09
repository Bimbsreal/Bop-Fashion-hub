# Bop multi-page website audit

Audit date: 2026-10-09. Local repository only. Classifications: PASS, PARTIAL, FAIL, NOT IMPLEMENTED, NOT VERIFIED, BLOCKED BY DEPENDENCY.

A route existing is not treated as a working feature. Statuses below come from reading the App Router pages, desk components, Express routes, migrations `001` through `014`, and the existing architecture notes.

## 1. Existing frontend routes

Next.js 16.4 App Router. No Pages Router.

| Route | Status | What the page actually does |
| --- | --- | --- |
| `/` | PASS | Approved public landing page. Headline, journey, and local assets are present. The header account dialog does not create a session. |
| `/account` | PARTIAL | Register, sign-in, sign-out, and `GET /api/v1/auth/session`. No profile editor, password change, or password recovery. |
| `/catalog` | PARTIAL | Lists visible garments and can create a garment when a session exists. No garment detail route, search, sort, or pagination controls. |
| `/design` | PARTIAL | Lists the signed-in user's projects and can create one. No project detail, revision editor, or reference-media attachment on this page. |
| `/analysis` | PARTIAL | Functional desk for simulated image analysis. Page-local sign-in. |
| `/visualize` | PARTIAL | Arranges stored images, garments, and projects. Does not generate an image. Page-local sign-in. |
| `/try-on` | PARTIAL | Records a consented try-on request. Does not produce a try-on image. Page-local sign-in. |
| `/measure` | PARTIAL | Saves body measurements. Does not estimate them from a photo. Page-local sign-in. |
| `/fit` | PARTIAL | Compares stored measurements with garment dimensions. No ease classification and no fit guarantee. Page-local sign-in. |
| `/style` | PARTIAL | Assembles outfits from catalog tags. Page-local sign-in. |
| `/commerce` | PARTIAL | Business profiles and listings. Page-local sign-in. |
| `/orders` | PARTIAL | Order lifecycle plus a simulated payment when `PAYMENT_SIMULATION=1`. Page-local sign-in. The order JSON keeps `paid` false. |

## 2. Existing shared layouts

| Finding | Status |
| --- | --- |
| Root `app/layout.tsx` sets the document, fonts, and global CSS. | PASS |
| Public landing uses its own header, sections, and footer. | PASS |
| `WorkspaceShell` and `WorkspaceNav` wrap the eleven workspace routes. | PASS |
| Separate auth, commerce, and admin layouts. | NOT IMPLEMENTED |

## 3. Existing reusable components

Landing sections live under `components/landing/`. Each intelligence desk is its own client component. New shared pieces are `WorkspaceNav`, `WorkspaceShell`, `AccountDesk`, `CatalogDesk`, and `DesignDesk`, plus `lib/account-form.ts`, `lib/catalog-form.ts`, and `lib/workspace-routes.ts`.

| Finding | Status |
| --- | --- |
| Landing components reused for the public page. | PASS |
| Shared workspace navigation. | PASS |
| Shared form fields, empty-state, error-state, dialog, and pagination components. | NOT IMPLEMENTED |
| Each older desk still contains its own sign-in form. | PARTIAL |

## 4. Existing authentication implementation

| Finding | Status |
| --- | --- |
| `POST /api/v1/auth/register`, `/login`, and `/logout` with an HttpOnly `bop_session` cookie. | PASS |
| `GET /api/v1/auth/session` returns the active user id, email, and display name. | PASS |
| Protected API routes use `requireUser` independently of the page. | PASS |
| `/account`, `/catalog`, and `/design` read the cookie session. | PASS |
| Older desks keep a React `signedIn` flag that resets when the page loads, even if the cookie is still valid. | PARTIAL |
| Landing header dialog creates a session. | FAIL |
| Password recovery and password reset. | NOT IMPLEMENTED |
| Server-side route guards that redirect before render. | NOT IMPLEMENTED |
| Open-redirect handling. There is no return-to query. | NOT IMPLEMENTED |

## 5. Existing functional user journeys

| Journey | Status |
| --- | --- |
| Read the public landing page and move through its in-page sections. | PASS |
| Create an account on `/account`, keep that session on `/catalog` and `/design`, and sign out. | PASS |
| Create and list a garment, then create and list a design project, for the signed-in user. | PASS |
| Analysis, visualization, try-on draft, measurements, fit comparison, styling, commerce, orders, and simulated payment. | PARTIAL |
| One sign-in that unlocks every older desk without signing in again on that page. | FAIL |
| Public browse of a garment detail, designer profile, or category page. | NOT IMPLEMENTED |

## 6. Backend capabilities that pages can use

Available local APIs, all under `/api/v1`:

- Auth: register, login, logout, session.
- Catalog garments and fashion terms.
- Media upload and private file access.
- Design projects and revisions.
- AI task records. No live provider is configured.
- Analyses. Simulated attributes.
- Visualizations from stored references.
- Try-on requests. Draft only.
- Body measurements.
- Fit comparisons. `easeApplied` and `fitGuarantee` stay false.
- Style sessions from catalog tags. Occasion terms are not seeded.
- Commerce listings and organization profiles.
- Orders and quotations.
- Payments. Development simulation only, and only when `PAYMENT_SIMULATION=1` and `NODE_ENV` is not `production`. `realMoney` stays false.

## 7. Pages that exist but are incomplete

| Page | Status | Gap |
| --- | --- | --- |
| `/account` | PARTIAL | No settings, preferences, or password recovery. |
| `/catalog` | PARTIAL | List and create only. Measurements are withheld from the list. |
| `/design` | PARTIAL | List and create only. |
| `/analysis` through `/orders` | PARTIAL | Working desks, disconnected sign-in state. |

## 8. Pages that exist only as visual mockups

| Finding | Status |
| --- | --- |
| Landing page is an approved visual page. Its account dialog is a visual control. | PARTIAL |
| Workspace desks call real local APIs. They are not static mockups. | PASS |
| Try-on, analysis, visualization, and payment results that would require an external engine are labeled as drafts or simulations. | PASS |

## 9. Missing pages and navigation paths

| Proposed area | Status |
| --- | --- |
| About, category marketing pages, public designer profiles, garment detail. | NOT IMPLEMENTED |
| Password recovery and reset. | NOT IMPLEMENTED |
| Profile editor, preferences, saved-outfit library as its own page. | NOT IMPLEMENTED |
| Design detail, revision history page, reference board. | NOT IMPLEMENTED |
| Marketplace storefront separate from `/commerce`. | NOT IMPLEMENTED |
| Checkout page separate from the order desk. | NOT IMPLEMENTED |
| Admin user, catalog, and moderation workspace. | NOT IMPLEMENTED |

These were not added as empty pages.

## 10. Missing API integrations

| Gap | Status |
| --- | --- |
| Older desks do not call `GET /api/v1/auth/session` on load. | FAIL |
| No password-reset API. | NOT IMPLEMENTED |
| No admin API. | NOT IMPLEMENTED |
| No live payment-provider API. | BLOCKED BY DEPENDENCY |
| No live image-generation or try-on provider. | BLOCKED BY DEPENDENCY |

## 11. Responsive-design findings

| Finding | Status |
| --- | --- |
| Landing responsive behavior from the approved page. | PASS |
| Workspace nav scrolls horizontally on a narrow screen. | PARTIAL |
| Older desks use simple stacked forms. Dense order and commerce tables can overflow. | NOT VERIFIED |
| Tablet and desktop pass of the new account, catalog, and design pages in this change. | NOT VERIFIED |

## 12. Accessibility findings

| Finding | Status |
| --- | --- |
| Workspace nav uses a `nav` label, real links, and `aria-current`. | PASS |
| Account, catalog, and design forms use associated labels and `type="button"` where a button is not a submit. | PASS |
| Landing dialog remains a native dialog. | PASS |
| Focus management across the new nav and color contrast of `text-muted` on ivory. | NOT VERIFIED |
| Older desks were not re-audited control by control. | NOT VERIFIED |

## 13. Existing test coverage

Node's test runner via `npm test`. Coverage already includes foundation, catalog, media, design, AI records, analysis, visualization, try-on, measurements, fit, style, commerce, orders, and simulated payments.

| Finding | Status |
| --- | --- |
| HTTP session read and logout. | PASS |
| Account, garment, and design form drafts, plus the workspace route list. | PASS |
| Browser or end-to-end coverage of every workspace route. | NOT IMPLEMENTED |

## 14. Features blocked because an engine is unavailable

| Feature | Status |
| --- | --- |
| Genuine image analysis. | BLOCKED BY DEPENDENCY |
| Generated garment visualization. | BLOCKED BY DEPENDENCY |
| Generated virtual try-on. | BLOCKED BY DEPENDENCY |
| Photo-based measurement. | BLOCKED BY DEPENDENCY |
| Ease-based fit classification. | BLOCKED BY DEPENDENCY |
| Taste judgment or generated worn outfits. | BLOCKED BY DEPENDENCY |
| Card charges and provider-confirmed payment. | BLOCKED BY DEPENDENCY |

## 15. Recommended implementation order

1. Teach the existing desks to read `GET /api/v1/auth/session` so one account session unlocks them.
2. Add garment and design detail pages on top of the existing project and garment APIs.
3. Add a profile editor only after a profile-update API exists.
4. Leave password recovery, admin, live AI, and live payments unimplemented until those backends exist.
5. Add browser tests for the workspace nav and the account session once a browser runner is part of the repo.
