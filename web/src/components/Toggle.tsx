"use client";

// Shared slide toggle (extracted for the 1.4.0 header popovers — Dashboard keeps
// its own private copy). `size="sm"` is a compact variant; `disabled` dims it.
export function Toggle({
  checked,
  onChange,
  label,
  size = "md",
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: "md" | "sm";
  disabled?: boolean;
}) {
  const sm = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
        sm ? "h-5 w-9" : "h-6 w-11"
      } ${checked ? "bg-accent" : "bg-white/15"}`}
    >
      <span
        className={`inline-block transform rounded-full bg-white shadow transition-transform duration-200 ${
          sm
            ? `h-3.5 w-3.5 ${checked ? "translate-x-[18px]" : "translate-x-1"}`
            : `h-4 w-4 ${checked ? "translate-x-6" : "translate-x-1"}`
        }`}
      />
    </button>
  );
}
