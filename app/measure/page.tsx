import { MeasureDesk } from "@/components/measure/MeasureDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function MeasurePage() {
  return (
    <WorkspaceShell>
      <MeasureDesk />
    </WorkspaceShell>
  );
}
