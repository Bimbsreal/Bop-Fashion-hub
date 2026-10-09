# Bop multi-page website integration

Local integration completed on 2026-10-09. This phase connects the existing Next.js app to the existing Express API. It does not make Bop a finished website.

## 1. Implemented route inventory

| Route | Purpose | User | Auth | Backend | Status | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | Public landing | Anyone | None | None | Preserved | Headline, hero, journey, and footer video remain. |
| `/account` | Register, sign in, sign out, show the session | Anyone | Cookie for the signed-in view | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` | Implemented | Session survives reload. Password recovery is absent. |
| `/catalog` | List visible garments and create one | Anyone can read; create requires a session | Create requires the cookie | `GET` and `POST /catalog/garments` | Implemented | Empty, error, and created rows render. No detail page. |
| `/design` | List and create design projects | Signed-in user for both | Cookie | `GET` and `POST /design-projects` | Implemented | Unsigned visitors see the sign-in explanation. |
| `/analysis` | Review simulated garment attributes | Signed-in user | Cookie, but the desk uses its own sign-in flag | `/analyses`, `/media` | Existing desk, now linked | Desk still requires its own sign-in action. |
| `/visualize` | Arrange stored references | Signed-in user | Same | `/visualizations` | Existing desk, now linked | No generated image. |
| `/try-on` | Record a consented try-on request | Signed-in user | Same | `/try-on` | Existing desk, now linked | No generated try-on. |
| `/measure` | Save body measurements | Signed-in user | Same | `/measurements` | Existing desk, now linked | Manual entry only. |
| `/fit` | Compare measurements with garment dimensions | Signed-in user | Same | `/fit` | Existing desk, now linked | No fit guarantee. |
| `/style` | Assemble outfits from catalog tags | Signed-in user | Same | `/style` | Existing desk, now linked | No generated worn image. |
| `/commerce` | Publish and browse listings | Signed-in business user for management; published listings are readable | Same | `/commerce` | Existing desk, now linked | No separate storefront route. |
| `/orders` | Request, quote, and track an order; request a simulated payment | Customer or seller | Same | `/orders`, `/payments` | Existing desk, now linked | Simulation stays labeled. `paid` stays false. |

## 2. Routes still missing

About, fashion category pages, public designer or brand profiles, garment detail, fabric and pattern browsers, password recovery, password reset, profile settings, preference editor, saved-design detail, revision history, reference boards, visualization history as its own page, try-on result gallery, measurement history page, fit history page, outfit detail page, marketplace home, seller storefront, checkout, payment history page, business dashboard separate from `/commerce`, team management, and admin. They depend on missing pages or missing APIs and were not stubbed.

## 3. Shared layouts and reusable components

- `components/workspace/WorkspaceNav.tsx` lists Account, Catalog, Design, Analysis, Visualize, Try-on, Measure, Fit, Style, Commerce, and Orders, plus a link back to `/`.
- `components/workspace/WorkspaceShell.tsx` wraps those pages.
- `lib/workspace-routes.ts` is the single route list.
- `lib/account-form.ts` and `lib/catalog-form.ts` prepare JSON bodies before fetch.
- The landing header, footer, and sections are unchanged apart from an Open account link and a retained Get started link inside the existing account dialog.

## 4. Authentication and authorization behavior

- The API sets `bop_session` as HttpOnly, SameSite=Lax, Path=/.
- `GET /api/v1/auth/session` requires that cookie and returns `{ user: { id, email, displayName } }` for an active user.
- Logout revokes the token and clears the cookie. A later session read is 401.
- `/account` loads that endpoint. A 401 shows the register and sign-in form.
- Catalog creation and design list/create stay disabled until that session read succeeds.
- Older desks still start with `signedIn` false and do not read the session endpoint.
- There is no return URL and no open redirect.
- Password recovery is not available. The account page says so.

## 5. Frontend-to-backend integration map

| Page action | Endpoint |
| --- | --- |
| Load account | `GET /api/v1/auth/session` |
| Create account | `POST /api/v1/auth/register` |
| Sign in | `POST /api/v1/auth/login` |
| Sign out | `POST /api/v1/auth/logout` |
| List garments | `GET /api/v1/catalog/garments` with optional `type` |
| Create garment | `POST /api/v1/catalog/garments` |
| List projects | `GET /api/v1/design-projects` |
| Create project | `POST /api/v1/design-projects` |
| Older desks | Their existing endpoints, unchanged |

The browser calls `/api/v1/...`. Next.js rewrites that prefix to `BOP_API_ORIGIN` or `http://127.0.0.1:5000`. No new migration was added.

