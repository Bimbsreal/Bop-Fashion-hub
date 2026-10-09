import { AnalysisDesk } from "@/components/analysis/AnalysisDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function AnalysisPage() {
  return (
    <WorkspaceShell>
      <AnalysisDesk />
    </WorkspaceShell>
  );
}
