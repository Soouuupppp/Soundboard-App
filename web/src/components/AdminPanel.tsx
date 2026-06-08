"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Shield, Users, Trash2, Plus, Search, AlertCircle, Music, Play, Globe, Lock, ChevronDown, Upload, Ban } from "lucide-react";
import { formatBytes, parseSize } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";

type Role = {
  id: string;
  name: string;
  defaultMaxFileSize: number;
  defaultMaxTotalStorage: number;
  canUpload: boolean;
  isSystem: boolean;
};
type User = {
  id: string;
  name: string | null;
  image: string | null;
  discordId: string | null;
  roleId: string | null;
  roleName: string | null;
  roleCanUpload: boolean | null;
  maxFileSizeOverride: number | null;
  maxTotalStorageOverride: number | null;
  canUploadOverride: boolean | null;
};
type Sound = {
  id: string;
  name: string;
  originalFilename: string;
  sizeBytes: number;
  isPublic: boolean;
  createdAt: string;
  ownerId: string;
  ownerName: string | null;
  ownerImage: string | null;
  ownerDiscordId: string | null;
  boardCount: number;
};

export function AdminPanel() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [r, u, s] = await Promise.all([
      fetch("/api/admin/roles").then((x) => x.json()),
      fetch("/api/admin/users").then((x) => x.json()),
      fetch("/api/admin/sounds").then((x) => x.json()),
    ]);
    setRoles(r.roles ?? []);
    setUsers(u.users ?? []);
    setSounds(s.sounds ?? []);
    setLoading(false);
  };

  const totalStorage = useMemo(
    () => sounds.reduce((acc, s) => acc + s.sizeBytes, 0),
    [sounds]
  );
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-muted mt-1">Manage roles, quotas, users, and uploaded content.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Stat label="Roles" value={loading ? "…" : String(roles.length)} />
          <Stat label="Users" value={loading ? "…" : String(users.length)} />
          <Stat label="Sounds" value={loading ? "…" : String(sounds.length)} />
          <Stat label="Storage" value={loading ? "…" : formatBytes(totalStorage)} />
        </div>
      </header>

      <Section
        icon={<Shield size={16} />}
        title="Roles & quotas"
        subtitle="Quotas accept human sizes like 5 MB, 1.5 GB, 250 KB. Plain numbers are treated as bytes."
        count={loading ? undefined : roles.length}
      >
        <RolesTable roles={roles} onChange={refresh} />
      </Section>

      <Section
        icon={<Users size={16} />}
        title="Users"
        subtitle="Assign roles or override individual quotas. Leave overrides blank to use the role default."
        count={loading ? undefined : users.length}
      >
        <UsersTable users={users} roles={roles} onChange={refresh} />
      </Section>

      <Section
        icon={<Music size={16} />}
        title="Content"
        subtitle="Every uploaded sound. Preview to review, flip public clips private, or delete violating content."
        count={loading ? undefined : sounds.length}
      >
        <SoundsTable sounds={sounds} onChange={refresh} />
      </Section>
    </div>
  );
}

