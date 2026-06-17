"use client";

// ver/1.4.1 STT→TTS "re-speak" — the SPEECH-TO-TEXT half. A thin wrapper over the
// browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition). Audio is
// recognized by the browser (in Chrome, sent to Google's speech service) and the
// resulting TEXT is then sent to the paid TTS provider — both leave the machine, so
// the UI must disclose it.
//
// ⚠️ Electron: the Chromium build bundled by Electron ships NO Google speech API
// key, so SpeechRecognition typically does nothing there. sttSupported() lets the
// UI gate the re-speak feature to the web build and explain why.

export const STT_PRIVACY =
  "Speech recognition runs in your browser (Chrome sends the audio to Google); the recognized text is then sent to the TTS provider — both leave your machine.";

// The two non-standard constructors live on window; type loosely (no DOM lib types
// for SpeechRecognition in this tsconfig).
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

function ctor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function sttSupported(): boolean {
  return ctor() !== null;
}

export type SttHandle = { stop: () => void };

export type SttCallbacks = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void; // fired on `onend` with the accumulated final text
  onError?: (err: string) => void;
};

// Start recognition. Returns a handle whose stop() ends listening (which delivers
// onFinal via the recognizer's `onend`). Returns null when unsupported / failed.
export function startStt(cb: SttCallbacks, lang = "en-US"): SttHandle | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    cb.onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e) => cb.onError?.(String(e?.error || "speech recognition error"));
  rec.onend = () => cb.onFinal?.(finalText.trim());
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}
