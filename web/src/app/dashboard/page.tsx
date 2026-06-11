import { redirect } from "next/navigation";
import { auth, isAdminSession } from "@/lib/auth";
import { getUserLimits, canUserUpload } from "@/lib/quota";
import { getYtConfigForUser } from "@/lib/app-settings";
import { Dashboard } from "@/components/Dashboard";
import pkg from "../../../package.json";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const limits = await getUserLimits(session.user.id);
  const canUpload = isAdminSession(session) || (await canUserUpload(session.user.id));
  const yt = await getYtConfigForUser(session.user.id);

  return (
    <Dashboard
      limits={limits}
      canUpload={canUpload}
      user={{ id: session.user.id, name: session.user.name ?? "", role: session.user.role ?? null }}
      yt={{ enabled: yt.enabled, maxDurationSec: yt.maxDurationSec }}
      appVersion={pkg.version}
    />
  );
}
