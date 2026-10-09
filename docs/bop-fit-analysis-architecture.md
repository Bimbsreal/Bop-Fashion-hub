# Bop fit analysis

Deterministic dimensional comparison is **implemented**. Rules-based ease classification is **not implemented**, because no reliable garment-specific ease allowance is documented. Statistical or AI fit prediction is **not operational**. This phase does not replace a physical fitting or a tailor's assessment.

A stored difference between a garment dimension and a body measurement is not a prediction that the garment will fit.

## Domain

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Body measurement | A person's measurement, with source and verification | `measurement_profiles`, `body_measurements` |
| Garment dimension | A stated garment measurement in centimetres | `garment_measurements`, provenance `stated` |
| Size label | A label such as M. It is not a measurement | `garment_size_labels` |
| Fit preference | A vocabulary slot with no seeded values and no numeric allowance | `fashion_terms.kind = fit_preference` |
| Fit analysis | A saved comparison of the dimensions available at that time | `fit_analyses` |

The same size label on two garments can store different dimensions. The comparison uses those stored numbers. It does not assume the labels mean the same thing.

Mapped pairs in rule set `fit-rules.v1`:

| Body definition | Garment definition |
| --- | --- |
| `chest-circumference` | `chest` |
| `waist-circumference` | `waist` |
| `hip-circumference` | `hip` |
| `shoulder-width` | `garment-shoulder` |
| `sleeve-length` | `garment-sleeve` |
| `inseam` | `garment-inseam` |

`garment-length` and `garment-hem` are recorded as limitations. They are not paired with torso length or any other body measurement. Materials such as Ankara, Aso Oke, Adire, lace, and Kente are not garment types and do not select a rule.

## Units

Body and garment values are already stored as canonical centimetres. The analysis reads those stored values. It does not run a second conversion. A body entry of `32.5 in` is already `82.55` cm before comparison. The difference is garment centimetres minus body centimetres, kept to two decimal places. A positive difference means the garment dimension is larger. Ease is not subtracted.

## Classification

`fit-rules.v1` writes only two classifications:

- `insufficient_data` when the category has no documented ease rule, including when one or more pairs were compared, and when no pair could be compared.
- `unsupported_garment` for `agbada`, `kaftan`, and `gown`. A circumference difference may still be stored. The summary says that difference is not a judgment of fit.

The names `potentially_compatible`, `potentially_restrictive`, `potentially_loose`, `mixed`, and `requires_verification` exist in the result type and the database check so a later rule set can use them. Version 1 does not emit them. There is no numerical fit score.

Agbada, kaftan, and gown are unsupported because their cut and volume are design-specific. A flowing garment is not judged by the shirt mapping.

Shirt, trousers, jacket, dress, skirt, and any other typed garment receive the raw differences and `insufficient_data`. A garment with no type is also `insufficient_data`.

## Ease

`easeApplied` is always false. `fitGuarantee` is always false. `fitPreference` is always null. Sending `fitPreference`, `ease`, `confidence`, or `fitScore` is rejected and stores no row.

A negative difference adds a limitation: a smaller garment dimension is not treated as a fit failure, and fabric stretch was not inferred. Disagreeing signs within one size group are explained. They are not classified as mixed. An unverified measurement adds a limitation and does not change the classification. An `ai_estimated` current row is skipped and is not evidence.

## Provenance

Each comparison stores the canonical centimetres, the body measurement id, source, verification, and recorded time, and the garment measurement id and provenance. A later measurement update does not rewrite that row. Reading an analysis requires current access to the profile and current access to the garment. A stranger receives 404. A person with a measurement grant and no access to a private garment also receives 404, so the garment dimensions are not exposed. Deleting a profile deletes its analyses first. Comparisons and notes cascade from the analysis. Measurement and garment rows stay restricted, so an analysis is removed before those rows can be deleted.

No universal expiration period is applied to measurements.

## Size labels

There is no brand size-chart table and no catalog import. When one garment has two or more size labels and those labels were compared on the same body definitions, the result can name the label with the smallest sum of absolute differences. The message says this is not a size recommendation. If the compared definitions differ between labels, that note is omitted. A requested size uses only measurements for that label. A label with no dimensions produces `insufficient_data`.

## API

Local base `http://localhost:5000/api/v1`. Cookie session required.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/fit/rules` | Rule set id, mappings, unsupported categories, `easeRuleCount: 0` |
| `POST` | `/fit/analyses` | 201 `{ analysis }` for `{ profileId, garmentId, size? }` |
| `GET` | `/fit/analyses` | Analyses the caller can read. Optional `profileId` |
| `GET` | `/fit/analyses/:id` | One analysis, or 404 |

Anonymous requests return 401. Missing profile or garment access returns 404. Responses use the existing `{ analysis }` or `{ error: { code, message } }` envelopes. Measurement values are not written to logs.

## Database

Migration `sql/migrations/010_fit_analysis.sql` adds `fit_analyses`, `fit_analysis_comparisons`, and `fit_analysis_notes`. Foreign keys point at the existing profile, garment, body measurement, and garment measurement rows. Indexes cover profile and garment lookups. Numeric columns use `numeric(8,2)`. Timestamps use `timestamptz`.

## Authorization

Profile visibility is the subject or an active grant. Garment visibility is the existing catalog rule: owner, active organization member, or public. Organization membership does not reveal a measurement profile. Both checks are required.

## Frontend

`/fit` lists authorized profiles and catalog garments, shows source and verification, shows which mapped dimensions are present in centimetres, and posts a comparison. The result shows the classification, each difference, the rule notes, and the statement that ease was not applied and physical fit is not guaranteed. Empty, loading, and error states are on the page. It does not invent measurements. The marketing landing page is unchanged.

## Tests

`server/test/fit.test.ts` uses `@fit.test` and the existing `node:test` runner. It covers unit conversion already stored as centimetres, missing and unmapped dimensions, disagreeing signs, the absence of an ease allowance, agbada as unsupported, two garments labeled M with different chest values, size proximity labeled as not a recommendation, skipped AI estimates, user-entered, imported, tailor-recorded, and verified rows, history that keeps the earlier centimetre value, and authorization for anonymous, foreign profile, missing garment, private garment, and another person's history.

Passing these tests does not establish real-world fit accuracy.

## Limitations

- No documented ease number exists for any category, so suitability is not classified.
- Garment provenance is only `stated`. Measured, manufacturer, and tailor dimensions are not separate values.
- Fit preferences are not applied.
- There is no brand-wide size chart.
- Fabric, construction, layering, and silhouette are not inferred from an image.
- Dimensional proximity is derived from the stored snapshots when the analysis is read. The stored classification, summary, and differences are not recalculated from newer measurements.

## Later work

A later phase can add a versioned ease rule only when a cited source gives a garment-specific allowance. That rule set should be a new id. AI or statistical fit prediction, image measurement, and tailoring patterns are separate work and are not implied by this comparison.
