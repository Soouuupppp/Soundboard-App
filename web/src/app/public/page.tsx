import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PublicBrowse } from "@/components/PublicBrowse";

export default async function PublicPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  return <PublicBrowse />;
}
