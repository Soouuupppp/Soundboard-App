"use client";

// Terms-of-Service gate. Rendered by the root layout (instead of the app shell)
// for a signed-in user whose accepted TOS version is below the current one — i.e.
// a brand-new user, or any user after the TOS is updated (TOS_VERSION bump).
//
//   Accept → POST /api/tos/accept (marks the user in the DB) → router.refresh()
//            re-reads the gate server-side and renders the dashboard.
//   Reject → the layout's signOut server action → back to the landing page.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Ban, AlertTriangle, Mic, BarChart3, ExternalLink } from "lucide-react";
import { AI_VOICE_PROVIDERS } from "@/lib/tos";
import { analytics } from "@/lib/analytics";

export function TosGate({ signOutAction }: { signOutAction: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tos/accept", { method: "POST" });
      if (!res.ok) {
        setErr("Couldn't record your acceptance — please try again.");
        setBusy(false);
        return;
      }
      const j = await res.json().catch(() => ({}));
      analytics.tosAccept();
      if (j?.firstTime) analytics.newUser(); // unique: first-ever acceptance
      router.refresh(); // re-reads the gate → renders the dashboard
    } catch {
      setErr("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm p-4">
      <div className="card w-full max-w-xl max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={20} className="text-accent shrink-0" />
          <h2 className="text-xl font-semibold tracking-tight">Terms of Service</h2>
        </div>
        <p className="text-sm text-muted mb-4">
          Please review and accept these terms to continue using Soundboard.
        </p>

        <ul className="space-y-3 text-sm">
          <li className="flex gap-2.5">
            <Ban size={16} className="text-red-400 shrink-0 mt-0.5" />
            <span>Uploading illegal content is forbidden and will result in a ban.</span>
          </li>
          <li className="flex gap-2.5">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <span>Zero tolerance for abuse of this service or app.</span>
          </li>
          <li className="flex gap-2.5">
            <Mic size={16} className="text-fuchsia-300 shrink-0 mt-0.5" />
            <span>
              The AI voice features are optional. If you enable them, your audio (and, for the
              re-speak feature, the transcribed text) is sent to third-party providers for
              processing — so using them means we share that content with them:
              <span className="mt-2 grid gap-1.5">
                {AI_VOICE_PROVIDERS.map((p) => (
                  <span key={p.name} className="block rounded-md bg-white/[0.04] border border-white/10 px-2.5 py-1.5">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted"> — {p.note}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      <TosLink href={p.url}>Website</TosLink>
                      <TosLink href={p.terms}>Terms</TosLink>
                      <TosLink href={p.privacy}>Privacy</TosLink>
                    </span>
                  </span>
                ))}
              </span>
            </span>
          </li>
          <li className="flex gap-2.5">
            <BarChart3 size={16} className="text-cyan-300 shrink-0 mt-0.5" />
            <span>
              We use basic analytics (Google Analytics) to understand app usage and improve
              features. <span className="font-medium">We will never sell your data.</span> See{" "}
              <TosLink href="https://policies.google.com/privacy">Google&apos;s Privacy Policy</TosLink>{" "}
              for how Google processes this data.
            </span>
          </li>
        </ul>

        {err && <p className="text-red-300 text-sm mt-3">{err}</p>}

        <div className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-white/10">
          <form action={signOutAction}>
            <button type="submit" className="btn-ghost text-sm" disabled={busy}>
              Reject
            </button>
          </form>
          <button type="button" className="btn-primary text-sm" onClick={accept} disabled={busy}>
            <ShieldCheck size={15} className="mr-1" /> {busy ? "Saving…" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TosLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-accent hover:underline"
    >
      {children} <ExternalLink size={11} />
    </a>
  );
}
