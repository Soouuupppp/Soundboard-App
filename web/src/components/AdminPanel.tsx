"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Shield, Users, Trash2, Plus, Search, AlertCircle, Music, Play, Globe, Lock, Upload, Ban, Youtube, Tag as TagIcon } from "lucide-react";
import { formatBytes, parseSize } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";
import { TagChips, TagEditor } from "@/components/Tags";
import { useToast, useMutate } from "@/components/Toast";

type Role = {
  id: string;
  name: string;
  defaultMaxFileSize: number;
  defaultMaxTotalStorage: number;
  canUpload: boolean;
  isSystem: boolean;
  ytEnabledOverride: boolean | null;
  ytMaxDurationSecOverride: number | null;
  ytMaxFileSizeOverride: number | null;
  ytConcurrencyOverride: number | null;
};
type TagRow = { id: string; name: string; count: number };
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
  tags: string[];
};
type Settings = {
  ytEnabled: boolean;
  ytMaxDurationSec: number;
  ytMaxFileSize: number;
  ytConcurrency: number;
  ytAllowedHosts: string;
};

export function AdminPanel() {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Active admin section — a row of pill tabs sharing the panel below (mirrors
  // the /dashboard Control Panel / add-a-sound groups).
  const [tab, setTab] = useState<"roles" | "users" | "youtube" | "tags" | "content">("roles");

  const refresh = async () => {
    try {
      const [r, u, s, cfg, t] = await Promise.all([
        fetch("/api/admin/roles").then((x) => x.json()),
        fetch("/api/admin/users").then((x) => x.json()),
        fetch("/api/admin/sounds").then((x) => x.json()),
        fetch("/api/admin/settings").then((x) => x.json()),
        fetch("/api/admin/tags").then((x) => x.json()),
      ]);
      setRoles(r.roles ?? []);
      setUsers(u.users ?? []);
      setSounds(s.sounds ?? []);
      setSettings(cfg.settings ?? null);
      setTags(t.tags ?? []);
    } catch {
      toast.error("Couldn't load admin data — refresh to retry.");
    } finally {
      setLoading(false);
    }
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

      <div className="flex gap-2 flex-wrap">
        <PillTab icon={<Shield size={16} />} label="Roles" count={loading ? undefined : roles.length} active={tab === "roles"} onClick={() => setTab("roles")} />
        <PillTab icon={<Users size={16} />} label="Users" count={loading ? undefined : users.length} active={tab === "users"} onClick={() => setTab("users")} />
        <PillTab icon={<Youtube size={16} />} label="YouTube import" active={tab === "youtube"} onClick={() => setTab("youtube")} />
        <PillTab icon={<TagIcon size={16} />} label="Tags" count={loading ? undefined : tags.length} active={tab === "tags"} onClick={() => setTab("tags")} />
        <PillTab icon={<Music size={16} />} label="Content" count={loading ? undefined : sounds.length} active={tab === "content"} onClick={() => setTab("content")} />
      </div>

      <section className="card">
        {tab === "roles" && (
          <>
            <PanelHead
              icon={<Shield size={16} />}
              title="Roles"
              subtitle="Per-role defaults and overrides. Quotas accept human sizes like 5 MB, 1.5 GB, 250 KB (plain numbers are bytes). The resolution order is user override → role default → env default."
            />
            <RolesTable roles={roles} onChange={refresh} />

            <div className="mt-6">
              <div className="font-medium text-sm mb-1">Per-role overrides — YouTube import</div>
              <p className="text-xs text-muted mb-3">
                Leave a field blank to inherit the global value (set under the YouTube import tab).
                Disabling here turns import off for that role even when the global switch is on; it can
                never enable import while the global switch is off.
              </p>
              {settings ? (
                <RoleYtTable roles={roles} settings={settings} onChange={refresh} />
              ) : (
                <p className="text-sm text-muted">Loading…</p>
              )}
            </div>
          </>
        )}
        {tab === "users" && (
          <>
            <PanelHead
              icon={<Users size={16} />}
              title="Users"
              subtitle="Assign roles or override individual quotas. Leave overrides blank to use the role default."
            />
            <UsersTable users={users} roles={roles} onChange={refresh} />
          </>
        )}
        {tab === "youtube" && (
          <>
            <PanelHead
              icon={<Youtube size={16} />}
              title="YouTube import"
              subtitle="Let whitelisted users turn YouTube links into clips. Audio is fetched, trimmed, and transcoded server-side. The global toggle is the master switch; per-role overrides narrow it."
            />
            {settings ? (
              <YouTubeSettings settings={settings} onChange={refresh} />
            ) : (
              <p className="text-sm text-muted">Loading…</p>
            )}
          </>
        )}
        {tab === "tags" && (
          <>
            <PanelHead
              icon={<TagIcon size={16} />}
              title="Tags"
              subtitle="Every tag in the system. Rename to relabel it on all clips at once (renaming onto an existing tag merges them); delete to strip it from every clip."
            />
            <TagsTable tags={tags} onChange={refresh} />
          </>
        )}
        {tab === "content" && (
          <>
            <PanelHead
              icon={<Music size={16} />}
              title="Content"
              subtitle="Every uploaded sound. Preview to review, flip clips public or private, or delete violating content."
            />
            <SoundsTable sounds={sounds} allTags={tags.map((t) => t.name)} onChange={refresh} />
          </>
        )}
      </section>
    </div>
  );
}

// One segment of the admin pill-tab group (mirrors the dashboard's AddTabButton).
function PillTab({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
        active
          ? "border-accent bg-accent/10 text-white"
          : "border-white/10 text-muted hover:bg-white/5 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && <span className="chip">{count}</span>}
    </button>
  );
}

// Icon + title + subtitle header shown atop the active panel.
function PanelHead({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] border border-white/10 text-accent">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="section-title">{title}</h2>
        {subtitle && <p className="section-sub">{subtitle}</p>}
      </div>
    </div>
  );
}

function YouTubeSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: () => void;
}) {
  const [duration, setDuration] = useState(String(settings.ytMaxDurationSec));
  const [concurrency, setConcurrency] = useState(String(settings.ytConcurrency));
  const [hosts, setHosts] = useState(settings.ytAllowedHosts);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function patch(body: Partial<Settings>) {
    setErr(null);
    setSaving(true);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Couldn't save");
      return false;
    }
    onChange();
    return true;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-sm">Enable YouTube import</div>
          <p className="text-xs text-muted mt-0.5">
            When off, the import card is hidden and the API rejects requests. Note: downloading
            YouTube audio may conflict with YouTube&apos;s Terms of Service — enable at your own
            discretion.
          </p>
        </div>
        <Toggle
          checked={settings.ytEnabled}
          onChange={(next) => patch({ ytEnabled: next })}
          label="Toggle YouTube import"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Max duration (seconds)">
          <input
            className="input"
            value={duration}
            inputMode="numeric"
            onChange={(e) => setDuration(e.target.value)}
            onBlur={() => {
              const n = Math.round(Number(duration));
              if (!Number.isFinite(n) || n < 1 || n > 3600) {
                setErr("Duration must be 1–3600 seconds");
                setDuration(String(settings.ytMaxDurationSec));
                return;
              }
              if (n !== settings.ytMaxDurationSec) patch({ ytMaxDurationSec: n });
            }}
          />
        </Field>
        <Field label="Max file size">
          <SizeInput
            value={settings.ytMaxFileSize}
            onCommit={(v) => patch({ ytMaxFileSize: v })}
          />
        </Field>
        <Field label="Concurrent conversions">
          <input
            className="input"
            value={concurrency}
            inputMode="numeric"
            onChange={(e) => setConcurrency(e.target.value)}
            onBlur={() => {
              const n = Math.round(Number(concurrency));
              if (!Number.isFinite(n) || n < 1 || n > 4) {
                setErr("Concurrency must be 1–4");
                setConcurrency(String(settings.ytConcurrency));
                return;
              }
              if (n !== settings.ytConcurrency) patch({ ytConcurrency: n });
            }}
          />
        </Field>
      </div>

      <Field label="Allowed hosts (comma-separated)">
        <input
          className="input w-full"
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          onBlur={() => {
            if (hosts !== settings.ytAllowedHosts) {
              patch({ ytAllowedHosts: hosts }).then((ok) => {
                if (!ok) setHosts(settings.ytAllowedHosts);
              });
            }
          }}
        />
      </Field>
      <p className="text-xs text-muted -mt-3">
        Bare hostnames only (e.g. <code>youtube.com</code>). Imported links must match one exactly —
        this is the guard against fetching arbitrary URLs.
      </p>

      {err && (
        <p className="text-xs text-red-300 flex items-center gap-1.5">
          <AlertCircle size={13} /> {err}
        </p>
      )}
      {saving && <p className="text-xs text-muted">Saving…</p>}

      <p className="text-xs text-muted">
        Per-role import overrides now live under the <span className="text-white">Roles</span> tab,
        alongside each role&apos;s quotas.
      </p>
    </div>
  );
}

