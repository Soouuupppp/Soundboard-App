// Thin Google Analytics (gtag.js) wrapper.
//
// GA only loads when NEXT_PUBLIC_GA_MEASUREMENT_ID is set (see app/layout.tsx +
// middleware.ts CSP). When it's absent, window.gtag is undefined and every call
// here is a silent no-op — so call sites don't need to guard.
//
// Each event is tagged with client_type (web vs the Electron desktop wrapper) so
// dashboards can split usage by client. The logged-in user_id is set on the gtag
// `config` (in the layout), so it rides on every event for per-user / use-time
// analysis (the app_open / app_close pair gives a session-duration signal).

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

type Params = Record<string, unknown>;

// The Electron wrapper injects window.soundboard via preload — the same signal
// the dashboard uses to detect the desktop app.
export function clientType(): "electron" | "web" {
  return typeof window !== "undefined" && "soundboard" in window ? "electron" : "web";
}

function track(name: string, params?: Params) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", name, { client_type: clientType(), ...params });
}

export const analytics = {
  // App lifecycle. The close event uses the beacon transport so it still sends
  // while the page is unloading (tab close / Electron window close).
  appOpen: () => track("app_open"),
  appClose: () => track("app_close", { transport_type: "beacon" }),

  // Landing / onboarding funnel (anonymous on the landing page — no user_id yet).
  landing: () => track("landing"), // landed on the site (non-unique)
  login: () => track("login"), // authenticated session started (non-unique)
  tosAccept: () => track("tos_accept"), // accepted the TOS (non-unique)
  newUser: () => track("new_user"), // first-ever TOS acceptance (unique per user)

  // Library growth.
  uploadSound: () => track("upload_sound"),
  importYoutube: () => track("import_youtube"),
  savePublicSound: (soundId: string) => track("save_public_sound", { sound_id: soundId }),

  // Profiles CRUD.
  profileCreate: () => track("profile_create"),
  profileRename: () => track("profile_rename"),
  profileClone: () => track("profile_clone"),
  profileDelete: () => track("profile_delete"),

  // Playback.
  previewSound: (soundId: string) => track("preview_sound", { sound_id: soundId }),
  playSound: (soundId: string) => track("play_sound", { sound_id: soundId }),

  // Saved / board mutations.
  removeFromSaved: (soundId: string) => track("remove_from_saved", { sound_id: soundId }),
  boardAdd: (soundId: string) => track("board_add", { sound_id: soundId }),
  boardRemove: (soundId: string) => track("board_remove", { sound_id: soundId }),
};
