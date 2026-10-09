import Link from "next/link";
import { mainNav } from "@/lib/landing-content";

export function LandingFooter() {
  return (
    <footer className="site-footer">
      <div className="section-gutter footer-inner">
        <Link className="footer-brand" href="/">
          Bop
        </Link>
        <nav className="footer-nav" aria-label="Footer">
          {mainNav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
          <a href="#pricing">Pricing</a>
        </nav>
        <p className="footer-note" id="pricing">
          Pricing is published with the commerce release.
        </p>
      </div>
    </footer>
  );
}
