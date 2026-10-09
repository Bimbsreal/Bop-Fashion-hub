import { heroStats } from "@/lib/landing-content";

export function HeroStats() {
  return (
    <ul className="hero-stats" aria-label="Platform reach">
      {heroStats.map((stat) => (
        <li key={stat.id} className="hero-stat">
          <p className="hero-stat-value">{stat.value}</p>
          <p className="hero-stat-label">{stat.label}</p>
        </li>
      ))}
    </ul>
  );
}
