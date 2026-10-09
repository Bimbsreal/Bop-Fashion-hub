import { AfricanFashionSection } from "@/components/landing/AfricanFashionSection";
import { AudienceSection } from "@/components/landing/AudienceSection";
import { EcosystemIntro } from "@/components/landing/EcosystemIntro";
import { FashionJourney } from "@/components/landing/FashionJourney";
import { HeroSection } from "@/components/landing/HeroSection";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHeader } from "@/components/landing/LandingHeader";

export default function HomePage() {
  return (
    <>
      <LandingHeader />
      <main id="content">
        <HeroSection />
        <EcosystemIntro />
        <FashionJourney />
        <AudienceSection />
        <AfricanFashionSection />
      </main>
      <LandingFooter />
    </>
  );
}
