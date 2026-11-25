import { redirect } from "next/navigation";

export default function Page() {
  redirect("/settings?tab=password-reset-requests");
}