// Per-role YouTube override editor. Each cell commits independently; blank
// numeric fields clear the override (PATCH null) so the role inherits the
// global value.
function RoleYtTable({
  roles,
  settings,
  onChange,
}: {
  roles: Role[];
  settings: Settings;
  onChange: () => void;
}) {
  const mutate = useMutate();
  async function update(role: Role, patch: Partial<Role>) {
    const ok = await mutate(`/api/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }, "Couldn't update YouTube override");
    if (ok) onChange();
  }

  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-3 py-3 font-medium">Import</th>
              <th className="px-3 py-3 font-medium">Max duration (s)</th>
              <th className="px-3 py-3 font-medium">Max file size</th>
              <th className="px-5 py-3 font-medium">Concurrency</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-t border-white/5 align-middle">
                <td className="px-5 py-3">
                  <span className="font-medium">{r.name}</span>
                </td>
                <td className="px-3 py-3">
                  <select
                    className="input min-w-[120px] !py-1.5 text-xs"
                    value={r.ytEnabledOverride == null ? "" : r.ytEnabledOverride ? "on" : "off"}
                    onChange={(e) => {
                      const v = e.target.value;
                      update(r, { ytEnabledOverride: v === "" ? null : v === "on" });
                    }}
                  >
                    <option value="">Global ({settings.ytEnabled ? "on" : "off"})</option>
                    <option value="on">Enabled</option>
                    <option value="off">Disabled</option>
                  </select>
                </td>
                <td className="px-3 py-3">
                  <NullableNumber
                    value={r.ytMaxDurationSecOverride}
                    placeholder={`(${settings.ytMaxDurationSec})`}
                    min={1}
                    max={3600}
                    onCommit={(v) => update(r, { ytMaxDurationSecOverride: v })}
                  />
                </td>
                <td className="px-3 py-3">
                  <SizeInput
                    value={r.ytMaxFileSizeOverride}
                    nullable
                    placeholder={`(${formatBytes(settings.ytMaxFileSize)})`}
                    onCommit={(v) => update(r, { ytMaxFileSizeOverride: v })}
                  />
                </td>
                <td className="px-5 py-3">
                  <NullableNumber
                    value={r.ytConcurrencyOverride}
                    placeholder={`(${settings.ytConcurrency})`}
                    min={1}
                    max={4}
                    onCommit={(v) => update(r, { ytConcurrencyOverride: v })}
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

// A small integer input that commits on blur/Enter; an empty value commits null
// (inherit). Reverts to the last valid value on out-of-range or non-numeric.
function NullableNumber({
  value,
  onCommit,
  placeholder,
  min,
  max,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  min: number;
  max: number;
}) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setV(value == null ? "" : String(value));
  }, [value, focused]);

  function commit() {
    setFocused(false);
    const trimmed = v.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      setV("");
      return;
    }
    const n = Math.round(Number(trimmed));
    if (!Number.isFinite(n) || n < min || n > max) {
      setV(value == null ? "" : String(value)); // revert
      return;
    }
    setV(String(n));
    if (n !== value) onCommit(n);
  }

  return (
    <input
      className="input w-28"
      value={v}
      placeholder={placeholder}
      inputMode="numeric"
      onFocus={() => setFocused(true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value == null ? "" : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// Admin tag management: rename inline (blur/Enter), or delete from every clip.
function TagsTable({ tags, onChange }: { tags: TagRow[]; onChange: () => void }) {
  const toast = useToast();
  const mutate = useMutate();
  const [busy, setBusy] = useState<string | null>(null);

  async function rename(t: TagRow, name: string) {
    if (name.trim() === t.name) return;
    setBusy(t.id);
    const ok = await mutate(`/api/admin/tags/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }, "Couldn't rename tag");
    setBusy(null);
    if (ok) {
      toast.success("Tag renamed.");
      onChange();
    }
  }
  async function remove(t: TagRow) {
    const extra = t.count > 0 ? ` It's used on ${t.count} clip(s).` : "";
    if (!confirm(`Delete tag "${t.name}"?${extra}`)) return;
    setBusy(t.id);
    const ok = await mutate(`/api/admin/tags/${t.id}`, { method: "DELETE" }, "Couldn't delete tag");
    setBusy(null);
    if (ok) onChange();
  }

  if (tags.length === 0) {
    return <p className="text-sm text-muted">No tags yet — they appear here once clips are tagged.</p>;
  }

  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">Tag</th>
              <th className="px-3 py-3 font-medium">Clips</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id} className="border-t border-white/5">
                <td className="px-5 py-3">
                  <TagNameInput name={t.name} disabled={busy === t.id} onCommit={(n) => rename(t, n)} />
                </td>
                <td className="px-3 py-3 text-muted">{t.count}</td>
                <td className="px-5 py-3 text-right">
                  <button
                    className="btn-ghost text-xs !text-red-300 hover:!text-red-200 hover:!bg-red-500/10 !border-red-400/20"
                    disabled={busy === t.id}
                    onClick={() => remove(t)}
                  >
                    <Trash2 size={13} className="mr-1" /> Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TagNameInput({
  name,
  onCommit,
  disabled,
}: {
  name: string;
  onCommit: (name: string) => void;
  disabled?: boolean;
}) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <input
      className="input w-48"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (v.trim() && v.trim() !== name ? onCommit(v.trim()) : setV(name))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
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
  const mutate = useMutate();
  async function update(role: Role, patch: Partial<Role>) {
    const ok = await mutate(`/api/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }, "Couldn't update role");
    if (ok) onChange();
  }
  async function remove(role: Role) {
    if (role.isSystem) return;
    if (!confirm(`Delete role "${role.name}"?`)) return;
    const ok = await mutate(`/api/admin/roles/${role.id}`, { method: "DELETE" }, "Couldn't delete role");
    if (ok) onChange();
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
    let res: Response;
    try {
      res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, defaultMaxFileSize: f, defaultMaxTotalStorage: t, canUpload }),
      });
    } catch {
      setBusy(false);
      setErr("Network error — couldn't create the role.");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Couldn't create the role");
      return;
    }
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

  const mutate = useMutate();
  async function update(u: User, patch: Partial<User>) {
    const ok = await mutate(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }, "Couldn't update user");
    if (ok) onChange();
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

function SoundsTable({ sounds, allTags, onChange }: { sounds: Sound[]; allTags: string[]; onChange: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [publicOnly, setPublicOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState<string | null>(null);
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
    const ok = await mutate(`/api/admin/sounds/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic }),
    }, "Couldn't change visibility");
    setBusy(null);
    if (ok) onChange();
  }

  async function saveTags(s: Sound, next: string[]) {
    const ok = await mutate(`/api/admin/sounds/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: next }),
    }, "Couldn't save tags");
    if (ok) onChange();
  }

  async function remove(s: Sound) {
    const extra = s.boardCount > 0 ? `\n\nThis removes it from ${s.boardCount} board(s).` : "";
    if (!confirm(`Delete "${s.name}" by ${s.ownerName ?? "unknown"}? This deletes the file permanently.${extra}`)) return;
    setBusy(s.id);
    const ok = await mutate(`/api/admin/sounds/${s.id}`, { method: "DELETE" }, "Couldn't delete sound");
    setBusy(null);
    if (ok) {
      audio.cancelSound(s.id);
      toast.success("Sound deleted.");
      onChange();
    }
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
                        {editingTags === s.id ? (
                          <div className="mt-1.5 max-w-[260px] flex flex-col gap-1">
                            <TagEditor value={s.tags} suggestions={allTags} onChange={(next) => saveTags(s, next)} />
                            <button
                              type="button"
                              className="btn-ghost text-[11px] self-start !py-0.5"
                              onClick={() => setEditingTags(null)}
                            >
                              Done
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingTags(s.id)}
                            className="mt-1 flex items-center gap-1.5 text-left max-w-[260px]"
                            title="Edit tags"
                          >
                            <TagIcon size={12} className="text-muted shrink-0" />
                            {s.tags.length ? (
                              <TagChips tags={s.tags} />
                            ) : (
                              <span className="text-[11px] text-muted/60">Add tags</span>
                            )}
                          </button>
                        )}
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
                      {s.isPublic ? (
                        <button
                          className="btn-ghost text-xs"
                          disabled={busy === s.id}
                          onClick={() => setPublic(s, false)}
                          title="Remove from public browse"
                        >
                          Make private
                        </button>
                      ) : (
                        <button
                          className="btn-ghost text-xs !text-emerald-300 !border-emerald-400/30"
                          disabled={busy === s.id}
                          onClick={() => setPublic(s, true)}
                          title="Publish to public browse"
                        >
                          <Globe size={13} className="mr-1" /> Make public
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
