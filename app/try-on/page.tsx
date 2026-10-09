import { TryOnDesk } from "@/components/try-on/TryOnDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function TryOnPage() {
  return (
    <WorkspaceShell>
      <TryOnDesk />
    </WorkspaceShell>
  );
}
