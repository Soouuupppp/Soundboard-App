import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { auth, signIn, signOut } from "@/lib/auth";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://soundboard.example.com";
const TITLE = "Soundboard";
const DESCRIPTION = "Upload your sounds, set keybinds, and play them anywhere — even straight into your mic. Log in with Discord and build your board.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: TITLE,
    images: [
      {
        url: "/web-app-manifest-512x512.png",
        width: 512,
        height: 512,
        alt: "Soundboard logo",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/web-app-manifest-512x512.png"],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const isAdmin = session?.user?.role === "admin";

  return (
    <html lang="en">
      <body>
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <div className="absolute -top-32 -left-32 h-[480px] w-[480px] rounded-full bg-accent/20 blur-3xl animate-floatSlow" />
          <div className="absolute top-1/3 -right-40 h-[520px] w-[520px] rounded-full bg-fuchsia-500/15 blur-3xl animate-floatSlow" style={{ animationDelay: "3s" }} />
          <div className="absolute bottom-[-200px] left-1/3 h-[420px] w-[420px] rounded-full bg-cyan-400/10 blur-3xl animate-floatSlow" style={{ animationDelay: "6s" }} />
        </div>

        <header className="sticky top-0 z-20 border-b border-white/5 bg-black/30 backdrop-blur-xl">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
            <Link href="/" className="font-semibold tracking-tight flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent-grad shadow-glow">
                <span className="text-sm">🔊</span>
              </span>
              <span>Soundboard</span>
            </Link>
            {session?.user && (
              <nav className="flex items-center gap-1 text-sm">
                <NavLink href="/dashboard">My board</NavLink>
                <NavLink href="/public">Public</NavLink>
                {isAdmin && <NavLink href="/admin">Admin</NavLink>}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-3 text-sm">
              {session?.user ? (
                <>
                  <span className="text-muted hidden sm:inline">{session.user.name}</span>
                  <form
                    action={async () => {
                      "use server";
                      await signOut({ redirectTo: "/" });
                    }}
                  >
                    <button className="btn-ghost">Sign out</button>
                  </form>
                </>
              ) : (
                <form
                  action={async () => {
                    "use server";
                    await signIn("discord", { redirectTo: "/dashboard" });
                  }}
                >
                  <button className="btn-primary">Login with Discord</button>
                </form>
              )}
            </div>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 py-10">{children}</main>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded-lg text-muted hover:text-white hover:bg-white/[0.06] transition"
    >
      {children}
    </Link>
  );
}
