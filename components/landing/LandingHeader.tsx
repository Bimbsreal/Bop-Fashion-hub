"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CloseIcon,
  MenuIcon,
  SearchIcon,
} from "@/components/landing/icons";
import { getLandingAsset } from "@/lib/landing-assets";
import {
  exploreLinks,
  fashionCategories,
  fashionJourney,
  mainNav,
} from "@/lib/landing-content";

const searchIndex = [
  ...mainNav.map((item) => ({ ...item, hint: "Audience" })),
  ...exploreLinks.map((item) => ({ ...item, hint: "Explore" })),
  ...fashionJourney.map((step) => ({
    label: step.title,
    href: `#${step.id}`,
    hint: "Journey",
  })),
  ...fashionCategories.map((category) => ({
    label: category.label,
    href: "#categories",
    hint: "Category",
  })),
];

export function LandingHeader() {
  const logo = getLandingAsset("logo");
  const [menuOpen, setMenuOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDialogElement>(null);
  const accountRef = useRef<HTMLDialogElement>(null);
  const searchId = useId();
  const exploreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const results = searchIndex.filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return entry.label.toLowerCase().includes(needle) || entry.hint.toLowerCase().includes(needle);
  });

  function closeMenus() {
    setMenuOpen(false);
    setExploreOpen(false);
  }

  return (
    <header className="site-header">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="header-inner">
        <Link className="logo-link" href="/" aria-label="Bop home">
          {logo.src ? (
            <Image src={logo.src} alt={logo.alt} width={92} height={32} priority />
          ) : (
            <span className="logo-word">Bop</span>
          )}
        </Link>

        <nav className="primary-nav" aria-label="Primary">
          {mainNav.map((item) => (
            <a key={item.href} className="nav-link" href={item.href}>
              {item.label}
            </a>
          ))}
          <div
            className="explore"
            ref={exploreRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setExploreOpen(false);
              }
            }}
          >
            <button
              type="button"
              className="explore-trigger"
              aria-expanded={exploreOpen}
              aria-controls="explore-menu"
              onClick={() => setExploreOpen((open) => !open)}
            >
              Explore
              <ChevronDownIcon />
            </button>
            {exploreOpen ? (
              <ul id="explore-menu" className="explore-menu">
                {exploreLinks.map((item) => (
                  <li key={item.href + item.label}>
                    <a href={item.href} onClick={closeMenus}>
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <a className="nav-link" href="#pricing">
            Pricing
          </a>
        </nav>

        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Search Bop"
            onClick={() => searchRef.current?.showModal()}
          >
            <SearchIcon />
          </button>
          <button type="button" className="header-text-btn header-signin" onClick={() => accountRef.current?.showModal()}>
            Sign in
          </button>
          <a className="btn btn-dark btn-header" href="#get-started">
            Get started
          </a>
          <button
            type="button"
            className="icon-btn menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
            <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
      </div>

      <nav id="mobile-nav" className="mobile-nav" aria-label="Mobile" hidden={!menuOpen}>
        {mainNav.map((item) => (
          <a key={item.href} href={item.href} onClick={closeMenus}>
            {item.label}
          </a>
        ))}
        {exploreLinks.map((item) => (
          <a key={item.label} className="mobile-sub" href={item.href} onClick={closeMenus}>
            {item.label}
          </a>
        ))}
        <a href="#pricing" onClick={closeMenus}>
          Pricing
        </a>
        <button type="button" onClick={() => accountRef.current?.showModal()}>
          Sign in
        </button>
        <a href="#get-started" onClick={closeMenus}>
          Get started
          <ArrowRightIcon />
        </a>
      </nav>

      <dialog ref={searchRef} className="search-dialog" aria-labelledby={searchId}>
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label className="sr-only" id={searchId} htmlFor={`${searchId}-input`}>
            Search styles, makers, and categories
          </label>
          <input
            id={`${searchId}-input`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search styles, makers, and categories"
          />
          <button type="button" className="dialog-close" onClick={() => searchRef.current?.close()}>
            Close
          </button>
        </form>
        <ul className="search-results">
          {results.length === 0 ? (
            <li className="search-hint">Nothing on this page matches that search.</li>
          ) : (
            results.slice(0, 8).map((entry) => (
              <li key={`${entry.hint}-${entry.label}`}>
                <a
                  href={entry.href}
                  onClick={() => {
                    searchRef.current?.close();
                    closeMenus();
                  }}
                >
                  <span>{entry.label}</span>
                  <span className="search-hint">{entry.hint}</span>
                </a>
              </li>
            ))
          )}
        </ul>
      </dialog>

      <dialog ref={accountRef} className="account-dialog" aria-labelledby="account-title">
        <h2 id="account-title" className="editorial" style={{ margin: 0, fontSize: "2rem" }}>
          Sign in
        </h2>
        <p>
          Bop accounts open with the platform. This page is the public fashion experience.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn-dark" onClick={() => accountRef.current?.close()}>
            Close
          </button>
          <a className="btn btn-light" href="/account">
            Open account
          </a>
          <a href="#get-started" onClick={() => accountRef.current?.close()}>
            Get started
          </a>
        </div>
      </dialog>
    </header>
  );
}
