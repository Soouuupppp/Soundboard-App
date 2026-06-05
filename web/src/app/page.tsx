import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <div className="max-w-xl mx-auto text-center py-20">
      <h1 className="text-4xl font-bold mb-4">Your personal soundboard</h1>
      <p className="text-muted mb-8">
        Upload mp3s, organize them on a board, assign keybinds, share publicly.
        Use the desktop wrapper for keybinds that work even when the browser isn&apos;t focused.
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("discord", { redirectTo: "/dashboard" });
        }}
      >
        <button className="btn-primary">Login with Discord to get started</button>
      </form>
    </div>
  );
}
