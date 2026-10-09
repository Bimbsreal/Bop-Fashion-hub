# Bop landing page quality audit

Audit date: 2026-10-09. Local page: http://localhost:3000. This pass compared the current Next.js landing page with the files on disk and with the page as rendered in the browser. It is a refinement record, not a redesign.

## Initial findings

The page is one App Router route, `app/page.tsx`, composed of the existing header, hero, ecosystem intro, fashion journey, audience section, African fashion field, category rail, and footer.

`public/bop landing page UI/` does not exist. `public/BOP landing page UI/` does not exist. Landing files live in `public/landing/bop landing page UI/`. The footer film is `footer video.mp4` in that folder (8,070,372 bytes). It is the African fashion background, not a control inside the site footer.

## Six journey images

| Step | File | Source size | Rendered size at 1920px | Filter |
| --- | --- | --- | --- | --- |
| Create | `01-create.png` | 178×142 | about 236×207 | none |
| Visualize | `02-visualize.png` | 162×142 | about 236×207 | none |
| Try | `03-try.png` | 160×142 | about 236×207 | none |
| Fit | `04-fit.png` | 160×142 | about 236×207 | none |
| Style | `05-style.png` | 162×142 | about 236×207 | none |
| Order | `06-order.png` | 172×142 | about 236×207 | none |

`FashionJourney` reads these through `lib/landing-assets.ts`. Each step has its own file, in that order. `object-fit` is `cover`. There is no CSS blur, backdrop blur, or overlay on these images. Next.js image optimization is turned off for these six slots so the browser uses the PNG pixels.

The softness is the source size. The cards are wider and taller than the files, so the browser scales them up. No code change can add detail those files do not contain. The high-resolution sheet `Connected Fashion Ecosystem.png` (2172×724) remains on disk and is still used for the fabric and accessories chips. It was not swapped back into the journey, because the six named files are the current sources.

## Verified visual behavior

At a 1920×1200 browser viewport:

- The headline is “Fashion without limits.”
- Header links, Search, Sign in, and Get started sit inside the viewport. The menu button is hidden at this width, which matches the stylesheet from 1080px upward.
- Page overflow was 0.
- No broken images were found.
- The hero, journey, audience portraits, and African fashion field rendered. The African video `readyState` was 4, it was muted, looping, inline, without controls, and it was playing.
- Reduced-motion rules already disable the hero choreography and the editorial reveals.

Device-metric overrides for 1440×900, 1024×768, 768×1024, 390×844, and 320×640 did not change `window.innerWidth`, which stayed 1920. Those five sizes were not visually captured. The stylesheet already clips horizontal overflow on `html`, switches the header to a menu below 1080px, and lets the journey row scroll inside itself below 1100px.

## Navigation

| Control | Destination | Result |
| --- | --- | --- |
| Bop logo | `/` | Existing home route |
| Individuals, Designers, Tailors, Retailers | `#individuals`, `#designers`, `#tailors`, `#retailers` | Sections on this page |
| Explore menu | In-page hashes | Sections on this page |
| Pricing | `#pricing` | Footer note. No pricing page. |
| Sign in | Account dialog | The dialog does not create a session. Open account goes to `/account`, which does. |
| Get started | `#get-started` | African fashion block |
| Explore Bop | `#ecosystem` | Ecosystem intro |
| Try it on | `#try` | Journey step, not `/try-on` |
| Audience arrows | The card’s own id | The header already scrolls to that card |
| Categories | `#journey`, except And More which is `#categories` | No category listing pages exist |
| Footer links | The same in-page hashes | No dead app routes were added |

## Accessibility and performance

- The hero is an `h1`. Section headings are in place. The journey heading is visually hidden and exposed to assistive tech.
- Journey images have descriptive alternative text. The African video is `aria-hidden` because it is a background.
- `:focus-visible` draws an ink ring. Skip-to-content is present.
- Category marks render at about 50×50 while their `sizes` hint is `640px`. That can download a larger derivative of the icon sheet. It was left unchanged so the crop math is not disturbed in this pass.
- No failed landing-resource entries were recorded in this session.

## Changes made

None. The remaining image softness is the resolution of `01-create.png` through `06-order.png`. Pointing the journey at the missing `public/bop landing page UI/` paths would break the section. Shrinking the cards to hide the scale-up would change the approved layout.

## Tests executed

- Browser inspection of http://localhost:3000 at the live 1920×1200 viewport, including the hero, journey, audience, and African film.
- `npx tsx --test server/test/journey-assets.test.ts`: 1 passed, 0 failed.
- Lint and `next build` were not run. No source files were changed.
- The five smaller viewports listed in the prompt were not captured, because the browser viewport override did not take effect.

## Still outstanding

- Sharper journey photographs need replacement PNGs larger than the cards (about 240px wide at 1920px, and larger on bigger screens). Place them without renaming, or add `public/bop landing page UI/` if that folder is the intended drop location.
- Password recovery, pricing, category listings, and a dedicated About page are still absent.
- Try it on stays an in-page journey anchor. `/try-on` exists as a workspace and is not the hero button target.
- Small-viewport layout was reviewed in CSS and not re-shot in the browser during this pass.
