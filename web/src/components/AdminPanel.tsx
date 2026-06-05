"use client";

import { useEffect, useMemo, useState } from "react";
import { Shield, Users, Trash2, Plus, Search, AlertCircle } from "lucide-react";
import { formatBytes, parseSize } from "@/lib/utils";

type Role = {
  id: string;
  name: string;
  defaultMaxFileSize: number;
  defaultMaxTotalStorage: number;
  isSystem: boolean;
};
type User = {
  id: string;
  name: string | null;
  image: string | null;
  discordId: string | null;
  roleId: string | null;
  roleName: string | null;
  maxFileSizeOverride: number | null;
  maxTotalStorageOverride: number | null;
};

export function AdminPanel() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [r, u] = await Promise.all([
      fetch("/api/admin/roles").then((x) => x.json()),
      fetch("/api/admin/users").then((x) => x.json()),
    ]);
    setRoles(r.roles ?? []);
    setUsers(u.users ?? []);
    setLoading(false);
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-muted mt-1">Manage roles, quotas, and user overrides.</p>
        </div>
        <div className="flex gap-2">
          <Stat label="Roles" value={loading ? "…" : String(roles.length)} />
          <Stat label="Users" value={loading ? "…" : String(users.length)} />
        </div>
      </header>

      <Section
        icon={<Shield size={16} />}
        title="Roles & quotas"
        subtitle="Quotas accept human sizes like 5 MB, 1.5 GB, 250 KB. Plain numbers are treated as bytes."
      >
        <RolesTable roles={roles} onChange={refresh} />
      </Section>

      <Section
        icon={<Users size={16} />}
        title="Users"
        subtitle="Assign roles or override individual quotas. Leave overrides blank to use the role default."
      >
        <UsersTable users={users} roles={roles} onChange={refresh} />
      </Section>
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.04] border border-white/10 text-accent">
          {icon}
        </span>
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="section-sub">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
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
    <div className="card !p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-3 py-3 font-medium">Max file size</th>
              <th className="px-3 py-3 font-medium">Max total storage</th>
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
      body: JSON.stringify({ name, defaultMaxFileSize: f, defaultMaxTotalStorage: t }),
    });
    setBusy(false);
    setName("");
    onCreated();
  }

  return (
    <form
      onSubmit={create}
      className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] items-end p-5 border-t border-white/5 bg-white/[0.015]"
    >
      <Field label="New role name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="vip"
        />
      </Field>
      <Field label="Max file size" hint="e.g. 5 MB, 1.5 GB">
        <input className="input" value={file} onChange={(e) => setFile(e.target.value)} />
      </Field>
      <Field label="Max total storage" hint="e.g. 50 MB, 2 GB">
        <input className="input" value={total} onChange={(e) => setTotal(e.target.value)} />
      </Field>
      <button className="btn-primary" disabled={busy}>
        <Plus size={14} className="mr-1" /> Create
      </button>
      {err && (
        <p className="sm:col-span-4 text-xs text-red-300 flex items-center gap-1.5">
          <AlertCircle size={13} /> {err}
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted/70 mt-1">{hint}</span>}
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
    <div className="card !p-0 overflow-hidden">
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
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-muted text-xs uppercase tracking-wide bg-white/[0.02]">
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-3 py-3 font-medium">Discord ID</th>
              <th className="px-3 py-3 font-medium">Role</th>
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
