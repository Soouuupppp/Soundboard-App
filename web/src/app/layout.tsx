import "./globals.css";
import type { Metadata } from "next";
import { Play } from "next/font/google";
import Link from "next/link";
import Image from "next/image";
import { auth, signIn, signOut } from "@/lib/auth";
import { SiteHeader } from "@/components/SiteHeader";
import { UserMenu } from "@/components/UserMenu";
import { HeaderControls } from "@/components/HeaderControls";
import { ToastProvider } from "@/components/Toast";
import { AudioProvider } from "@/components/AudioProvider";
import { VoiceChangerProvider } from "@/components/VoiceChangerProvider";
import { VrProvider } from "@/components/VrProvider";
import { NoticeBanners, type MotdSeverity } from "@/components/NoticeBanners";
import { getAppSettings } from "@/lib/app-settings";
import logo from "./logo.png";

// App-wide typeface. Play ships only 400 + 700 — `font-medium`/`font-semibold`
// utilities round/synthesize to the nearest available weight. Exposed as
// `--font-play` so globals.css + tailwind's `fontFamily.sans` both pick it up.
const play = Play({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-play",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://soundboard.example.com";
const TITLE = "Soundboard";
const DESCRIPTION = "Upload your sounds, set keybinds, and play them anywhere — even straight into your mic. Log in with Discord and build your board.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // Favicons are provided by the App Router file conventions (app/favicon.ico,
  // app/icon.png, app/apple-icon.png) — Next injects the correct <link> tags.
  // The old metadata pointed at a 1.9 MB favicon.svg that browsers refused to load.
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
  const signedIn = !!session?.user;

  // Notice banners (MOTD + desktop promo) show to signed-in users only; skip the
  // settings read entirely when logged out so the landing stays clean + cheap.
  const settings = session?.user ? await getAppSettings() : null;
  const motd = settings
    ? {
        enabled: settings.motdEnabled,
        message: settings.motdMessage,
        linkLabel: settings.motdLinkLabel,
        linkUrl: settings.motdLinkUrl,
        severity: (settings.motdSeverity as MotdSeverity) ?? "info",
        version: settings.motdUpdatedAt ? String(settings.motdUpdatedAt.getTime()) : "",
      }
    : null;

  // The app shell (header + notice banners + main). Built once and wrapped in the
  // providers below — signed-in users additionally get the AudioProvider so the
  // header controls can drive the engine.
  const shell = (
    <>
      <SiteHeader>
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight flex items-center gap-2">
            <Image src={logo} alt="Soundboard logo" width={32} height={32} priority className="h-8 w-8" />
            <span>Soundboard</span>
          </Link>
          {/* Audio controls (Settings · Voice changer · Sound Effects · meter)
              sit on the LEFT, the gap-6 giving them margin from the logo. The
              avatar dropdown (Admin + Sign out) + quota meter stay right-aligned. */}
          {session?.user && <HeaderControls />}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {session?.user ? (
              <UserMenu
                name={session.user.name ?? null}
                image={session.user.image ?? null}
                isAdmin={isAdmin}
                signOutAction={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              />
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
      </SiteHeader>
      {motd && <NoticeBanners motd={motd} />}
      <main className="max-w-[1800px] mx-auto px-4 py-10">{children}</main>
    </>
  );

  return (
    <html lang="en" className={play.variable}>
      <body>
        {/* Decorative ambient glow. Static on purpose: when these moved, every
            frame shifted the pixels behind the backdrop-blur glass panels, forcing
            a continuous (and costly) backdrop-filter recompute across the whole UI.
            Keeping them still lets the browser cache the blur — same look, ~no
            idle cost. */}
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <div className="absolute -top-32 -left-32 h-[480px] w-[480px] rounded-full bg-accent/20 blur-3xl" />
          <div className="absolute top-1/3 -right-40 h-[520px] w-[520px] rounded-full bg-fuchsia-500/15 blur-3xl" />
          <div className="absolute bottom-[-200px] left-1/3 h-[420px] w-[420px] rounded-full bg-cyan-400/10 blur-3xl" />
        </div>

        {/* The header now hosts the audio controls (Settings · Voice changer ·
            Sound Effects + the output meter), so for signed-in users the whole
            shell — header AND main — lives inside one AudioProvider (a single
            engine that survives navigation). The logged-out landing stays outside
            it so it never enumerates devices / runs the hook. */}
        {signedIn ? (
          <AudioProvider>
            <VoiceChangerProvider>
              <VrProvider>
                <ToastProvider>{shell}</ToastProvider>
              </VrProvider>
            </VoiceChangerProvider>
          </AudioProvider>
        ) : (
          <ToastProvider>{shell}</ToastProvider>
        )}
      </body>
    </html>
  );
}
