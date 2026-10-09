# Bop landing asset map

Visual audit of `public/landing/bop landing page UI/` against the landing-page reference. Filenames were not used as the matching method. Source files were not renamed, overwritten, or cropped.

The journey steps use six separate files in `public/landing/bop landing page UI/`: `01-create.png` through `06-order.png`. There is no `public/bop landing page UI/` directory and no `process` folder. Those six files are about 160 by 142 pixels. The journey renders each original PNG directly so the image optimizer does not enlarge and recompress it. Displayed larger than that source, they remain limited by the file resolution. The other multi-panel sheets are still shown through a CSS source window in `lib/landing-assets.ts`. The files on disk are unchanged.

Confidence:

- **High** — subject, garment, or composition clearly matches the reference slot.
- **Medium** — closest available image, with a visible difference from the reference.
- **Missing** — no suitable file. The interface keeps its existing drawn treatment.

## Mapped slots

| UI location | Selected asset | Confidence | Reason |
|---|---|---|---|
| Hero model | Regal Ankara Fashion Portrait Cutout.png | High | Same model, orange/black Ankara gown, upward editorial pose. Stone arches are not in the file. |
| Hero background | — | Missing | No interior photograph was supplied. |
| Fabric chip | Connected Fashion Ecosystem.png (rolled-fabric panel) | High | Ankara rolls match the fabric chip. |
| Garment chip | Regal Ankara Fashion Portrait.png | Medium | Same gown as the hero. No separate product photo of the top. |
| Style chip | Glamorous Ankara Headwrap Portrait.png | Medium | Completed styled portrait, not the smaller contemporary chip in the reference. |
| Accessories chip | Connected Fashion Ecosystem.png (bags and shoes panel) | High | Handbag, jacket, and shoes. |
| Virtual try-on | Elegant Ankara Fashionista Using Smartphone.png | Medium | Same model with a phone. Not a face-only result crop. |
| Alternate look, formal | Elegant Agbada Fashion Portrait.png | Medium | Full-body formal traditional look. The reference thumb is a smaller suit. |
| Alternate look, occasion | Elegant Copper Gele Portrait.png | Medium | Gele, jewelry, and clutch. Not the green full-body look. |
| Measurement figure | — | Missing | No diagram file. The drawn croquis stays. |
| 01 Create | 01-create.png | High | Hands sketching a fashion figure. Shown as its own file. |
| 02 Visualize | 02-visualize.png | High | Rolled textiles. Shown as its own file. |
| 03 Try | 03-try.png | High | Model in an orange gown. Shown as its own file. |
| 04 Fit | 04-fit.png | High | Tape during a fitting. Shown as its own file. |
| 05 Style | 05-style.png | High | Bags and shoes. Shown as its own file. |
| 06 Order | 06-order.png | High | White bag marked Bop. Shown as its own file. |
| Audience portrait | Stylish African Man in Traditional Attire.png | High | Cream tunic, cap, sunglasses, hands clasped. Sits beside People. Culture. Style. Technology. |
| Individuals | Thoughtful Braids in Golden Elegance.png | High | Same portrait as the individuals card, without baked-in heading text. |
| Designers | Focused Fashion Atelier Designer.png | High | Designer sketching beside a dress form in a studio. |
| Tailors | Tailor’s Hands Measuring Dark Fabric.png | High | Hands, yellow tape, and chalk on dark cloth. |
| Brands & Retailers | Elegant Boutique Browsing.png | High | Shopper, handbag, and clothing rail. |
| African fashion background | footer video.mp4 | — | Normal field. Ornate Draped Tribal Textile.png remains the reduced-motion still only. |
| Traditional | Fashion Icon Set_ Eight Categories.png (1st circle) | High | Traditional garment icon. Printed label is not shown. |
| Contemporary | Fashion Icon Set_ Eight Categories.png (2nd circle) | High | Shirt icon. |
| Streetwear | Fashion Icon Set_ Eight Categories.png (3rd circle) | High | Hoodie icon. |
| Formalwear | Fashion Icon Set_ Eight Categories.png (4th circle) | High | Suit icon. |
| Footwear | Fashion Icon Set_ Eight Categories.png (5th circle) | High | Shoe icon. |
| Accessories | Fashion Icon Set_ Eight Categories.png (6th circle) | High | Bag icon. |
| Occasions | Fashion Icon Set_ Eight Categories.png (7th circle) | High | Gown icon. |
| And more | Fashion Icon Set_ Eight Categories.png (8th circle) | High | Plus icon. |

The male traditional portrait is the audience feature. The African fashion section uses the textile behind the headline. That follows the reference composition already built into the page.

## Similar and duplicate files

| File | Relationship |
|---|---|
| Regal Ankara Fashion Portrait.png | Same hero pose as the cutout. Used for the garment chip. |
| Regal Ankara Fashion Portrait Cutout.png | Hero foreground. Slightly more of the canvas is transparent. |
| Elegant Agbada Fashion Portrait.png | Full-body walking pose of the traditional subject. Used as the formal alternate look. |
| Stylish African Man in Traditional Attire.png | Closer crop, hands clasped. Used as the audience portrait. |
| Thoughtful Braids in Golden Elegance.png | Clean individuals portrait. |
| Individuals Fashion Portrait Card.png | Same woman, with the heading and arrow already printed in the image. Not placed. |
| Focused Fashion Atelier Designer.png | Studio photograph used for Designers. |
| Fashion Designer Sketching at Studio Table.png | Wider studio sketch of the same designer. Not placed. |
| Fashion Designer Sketching with Mannequin.png | Tighter sketch of the same designer. Not placed. |

## Files with no single slot

These are multi-panel sheets. Their scenes also exist as separate files or inside the ecosystem strip, so the whole sheet is not placed as one image.

- Bop Fashion Community Collage.png
- Contemporary African Fashion Lineup.png — four full-body looks in one frame (traditional, occasion, streetwear, green suit). Splitting it would show neighboring figures.
- Fashion Craftsmanship Portraits Collection.png
- Fashion Industry Cutout Collection.png
- Fashion Industry Portrait Panels.png

## Reference visuals with no dedicated file

- Sunlit stone arches behind the hero.
- A body-measurement diagram. The croquis remains.
- Separate category photographs. The supplied category art is one icon sheet, and each circle is mapped on its own.
- A brown-and-gold textile that fills the African fashion banner edge to edge. The draped orange, navy, and gold cloth is the stand-in.
