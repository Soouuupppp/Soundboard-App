"use client";

// Profile switcher (1.4.1) — the right-cluster dropdown between the user menu and
// the quota bar. The button shows the active profile's name; the menu lists every
// profile (click a non-active row to switch), with per-row inline rename, clone,
// delete (confirm; hidden when only one profile), and move up/down reorder. A
// trailing input creates a new empty profile, disabled at the role/override cap.
// All mutations go through ProfileProvider's API helpers; failures route to toast.

import { useState } from "react";
import {
  ChevronDown,
  Check,
  X,
  Pencil,
  Copy,
  Trash2,
  ChevronUp,
  ChevronDown as ChevronDownIcon,
  Plus,
  Star,
} from "lucide-react";
import { Popover } from "@/components/Popover";
import { useProfiles } from "@/components/ProfileProvider";
import { useToast } from "@/components/Toast";

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

export function ProfileSwitcher() {
  const {
    profiles,
    activeProfileId,
    limit,
    loading,
    setActiveProfile,
    createProfile,
    renameProfile,
    cloneProfile,
    deleteProfile,
    reorderProfile,
  } = useProfiles();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const ordered = [...profiles].sort((a, b) => a.position - b.position);
  const active = profiles.find((p) => p.id === activeProfileId) ?? null;
  const atCap = profiles.length >= limit;

  const startEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const commitEdit = async () => {
    const id = editingId;
    const name = editName.trim();
    if (!id) return;
    if (!name || name === profiles.find((p) => p.id === id)?.name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    const res = await renameProfile(id, name);
    setBusy(false);
    if (!res.ok) return void toast.fromResponse(res, "Couldn't rename profile.");
    setEditingId(null);
  };

  const onClone = async (id: string) => {
    setBusy(true);
    const res = await cloneProfile(id);
    setBusy(false);
    if (!res.ok) return void toast.fromResponse(res, "Couldn't clone profile.");
  };

  const onDelete = async (id: string, name: string) => {
    if (!confirm(`Delete profile "${name}"? Its board layout, binds and effects are removed.`)) return;
    setBusy(true);
    const res = await deleteProfile(id);
    setBusy(false);
    if (!res.ok) return void toast.fromResponse(res, "Couldn't delete profile.");
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || atCap) return;
    setBusy(true);
    const res = await createProfile(name);
    setBusy(false);
    if (!res.ok) return void toast.fromResponse(res, "Couldn't create profile.");
    setNewName("");
  };

  return (
    <Popover
      open={open}
      onClose={() => {
        setOpen(false);
        setEditingId(null);
      }}
      align="right"
      panelClassName="w-72 max-w-[calc(100vw-1.5rem)] p-1.5"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch profile"
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 h-9 text-sm text-muted transition hover:bg-white/[0.08] hover:text-white max-w-[10rem]"
        >
          <span className="truncate">{loading ? "…" : active?.name ?? "Profile"}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      }
    >
      <div className="flex flex-col gap-0.5">
        {ordered.map((p, i) => {
          const isActive = p.id === activeProfileId;
          const editing = editingId === p.id;
          return (
            <div
              key={p.id}
              className={`flex items-center gap-1 rounded-md px-1.5 py-1 ${
                isActive ? "bg-accent/15" : "hover:bg-white/5"
              }`}
            >
              {editing ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                    maxLength={60}
                    className="input flex-1 min-w-0 h-7 px-2 py-0 text-sm"
                  />
                  <IconBtn title="Save" onClick={commitEdit} disabled={busy}>
                    <Check size={13} />
                  </IconBtn>
                  <IconBtn title="Cancel" onClick={() => setEditingId(null)}>
                    <X size={13} />
                  </IconBtn>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) setActiveProfile(p.id);
                      setOpen(false);
                    }}
                    className="flex flex-1 min-w-0 items-center gap-1.5 text-left text-sm"
                    title={isActive ? "Active profile" : `Switch to "${p.name}"`}
                  >
                    {isActive ? (
                      <Star size={12} className="shrink-0 text-accent fill-accent" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className={`truncate ${isActive ? "text-white" : "text-muted"}`}>{p.name}</span>
                  </button>
                  <div className="flex items-center">
                    <IconBtn
                      title="Move up"
                      onClick={() => reorderProfile(p.id, -1)}
                      disabled={busy || i === 0}
                    >
                      <ChevronUp size={13} />
                    </IconBtn>
                    <IconBtn
                      title="Move down"
                      onClick={() => reorderProfile(p.id, 1)}
                      disabled={busy || i === ordered.length - 1}
                    >
                      <ChevronDownIcon size={13} />
                    </IconBtn>
                    <IconBtn title="Rename" onClick={() => startEdit(p.id, p.name)} disabled={busy}>
                      <Pencil size={12} />
                    </IconBtn>
                    <IconBtn title="Clone" onClick={() => onClone(p.id)} disabled={busy || atCap}>
                      <Copy size={12} />
                    </IconBtn>
                    {ordered.length > 1 && (
                      <IconBtn title="Delete" onClick={() => onDelete(p.id, p.name)} disabled={busy}>
                        <Trash2 size={12} />
                      </IconBtn>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {/* Create-new row + cap status. */}
        <div className="mt-1 border-t border-white/10 pt-1.5">
          <div className="flex items-center gap-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
              }}
              placeholder={atCap ? "Profile limit reached" : "New profile name…"}
              maxLength={60}
              disabled={atCap || busy}
              className="input flex-1 min-w-0 h-7 px-2 py-0 text-sm disabled:opacity-50"
            />
            <IconBtn title="Create profile" onClick={onCreate} disabled={atCap || busy || !newName.trim()}>
              <Plus size={14} />
            </IconBtn>
          </div>
          <div className="px-1 pt-1 text-[10px] text-muted">
            {profiles.length} / {limit} profiles
          </div>
        </div>
      </div>
    </Popover>
  );
}
