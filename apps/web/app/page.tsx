import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import HomeDashboard from "./home-dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const session = cookieStore.get("tezkar_session")?.value;
  if (!session) redirect("/login");
  return <HomeDashboard />;
}
