import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { LandingAnalytics } from "@/components/LandingAnalytics";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <div className="max-w-2xl mx-auto text-center py-20">
      <LandingAnalytics />
      <div className="inline-flex items-center gap-2 chip mb-6">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Built for streamers, gamers & meme-lords
      </div>
      <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-4 bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
        Your personal soundboard
      </h1>
      <p className="text-muted text-lg mb-10 max-w-xl mx-auto">
        Upload mp3s, organize them on a board, assign global hotkeys, and share publicly.
        Use the desktop wrapper for keybinds that fire even when the browser isn&apos;t focused.
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("discord", { redirectTo: "/dashboard" });
        }}
      >
        <button className="btn-primary px-5 py-3 text-base">Login with Discord to get started</button>
      </form>
    </div>
  );
}
