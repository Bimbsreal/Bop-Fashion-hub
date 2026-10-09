# Bop body measurement architecture

Status of this document: written after `sql/migrations/009_body_measurements.sql` was applied on the disposable local PostgreSQL 18 cluster, the measurement tests passed, and `/measure` was exercised in a local browser. The desk account used for that browser check was removed. The landing page and `footer video.mp4` were left in place.

Recording body measurements, their history, and stated garment dimensions is **implemented**. Comparing those stored values is documented in `docs/bop-fit-analysis-architecture.md`. Image-based measurement, AI estimates, and fit prediction are **not operational**.

Labels:

- **IMPLEMENTED** — present and exercised.
- **NOT OPERATIONAL** — represented in the model, with no working estimator or fit engine.
- **NOT IMPLEMENTED** — intentionally absent.

## Domain

Three records stay separate.

| Concept | Meaning | Where |
| --- | --- | --- |
| Body measurement | A length on a person | `measurement_profiles`, `body_measurements` |
| Garment dimension | A stated finished dimension of a garment | `garment_measurements` |
| Size label | A commercial label such as M | `size_labels`, `garment_size_labels` |

A size label does not determine a body measurement. The same letter can sit on garments with different chest values. A body circumference is not a garment circumference. `chest` is a garment definition. `chest-circumference` is a body definition. Posting a body definition onto a garment returns `wrong_subject`.

`user_profiles` remains the account name record. A measurement profile is not an account profile.

Ease allowances, size charts beyond the existing letter labels, and manufacturing specifications are **NOT IMPLEMENTED**. Garment dimensions are finished stated values. No universal ease is applied.

## Profiles

A measurement profile belongs to one person, `subject_user_id`. It has a name, notes, a preferred display unit (`cm`, `m`, or `in`), and a status of `active` or `archived`. One person may keep more than one profile, up to 12. Sources are stored on each measurement, so a tailor visit does not require a second profile system.

Organization ownership is rejected. An active membership in a tailor, studio, brand, or retailer organization does not reveal another person's measurements.

The subject can grant one active permission to a specific person: `read`, `record`, or `verify`. Record does not include verify. Verify does not include record. The subject can change or revoke the grant. There is no public link.

## Sources and verification

| Source | Who may record it | Verification |
| --- | --- | --- |
| `user_entered` | The profile subject | Unverified until a verify grant confirms it |
| `imported` | The profile subject | Unverified |
| `tailor_recorded` | A person with `record` access | Unverified until a verify grant confirms it |
| `professionally_verified` | A person with `verify` access | Stored verified, with verifier and time |
| `ai_estimated` | Nobody through the API | The column allows the value for a later phase. The API returns `unsupported_source` |

The subject cannot mark their own entry professionally verified. Verifying an existing current row sets `verification_status` to `verified` and does not change the source or the value. No confidence number is stored.

## Units and precision

Canonical storage for body measurements and for garment dimensions whose definition unit is centimetres is centimetres, `numeric(8, 2)`.

The original entry is kept. Body rows store `entered_text` exactly as accepted, plus `entered_unit`. Garment rows store `entered_value` and `entered_unit`. The canonical centimetre value is derived from that entry. Display values are converted from the canonical value for the profile's preferred unit and are not the stored source of truth.

Accepted entry:

| Unit | Fraction digits |
| --- | --- |
| `cm` | 0 to 2 |
| `in` | 0 to 2 |
| `m` | 0 to 3 |

Inches convert as `value × 2.54`, rounded half up to 2 decimal centimetres. Metres convert as `value × 100`. The arithmetic uses integers, not binary floating point. `32.5 in` is stored as `82.55 cm` and still shows the entered `32.5 in`. `10.25 in` becomes `26.04 cm`. `1.625 m` becomes `162.50 cm`.

Each body definition has its own minimum and maximum in centimetres. A neck measurement is not judged by the waist limits. Values outside that range are rejected. The ranges are clothing-entry limits, not health assessments.

Zero and negative values are rejected. Garment dimensions must also stay below 10000 cm, which was already the garment value check.

## History

A new value for the same definition does not overwrite the previous row. The previous current row becomes `superseded`. The new row is `current`. Archiving a current row sets `archived` and leaves the earlier superseded rows in place. History is the measurement rows themselves. There is no second audit log.

The profile `updated_at` changes when a measurement is recorded, verified, or archived.

Deleting a profile removes that profile, its measurements, and its grants. That is the retention action available to the subject. Revoking a grant keeps the grant row with `revoked_at` set and removes access immediately.

