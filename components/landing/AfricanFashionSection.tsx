import { AfricanFashionFilm } from "@/components/landing/AfricanFashionFilm";
import { FashionCategoryRail } from "@/components/landing/FashionCategoryRail";
import { MotionSection } from "@/components/landing/MotionSection";
import { ArrowRightIcon } from "@/components/landing/icons";

export function AfricanFashionSection() {
  return (
    <MotionSection className="african" id="african" aria-labelledby="african-heading">
      <div className="african-media motion-media" aria-hidden="true">
        <AfricanFashionFilm />
        <div className="african-scrim" />
      </div>
      <div className="section-gutter african-content" id="get-started">
        <div className="motion-copy motion-delay-2">
          <p className="eyebrow">Built for a diverse fashion world</p>
          <h2 id="african-heading" className="editorial">
            African fashion.
            <br />
            Global reach.
          </h2>
        </div>
        <p className="african-lede motion-copy motion-delay-3">
          From Ankara to Aso Oke, streetwear to formalwear, Bop supports every fashion culture,
          everywhere.
        </p>
        <a className="btn btn-light motion-copy motion-delay-4" href="#categories">
          Discover Bop
          <ArrowRightIcon />
        </a>
      </div>
      <FashionCategoryRail />
    </MotionSection>
  );
}
