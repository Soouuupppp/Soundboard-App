import { redirect } from "next/navigation";
import { auth, isAdminSession } from "@/lib/auth";
import { AdminPanel } from "@/components/AdminPanel";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  if (!isAdminSession(session)) redirect("/dashboard");
  return <AdminPanel />;
}