## 6. Functional user journeys

1. Open `/`, use the header account dialog, and follow Open account to `/account`.
2. Register. The cookie session is shown. Reload keeps it. Sign out returns the form.
3. From the workspace nav, open Catalog, filter by a garment-type slug, and create a garment while signed in.
4. Open Design and create a project. The page states that this does not generate an image.
5. Use the nav to reach the existing analysis, visualization, try-on, measure, fit, style, commerce, and order desks. Each of those desks still asks for its own sign-in before its actions run.

## 7. Features that are fully operational

- Public landing page.
- Local account registration, sign-in, session read, and sign-out on `/account`.
- Garment list and create on `/catalog`.
- Design-project list and create on `/design`.
- Shared workspace links between the existing desks.

## 8. Features that are partially operational

- Analysis, visualization, try-on drafts, measurements, fit comparison, styling, commerce, orders, and simulated payments. Their APIs and desks already worked. Their pages now share navigation. Their sign-in state is still local to each desk.
- Catalog discovery has a type slug filter and no detail page.
- Design has no revision or media workspace on the new page.

## 9. UI-only features

- Landing header Sign in still opens a dialog and does not call the API. Open account leaves that dialog for `/account`.
- Landing journey, audience, and category sections remain editorial links and in-page navigation.

## 10. Simulated functionality

- Image analysis remains simulated.
- Payment capture remains a development ledger row when `PAYMENT_SIMULATION=1`. It does not charge a card, does not set `realMoney`, and does not set the order's `paid` flag.
- Try-on remains a stored request.
- Fit comparison remains dimensional and does not claim ease or a fit guarantee.

## 11. Features blocked by missing engines or providers

Live vision analysis, image generation, virtual try-on rendering, photo measurement, ease rules, and a real payment provider. Occasion styling terms remain unseeded. `fashion_terms` stays at the existing seeded count.

## 12. Responsive and accessibility findings

The workspace nav is a horizontal scrolling list with visible text links and `aria-current` on the active path. Forms use labels. A full keyboard, contrast, tablet, and mobile pass of every older desk was not repeated in this phase. The landing page's approved layout was left in place.

## 13. Tests executed and actual results

- `npm test`: 72 passed, 0 failed. This includes `server/test/session.test.ts` and `server/test/website-form.test.ts`.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- Browser on http://localhost:3000: the landing headline remained “Fashion without limits.” Open account reached `/account`. Registration created `browser-site@site.test`, and a full reload still showed that session. Catalog saved “Site shirt” as private. Design saved “Site study” as draft, private, revision 1. Sign-out restored the account form. `/orders` showed the workspace nav and its own sign-in form, with no published listings. The footer video `readyState` was 4 and its source was `/landing/bop%20landing%20page%20UI/footer%20video.mp4`.
- `next build` was not run while the existing Next.js process was serving port 3000.

## 14. Known defects and remaining work

- Older desks ignore an existing `bop_session` until the user submits their local sign-in form.
- `/catalog` refetches when the applied type slug changes and does not paginate.
- There is no garment or project detail route.
- Account has no profile or password update.
- The landing dialog is still not a sign-in form.
- Dense commerce and order layouts were not redesigned for small screens.

## 15. Recommended next implementation phase

Hydrate every existing desk from `GET /api/v1/auth/session`, then add garment and design detail pages using the current APIs. Do not add password reset, admin, or live payments until those services exist.
