"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { workspaceRoutes } from "@/lib/workspace-routes";

export function WorkspaceNav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-ink/15 bg-ivory" aria-label="Workspace">
      <div className="mx-auto flex max-w-5xl items-center gap-4 overflow-x-auto px-5 py-3">
        <Link className="font-editorial text-xl text-ink" href="/">
          Bop
        </Link>
        <ul className="flex min-w-0 gap-3 text-sm">
          {workspaceRoutes.map((route) => {
            const current = pathname === route.href;
            return (
              <li key={route.href}>
                <Link
                  className={current ? "text-ink underline" : "text-muted"}
                  href={route.href}
                  aria-current={current ? "page" : undefined}
                >
                  {route.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
