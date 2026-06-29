// Terms of Service — shared constants (client-safe: no DB imports).
//
// TOS_VERSION gates re-acceptance: when a user's stored user.tosAcceptedVersion
// is below this, they're re-prompted by <TosGate> on next launch. BUMP THIS
// whenever the TOS wording below (TosGate) materially changes.
export const TOS_VERSION = 1;

// Third-party AI voice providers the app can send audio/text to (the voice
// changer's AI paths). Surfaced in the TOS so users know what leaves their
// machine. Keep this list in sync with the "AI voice providers" section in
// CLAUDE.md and with lib/voice-ai*.ts.
export type AiVoiceProvider = {
  name: string;
  // What we send them and when.
  note: string;
  url: string;
  terms: string;
  privacy: string;
};

export const AI_VOICE_PROVIDERS: AiVoiceProvider[] = [
  {
    name: "Hugging Face (rvc_zero)",
    note: "free preset voices — your push-to-talk audio is uploaded for conversion",
    url: "https://huggingface.co",
    terms: "https://huggingface.co/terms-of-service",
    privacy: "https://huggingface.co/privacy",
  },
  {
    name: "ElevenLabs",
    note: "paid voice conversion / text-to-speech (only if you enable it)",
    url: "https://elevenlabs.io",
    terms: "https://elevenlabs.io/terms-of-use",
    privacy: "https://elevenlabs.io/privacy",
  },
  {
    name: "Respeecher",
    note: "paid voice conversion (only if you enable it)",
    url: "https://www.respeecher.com",
    terms: "https://www.respeecher.com/marketplace/terms-of-use",
    privacy: "https://www.respeecher.com/privacy-policy",
  },
];
