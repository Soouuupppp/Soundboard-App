import { redirect } from "next/navigation";
import { auth, isAdminSession } from "@/lib/auth";
import { getUserLimits, canUserUpload } from "@/lib/quota";
import { getAppSettings } from "@/lib/app-settings";
import { Dashboard } from "@/components/Dashboard";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const limits = await getUserLimits(session.user.id);
  const canUpload = isAdminSession(session) || (await canUserUpload(session.user.id));
  const settings = await getAppSettings();

  return (
    <Dashboard
      limits={limits}
      canUpload={canUpload}
      user={{ name: session.user.name ?? "", role: session.user.role ?? null }}
      yt={{ enabled: settings.ytEnabled, maxDurationSec: settings.ytMaxDurationSec }}
    />
  );
}