// A collapsible admin sub-panel. Collapsed by default so the page opens as a
// compact list of sections the admin can expand one at a time.
function Section({
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card !p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 text-left px-5 py-4 hover:bg-white/[0.02] transition"
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] border border-white/10 text-accent">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="section-title flex items-center gap-2">
            {title}
            {count !== undefined && <span className="chip">{count}</span>}
          </h2>
          {subtitle && <p className="section-sub">{subtitle}</p>}
        </div>
        <ChevronDown
          size={18}
          className={`text-muted shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      <Collapsible open={open}>
        <div className="px-5 pb-5 pt-1">{children}</div>
      </Collapsible>
    </section>
  );
}

// Animated show/hide using a 0fr↔1fr grid row (no fixed height needed).
function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-all duration-200 ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card !p-3 !rounded-xl text-center min-w-[88px]">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
    </div>
  );
}

// Slide toggle switch.
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? "bg-accent" : "bg-white/15"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function RolesTable({ roles, onChange }: { roles: Role[]; onChange: () => void }) {
  async function update(role: Role, patch: Partial<Role>) {
    await fetch(`/api/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    onChange();
  }
  async function remove(role: Role) {
    if (role.isSystem) return;
    if (!confirm(`Delete role "${role.name}"?`)) return;
    await fetch(`/api/admin/roles/${role.id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-3 py-3 font-medium">Max file size</th>
              <th className="px-3 py-3 font-medium">Max total storage</th>
              <th className="px-3 py-3 font-medium">Can upload</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    {r.isSystem && <span className="chip">system</span>}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <SizeInput
                    value={r.defaultMaxFileSize}
                    onCommit={(v) => update(r, { defaultMaxFileSize: v })}
                  />
                </td>
                <td className="px-3 py-3">
                  <SizeInput
                    value={r.defaultMaxTotalStorage}
                    onCommit={(v) => update(r, { defaultMaxTotalStorage: v })}
                  />
                </td>
                <td className="px-3 py-3">
                  <Toggle
                    checked={r.canUpload}
                    onChange={(next) => update(r, { canUpload: next })}
                    label={`Toggle uploads for ${r.name}`}
                  />
                </td>
                <td className="px-5 py-3 text-right">
                  {!r.isSystem && (
                    <button
                      className="btn-ghost text-xs !text-red-300 hover:!text-red-200 hover:!bg-red-500/10 !border-red-400/20"
                      onClick={() => remove(r)}
                    >
                      <Trash2 size={13} className="mr-1" /> Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NewRoleForm onCreated={onChange} />
    </div>
  );
}

function NewRoleForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState("5 MB");
  const [total, setTotal] = useState("50 MB");
  const [canUpload, setCanUpload] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("Name is required");
    const f = parseSize(file);
    const t = parseSize(total);
    if (f == null) return setErr("Max file size is invalid (try '5 MB')");
    if (t == null) return setErr("Max total storage is invalid (try '50 MB')");
    setBusy(true);
    await fetch("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, defaultMaxFileSize: f, defaultMaxTotalStorage: t, canUpload }),
    });
    setBusy(false);
    setName("");
    setCanUpload(true);
    onCreated();
  }

  return (
    <form
      onSubmit={create}
      className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto] items-end p-5 border-t border-white/5 bg-white/[0.015]"
    >
      <Field label="New role name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="vip"
        />
      </Field>
      <Field label="Max file size">
        <input className="input" value={file} onChange={(e) => setFile(e.target.value)} />
      </Field>
      <Field label="Max total storage">
        <input className="input" value={total} onChange={(e) => setTotal(e.target.value)} />
      </Field>
      <Field label="Can upload">
        <div className="input flex items-center justify-center !px-3">
          <Toggle checked={canUpload} onChange={setCanUpload} label="Allow uploads for the new role" />
        </div>
      </Field>
      <button className="btn-primary justify-center" disabled={busy}>
        <Plus size={14} className="mr-1" /> Create
      </button>
      {err && (
        <p className="sm:col-span-5 text-xs text-red-300 flex items-center gap-1.5">
          <AlertCircle size={13} /> {err}
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

function UsersTable({
  users,
  roles,
  onChange,
}: {
  users: User[];
  roles: Role[];
  onChange: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return users;
    return users.filter(
      (u) =>
        (u.name ?? "").toLowerCase().includes(n) ||
        (u.discordId ?? "").toLowerCase().includes(n) ||
        (u.roleName ?? "").toLowerCase().includes(n)
    );
  }, [users, q]);

  async function update(u: User, patch: Partial<User>) {
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    onChange();
  }

  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9"
            placeholder="Search users"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted">
          {filtered.length} / {users.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[920px]">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-3 py-3 font-medium">Discord ID</th>
              <th className="px-3 py-3 font-medium">Role</th>
              <th className="px-3 py-3 font-medium">Uploads</th>
              <th className="px-3 py-3 font-medium">Max file override</th>
              <th className="px-5 py-3 font-medium">Max total override</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-white/5 align-middle">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    {u.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.image} alt="" className="h-7 w-7 rounded-full border border-white/10" />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-white/5 border border-white/10" />
                    )}
                    <span className="font-medium">{u.name ?? "(no name)"}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-muted text-xs font-mono">{u.discordId ?? "—"}</td>
                <td className="px-3 py-3">
                  <select
                    className="input min-w-[120px]"
                    value={u.roleId ?? ""}
                    onChange={(e) => update(u, { roleId: e.target.value || null })}
                  >
                    <option value="">(none)</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-3">
                  <UploadOverride user={u} onChange={update} />
                </td>
                <td className="px-3 py-3">
                  <SizeInput
                    value={u.maxFileSizeOverride}
                    nullable
                    placeholder="(role default)"
                    onCommit={(v) => update(u, { maxFileSizeOverride: v })}
                  />
                </td>
                <td className="px-5 py-3">
                  <SizeInput
                    value={u.maxTotalStorageOverride}
                    nullable
                    placeholder="(role default)"
                    onCommit={(v) => update(u, { maxTotalStorageOverride: v })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Effective-upload icon + a three-state override (inherit role / allow / block).
function UploadOverride({
  user,
  onChange,
}: {
  user: User;
  onChange: (u: User, patch: Partial<User>) => void;
}) {
  const roleAllows = user.roleCanUpload ?? true; // no role → allowed
  const effective = user.canUploadOverride ?? roleAllows;
  const value = user.canUploadOverride == null ? "" : user.canUploadOverride ? "allow" : "block";

  return (
    <div className="flex items-center gap-2">
      <span
        title={
          effective
            ? user.canUploadOverride != null
              ? "Uploads allowed (override)"
              : "Uploads allowed (from role)"
            : user.canUploadOverride != null
              ? "Uploads blocked (override)"
              : "Uploads blocked (from role)"
        }
        className={effective ? "text-emerald-400" : "text-red-400"}
      >
        {effective ? <Upload size={16} /> : <Ban size={16} />}
      </span>
      <select
        className="input min-w-[110px] !py-1.5 text-xs"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(user, { canUploadOverride: v === "" ? null : v === "allow" });
        }}
      >
        <option value="">Role ({roleAllows ? "allowed" : "blocked"})</option>
        <option value="allow">Allow</option>
        <option value="block">Block</option>
      </select>
    </div>
  );
}

function SizeInput({
  value,
  onCommit,
  nullable,
  placeholder,
}: {
  value: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCommit: (v: any) => void;
  nullable?: boolean;
  placeholder?: string;
}) {
  const initial = value == null ? "" : formatBytes(value);
  const [v, setV] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!focused) setV(value == null ? "" : formatBytes(value));
  }, [value, focused]);

  function commit() {
    setFocused(false);
    setErr(false);
    const trimmed = v.trim();
    if (trimmed === "") {
      if (nullable) {
        if (value !== null) onCommit(null);
        setV("");
      } else {
        setV(value == null ? "" : formatBytes(value));
      }
      return;
    }
    const bytes = parseSize(trimmed);
    if (bytes == null) {
      setErr(true);
      return;
    }
    setV(formatBytes(bytes));
    if (bytes !== value) onCommit(bytes);
  }

  return (
    <div className="relative">
      <input
        className={
          err
            ? "input w-40 !border-red-400/60"
            : "input w-40"
        }
        value={v}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setV(e.target.value);
          if (err) setErr(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setV(value == null ? "" : formatBytes(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

function SoundsTable({ sounds, onChange }: { sounds: Sound[]; onChange: () => void }) {
  const [q, setQ] = useState("");
  const [publicOnly, setPublicOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useAudioOutput();
  const listId = useId();

  // Client-side typeahead: every clip name, file name, and uploader becomes a
  // native autocomplete suggestion (deduped, capped so the datalist stays light).
  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sounds) {
      if (s.name) set.add(s.name);
      if (s.originalFilename) set.add(s.originalFilename);
      if (s.ownerName) set.add(s.ownerName);
    }
    return [...set].sort((a, b) => a.localeCompare(b)).slice(0, 300);
  }, [sounds]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return sounds.filter((s) => {
      if (publicOnly && !s.isPublic) return false;
      if (!n) return true;
      return (
        s.name.toLowerCase().includes(n) ||
        s.originalFilename.toLowerCase().includes(n) ||
        (s.ownerName ?? "").toLowerCase().includes(n) ||
        (s.ownerDiscordId ?? "").toLowerCase().includes(n)
      );
    });
  }, [sounds, q, publicOnly]);

  async function setPublic(s: Sound, isPublic: boolean) {
    setBusy(s.id);
    await fetch(`/api/admin/sounds/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic }),
    });
    setBusy(null);
    onChange();
  }

  async function remove(s: Sound) {
    const extra = s.boardCount > 0 ? `\n\nThis removes it from ${s.boardCount} board(s).` : "";
    if (!confirm(`Delete "${s.name}" by ${s.ownerName ?? "unknown"}? This deletes the file permanently.${extra}`)) return;
    setBusy(s.id);
    await fetch(`/api/admin/sounds/${s.id}`, { method: "DELETE" });
    setBusy(null);
    audio.cancelSound(s.id);
    onChange();
  }

  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9"
            placeholder="Search by name, file, or uploader"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            list={listId}
            autoComplete="off"
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted select-none cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent"
            checked={publicOnly}
            onChange={(e) => setPublicOnly(e.target.checked)}
          />
          Public only
        </label>
        <span className="text-xs text-muted ml-auto">
          {filtered.length} / {sounds.length}
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          {sounds.length === 0 ? "No sounds uploaded yet." : "No matches."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
                <th className="px-5 py-3 font-medium">Sound</th>
                <th className="px-3 py-3 font-medium">Uploader</th>
                <th className="px-3 py-3 font-medium">Size</th>
                <th className="px-3 py-3 font-medium">Boards</th>
                <th className="px-3 py-3 font-medium">Visibility</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-t border-white/5 align-middle">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="btn-ghost !rounded-lg !px-2.5 !py-2 shrink-0"
                        onClick={() => audio.play(s.id)}
                        title="Preview"
                        aria-label={`Preview ${s.name}`}
                      >
                        <Play size={14} />
                      </button>
                      <div className="min-w-0">
                        <div className="truncate font-medium max-w-[260px]">{s.name}</div>
                        <div className="text-[11px] text-muted truncate max-w-[260px]">
                          {s.originalFilename}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      {s.ownerImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.ownerImage} alt="" className="h-6 w-6 rounded-full border border-white/10" />
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-white/5 border border-white/10" />
                      )}
                      <span className="truncate max-w-[140px]">{s.ownerName ?? "(no name)"}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted whitespace-nowrap">{formatBytes(s.sizeBytes)}</td>
                  <td className="px-3 py-3 text-muted">{s.boardCount}</td>
                  <td className="px-3 py-3">
                    {s.isPublic ? (
                      <span className="chip !text-emerald-300 !border-emerald-400/30 inline-flex items-center gap-1">
                        <Globe size={11} /> Public
                      </span>
                    ) : (
                      <span className="chip inline-flex items-center gap-1">
                        <Lock size={11} /> Private
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {s.isPublic && (
                        <button
                          className="btn-ghost text-xs"
                          disabled={busy === s.id}
                          onClick={() => setPublic(s, false)}
                          title="Remove from public browse"
                        >
                          Make private
                        </button>
                      )}
                      <button
                        className="btn-ghost text-xs !text-red-300 hover:!text-red-200 hover:!bg-red-500/10 !border-red-400/20"
                        disabled={busy === s.id}
                        onClick={() => remove(s)}
                      >
                        <Trash2 size={13} className="mr-1" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
