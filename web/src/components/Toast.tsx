"use client";

// App-wide toast notifications. A single provider (mounted in the root layout)
// exposes useToast(); any client component below it can surface success/info and
// — most importantly — *errors* that previously failed silently. The
// `fromResponse` helper turns a failed `fetch` Response into a user-facing
// message (reading the API's `{ error }` body, with a friendly 429 case), so call
// sites collapse to: `if (!res.ok) return toast.fromResponse(res, "fallback");`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastKind = "error" | "success" | "info";
type Toast = { id: number; kind: ToastKind; message: string };

type ToastApi = {
  notify: (message: string, kind?: ToastKind) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  /** Surface an error read from a failed fetch Response ({ error } JSON). */
  fromResponse: (res: Response, fallback: string) => Promise<void>;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = ++counter.current;
      setToasts((t) => [...t, { id, kind, message }]);
      // Errors linger a little longer so they aren't missed.
      const ttl = kind === "error" ? 6000 : 4000;
      setTimeout(() => remove(id), ttl);
    },
    [remove]
  );

  const error = useCallback((m: string) => notify(m, "error"), [notify]);
  const success = useCallback((m: string) => notify(m, "success"), [notify]);
  const info = useCallback((m: string) => notify(m, "info"), [notify]);

  const fromResponse = useCallback(
    async (res: Response, fallback: string) => {
      if (res.status === 429) {
        notify("You're doing that too fast — please wait a moment and try again.", "error");
        return;
      }
      let msg = fallback;
      try {
        const j = await res.json();
        if (j && typeof j.error === "string" && j.error) msg = j.error;
      } catch {
        /* non-JSON body — keep the fallback */
      }
      notify(msg, "error");
    },
    [notify]
  );

  // Memoize so the context value is a stable reference — consumers put `toast` in
  // useCallback/useEffect dependency arrays, and the callbacks below are all
  // useCallback-stable, so this never changes after mount.
  const api = useMemo<ToastApi>(
    () => ({ notify, error, success, info, fromResponse }),
    [notify, error, success, info, fromResponse]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

// Convenience hook for the common mutate pattern: fire a fetch, toast on a
// network error or a non-OK response (reading the API's { error } body), and
// return true only on success so callers gate their refresh/onChange on it.
export function useMutate() {
  const toast = useToast();
  return useCallback(
    async (url: string, init: RequestInit, failMsg: string): Promise<boolean> => {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch {
        toast.error("Network error — check your connection and try again.");
        return false;
      }
      if (!res.ok) {
        await toast.fromResponse(res, failMsg);
        return false;
      }
      return true;
    },
    [toast]
  );
}

const KIND_STYLES: Record<ToastKind, { ring: string; icon: ReactNode }> = {
  error: { ring: "border-red-500/40", icon: <AlertCircle size={16} className="text-red-400" /> },
  success: { ring: "border-emerald-500/40", icon: <CheckCircle2 size={16} className="text-emerald-400" /> },
  info: { ring: "border-white/15", icon: <Info size={16} className="text-accent" /> },
};

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => {
        const s = KIND_STYLES[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`flex items-start gap-2.5 rounded-xl border ${s.ring} bg-black/70 backdrop-blur-xl px-3.5 py-2.5 text-sm text-white shadow-lg`}
          >
            <span className="mt-0.5 shrink-0">{s.icon}</span>
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="shrink-0 text-muted hover:text-white transition"
              aria-label="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
