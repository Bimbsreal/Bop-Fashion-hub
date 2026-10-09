import { WorkspaceNav } from "@/components/workspace/WorkspaceNav";

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-ivory text-ink">
      <WorkspaceNav />
      {children}
    </div>
  );
}
