import { VisualizationDesk } from "@/components/visualize/VisualizationDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function VisualizePage() {
  return (
    <WorkspaceShell>
      <VisualizationDesk />
    </WorkspaceShell>
  );
}
