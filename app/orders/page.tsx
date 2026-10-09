import { OrdersDesk } from "@/components/orders/OrdersDesk";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function OrdersPage() {
  return (
    <WorkspaceShell>
      <OrdersDesk />
    </WorkspaceShell>
  );
}
