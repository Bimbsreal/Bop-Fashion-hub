# Bop

Public landing page for Bop, the fashion intelligence platform.

Local only:

- App: http://localhost:3000
- API: http://localhost:5000/api/v1

```bash
npm install
npm run dev
```

The public page does not call the API. Start the API separately after setting `DATABASE_URL` in a gitignored `.env` file (see `.env.example`):

```bash
npm run db:migrate
npm run dev:api
```

Account sign-in on the landing page is still a placeholder. Open account goes to `/account`, which registers, signs in, and reads `GET /api/v1/auth/session`. `/catalog` lists garments and `/design` lists design projects. The workspace nav also links `/analysis`, `/visualize`, `/try-on`, `/measure`, `/fit`, `/style`, `/commerce`, and `/orders`. Those desks still keep their own sign-in state. See `docs/bop-multipage-website-audit.md` and `docs/bop-multipage-website-integration.md`. A separate local page at `/analysis` can sign in and review simulated garment attributes. `/visualize` arranges existing images, garments, and design projects. It does not generate images. `/try-on` can record a consented request. It does not generate a try-on image. `/measure` records body measurements. It does not estimate them from a photograph. `/fit` compares those stored measurements with stored garment dimensions and does not predict physical fit. `/style` assembles outfits from catalog tags and does not judge taste or generate a worn image. `/commerce` lets a business publish listings. `/orders` records a request against a published listing and can request a simulated payment when `PAYMENT_SIMULATION=1`. That simulation does not charge a card or mark the order paid. Listings do not reserve stock. The API has local sessions for catalog, media, design projects, analysis, visualization, and commerce. Uploaded files stay in `.local/media`, not in `public/`. No real AI provider is configured. See `docs/bop-fashion-image-analysis-architecture.md`, `docs/bop-fashion-visualization-architecture.md`, `docs/bop-virtual-try-on-architecture.md`, `docs/bop-body-measurement-architecture.md`, `docs/bop-fit-analysis-architecture.md`, `docs/bop-personal-styling-architecture.md`, `docs/bop-fashion-commerce-architecture.md`, `docs/bop-order-management-architecture.md`, and `docs/bop-payment-integration-architecture.md`.

Landing photographs are mapped in `lib/landing-assets.ts`. Drop supplied files into `public/landing/` and set each slot `src` to its public path. Empty slots render a neutral placeholder.
