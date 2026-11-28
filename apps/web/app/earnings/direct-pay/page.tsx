import { redirect } from "next/navigation";

export default function DirectWorkerPaymentPage() {
  // Keep old bookmarks working while maintaining a single payout workflow.
  redirect("/payments");
}
