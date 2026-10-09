import { DesignDesk } from "@/components/workspace/DesignDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function DesignPage() {
  return (
    <WorkspaceShell>
      <DesignDesk />
    </WorkspaceShell>
  );
}
