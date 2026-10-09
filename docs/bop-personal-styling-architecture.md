# Bop personal styling

Deterministic outfit assembly from catalog tags is **implemented**. A learned or model-generated styling agent is **not operational**. This phase does not produce a worn-outfit image, a fit prediction, or a purchase.

A suggestion is an explanation of which stored tags matched an explicit rule. It is not a claim that the combination is fashionable, culturally appropriate, or right for a particular person.

## Domain

| Concept | Meaning | Where |
| --- | --- | --- |
| Styling profile | Optional notes and preferred or disliked catalog terms for one account | `styling_profiles`, `styling_preferences` |
| Wardrobe list | Catalog garments the person chose to keep for styling | `wardrobe_items` |
| Outfit | A named board of up to one garment per role | `outfits`, `outfit_items` |
| Styling session | One recommendation request and its stored explanations | `styling_sessions` and child tables |

`user_profiles` remains the account name record. Style preferences are not stored there. There is no brand table, no price, and no retail stock table. A wardrobe row does not record ownership or a purchase.

## Preferences

A person may save up to 24 preferences. Each one points at an existing `fashion_terms` row of kind `style`, `color`, `occasion`, `garment_type`, `material`, `tradition`, or `category`. The same term cannot be both preferred and disliked. Clearing the profile removes the notes and the preferences.

No preference is required. If none are saved, explanations do not claim a personal match.

The request rejects `budget`, `price`, `silhouette`, `ethnicity`, `religion`, `url`, `confidence`, and `image`. The engine does not infer those attributes.

## Outfit roles

Rule set `style-rules.v1` maps existing garment types:

| Type | Role |
| --- | --- |
| `shirt` | top |
| `trousers`, `skirt` | bottom |
| `jacket` | outerwear |
| `dress`, `gown`, `kaftan`, `agbada` | one-piece |

Supported compositions are a top with a bottom, those two plus outerwear, a one-piece alone, and a one-piece with outerwear. Footwear, headwear, and bags have no garment type in the catalog, so they are not required and are not invented. A garment with no mapped type is not placed in an outfit.

## Color

Documented pairs among the seeded colors:

- The same color term is monochromatic.
- Black, white, and ivory together are neutral.
- Indigo or gold with black, white, or ivory is an accent with a neutral.

Indigo with gold is not a documented pair. The outfit can still be returned, with a note that it was not rejected for color. A garment with no color term is not treated as unsuitable. The note says color was not compared. These rules are not a claim that the pairing suits every person or culture.

## Occasion and style

The `occasion` kind exists and has no seeded terms. An unknown occasion slug is rejected. When no occasion is requested, the session says occasion suitability was not assessed. A missing occasion tag on a garment would not exclude it.

A requested style tag is a match only when the garment carries that tag. Garments that share a style tag say so. Garments with different style tags stay together, with a note that mixed styles are allowed. A missing style tag is not treated as unsuitable.

## African fashion

Ankara, Aso Oke, Adire, lace, George, and Kente are material or tradition terms already in the catalog. Agbada, kaftan, and gown use the one-piece role. Contemporary African fashion is a style term. They participate in the same pool, preferences, and explanations as every other term. A material tag is quoted when it is stored. No ceremonial meaning is inferred. Preferring Ankara is an explicit user choice, not a guess about identity.

## Ranking

`ruleMatchCount` is the number of notes whose kind is `match`. Outfits are ordered by that count, then by garment id. The API field `fashionQualityScore` is false. The count is not a measure of fashion quality. Attribute notes, limitations, and assumptions do not increase the count. At most six outfits are stored. The readable pool is the first 80 garments by name. Combination stops at 240 outfits. Both limits are written on the session when they apply.

## Explanations

Match notes cite a composition rule, a selected garment, a documented color pair, a shared or requested style, a requested occasion tag that is actually present, or a saved preference term that is actually on the garment. Attribute notes quote material, pattern, and tradition tags. Limitations name missing color, an undocumented color pair, a missing requested tag, or mixed styles. Assumptions state that the board is not a worn photograph and that cultural suitability was not inferred for agbada, kaftan, and gown.

## API

Local base `http://localhost:5000/api/v1`. Cookie session required.

| Method | Path |
| --- | --- |
| `GET` | `/style/rules` |
| `GET` | `/style/vocabulary` |
| `GET`, `PUT`, `DELETE` | `/style/profile` |
| `GET`, `POST` | `/style/wardrobe` |
| `DELETE` | `/style/wardrobe/:garmentId` |
| `POST`, `GET` | `/style/sessions` |
| `GET` | `/style/sessions/:id` |
| `POST` | `/style/sessions/:id/recommendations/:recommendationId/reject` |
| `POST` | `/style/sessions/:id/recommendations/:recommendationId/save` |
| `GET`, `POST` | `/style/outfits` |
| `GET`, `PATCH` | `/style/outfits/:id` |
| `PUT` | `/style/outfits/:id/items` |
| `DELETE` | `/style/outfits/:id/items/:role` |
| `GET` | `/style/outfits/:id/alternatives?role=` |

Anonymous requests return 401. Another person's outfit, session, or unreadable garment returns 404. Duplicate outfit places return 409.

## Authorization

Profiles, wardrobe rows, outfits, and sessions belong to the signed-in user. Organization membership does not reveal another person's wardrobe or outfits. Garments enter a session only when the existing catalog visibility rule allows the caller to read them. A later loss of access hides the garment name on read and keeps the stored explanation.

## Frontend

`/style` edits optional preferences, requests an assembly, shows the stored reasons, and keeps a catalog outfit board. Empty catalog, empty wardrobe, empty occasion vocabulary, and insufficient-data sessions have their own copy. The marketing landing page is unchanged.

## Tests

`server/test/style.test.ts` uses `@style.test`. It covers neutral and undocumented color pairs, a disliked color that removes a garment, an agbada one-piece with an Aso Oke preference, missing color kept in the pool, preference authorization, an unknown occasion, a rejected budget, Ankara and contemporary African tags cited from the garment, a private garment left out, an empty wardrobe, outfit create, replace, remove, rename, cross-user outfit and wardrobe access, and the catalog row remaining after a wardrobe removal.

Passing these tests does not make a suggestion objectively fashionable.

## Limitations

- No occasion terms are seeded, so occasion matching cannot run until that vocabulary exists.
- No prices, so budget filtering is rejected.
- No silhouette or fit-preference terms are seeded, and fit analysis is not called from styling.
- No footwear, headwear, or bag garment types.
- No popularity signal.
- The outfit board does not generate an image.
- A future statistical or model-based stylist would be a separate capability and is not implied by these rules.
