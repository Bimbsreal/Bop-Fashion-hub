export const workspaceRoutes = [
  { href: "/account", label: "Account" },
  { href: "/catalog", label: "Catalog" },
  { href: "/design", label: "Design" },
  { href: "/analysis", label: "Analysis" },
  { href: "/visualize", label: "Visualize" },
  { href: "/try-on", label: "Try-on" },
  { href: "/measure", label: "Measure" },
  { href: "/fit", label: "Fit" },
  { href: "/style", label: "Style" },
  { href: "/commerce", label: "Commerce" },
  { href: "/orders", label: "Orders" },
] as const;

export function workspaceRoute(href: string) {
  return workspaceRoutes.find((route) => route.href === href) ?? null;
}