## API

Under `http://localhost:5000/api/v1/measurements`. Every route except the static error paths requires a session. Outsiders receive 404.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/definitions` | Body definitions and limits. `fitAnalysis` stays false on this list; comparison is a separate route. `imageExtraction` stays false |
| `GET` | `/profiles` | Profiles the caller can see. `status` is `active` or `archived` |
| `POST` | `/profiles` | Create a profile for the signed-in person. `201` |
| `GET` | `/profiles/:id` | Profile, current measurements, and grants. Grants are included only for the subject |
| `PATCH` | `/profiles/:id` | Name, notes, preferred unit, or status. Subject only |
| `DELETE` | `/profiles/:id` | Delete the profile and its history. Subject only. `204` |
| `POST` | `/profiles/:id/measurements` | Record a value. The value is a decimal string. `201` |
| `GET` | `/profiles/:id/history` | Current, superseded, and archived rows. Optional `definition` |
| `POST` | `/profiles/:id/measurements/:measurementId/archive` | Archive the current row |
| `POST` | `/profiles/:id/measurements/:measurementId/verify` | Verify access only |
| `POST` | `/profiles/:id/grants` | Grant or change access by exact email |
| `DELETE` | `/profiles/:id/grants/:userId` | Revoke access. `204` |

Garment dimensions stay on `POST /api/v1/catalog/garments/:id/measurements`. An optional `unit` of `cm`, `m`, or `in` converts into the definition's centimetre value. Omitting `unit` still means centimetres. Provenance remains `stated`.

`organizationId`, `size`, `sizeLabel`, `ease`, `confidence`, and `fit` are rejected on measurement profile bodies.

## Frontend

`/measure` is a local workspace. A signed-in person can create a profile, enter a body measurement in centimetres, metres, or inches, read the entered value beside the stored centimetres, open earlier values, archive a current value, and grant or remove access by email. The page states that fit is not predicted and that a photograph is not measured. It does not prefill sample measurements.

## Fit comparison

`/fit` and `POST /api/v1/fit/analyses` read the current body row's `canonical_cm` and the garment's stated centimetre value. The size label stays a label. Rule set `fit-rules.v1` records the difference and does not apply an ease allowance or recommend a size. See `docs/bop-fit-analysis-architecture.md`.

## Future AI measurement

`ai_estimated` is reserved and refused. No image is read. No body scan, weight inference, or health assessment runs.

## Testing

`npm test` includes `server/test/body-measurements.test.ts`. Addresses use `@measure.test` and are removed afterward, including profiles, grants, and garments.

Exercised:

- Half-up conversion for inches and metres, and display conversion back from canonical centimetres.
- Anonymous access returns 401.
- Body definitions include `chest-circumference` and exclude the garment slug `chest`.
- Missing definition, zero, an unknown unit, a neck value below its own limit, `ai_estimated`, and a self-claimed professional verification are rejected.
- `32.5 in` is stored as entered text `32.5` and canonical `82.55`, displayed in the preferred inch unit as `32.50`.
- A correction keeps the previous value as `superseded`.
- Another person, including a member of a tailor organization created by the subject, receives 404.
- Read access can see the profile and cannot record. Record access can store `tailor_recorded` unverified. Verify access can verify without changing the source. The subject cannot verify their own row.
- Archiving keeps both the archived value and the superseded value.
- Revocation returns the tailor to 404.
- A body definition cannot be stored as a garment dimension.
- A garment chest of `32 in` is stored as `81.28 cm`, still labeled M, with provenance `stated`.
- A stranger cannot add a garment dimension.

Image-based extraction was not run.

A local browser session at `http://localhost:3000/measure` signed in, saw the empty profile state, created a profile named General, rejected an ankle value of 5 cm with the field limit, then saved a waist of 32.5 in. The page showed the entered 32.5 in, the stored 82.55 cm, source “Entered by you”, and unverified. History showed that current row. The landing hero remained, and the footer video at `/landing/bop%20landing%20page%20UI/footer%20video.mp4` was present.

## Limitations

- One active grant per person. Record and verify are not combined.
- Garment definitions other than the centimetre seeds are not converted into a different definition unit.
- Fit comparison stores dimensional differences and does not recommend a size. See `docs/bop-fit-analysis-architecture.md`.
- Deleting a profile deletes its history. Archiving a profile keeps it.
- The letter size system is still XS through XL. Numeric and regional size systems are not seeded.
