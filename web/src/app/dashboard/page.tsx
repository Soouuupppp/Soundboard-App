import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserLimits, getUsedBytes } from "@/lib/quota";
import { Dashboard } from "@/components/Dashboard";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const limits = await getUserLimits(session.user.id);
  const used = await getUsedBytes(session.user.id);

  return (
    <Dashboard
      limits={limits}
      used={used}
      user={{ name: session.user.name ?? "", role: session.user.role ?? null }}
    />
  );
}
