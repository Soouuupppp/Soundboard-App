import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { auth, signIn, signOut } from "@/lib/auth";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://soundboard.example.com";
const TITLE = "Soundboard";
const DESCRIPTION = "Discord-authenticated soundboard dashboard — upload, organize, and trigger sounds with global hotkeys.";

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
        <header className="border-b border-border bg-panel/60 backdrop-blur sticky top-0 z-20">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
            <Link href="/" className="font-semibold">🔊 Soundboard</Link>
            {session?.user && (
              <nav className="flex items-center gap-4 text-sm text-muted">
                <Link href="/dashboard" className="hover:text-white">My board</Link>
                <Link href="/public" className="hover:text-white">Public</Link>
                {isAdmin && <Link href="/admin" className="hover:text-white">Admin</Link>}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-3 text-sm">
              {session?.user ? (
                <>
                  <span className="text-muted">{session.user.name}</span>
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
        <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
