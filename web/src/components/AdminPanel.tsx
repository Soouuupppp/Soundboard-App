"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/utils";

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

  const refresh = async () => {
    const [r, u] = await Promise.all([
      fetch("/api/admin/roles").then((x) => x.json()),
      fetch("/api/admin/users").then((x) => x.json()),
    ]);
    setRoles(r.roles ?? []);
    setUsers(u.users ?? []);
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="font-semibold text-lg mb-3">Roles</h2>
        <RolesTable roles={roles} onChange={refresh} />
      </section>
      <section>
        <h2 className="font-semibold text-lg mb-3">Users</h2>
        <UsersTable users={users} roles={roles} onChange={refresh} />
      </section>
    </div>
  );
}

function RolesTable({ roles, onChange }: { roles: Role[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState(5 * 1024 * 1024);
  const [total, setTotal] = useState(50 * 1024 * 1024);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await fetch("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, defaultMaxFileSize: file, defaultMaxTotalStorage: total }),
    });
    setName("");
    onChange();
  }

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
    <div className="card space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-2">Name</th>
            <th>Default max file</th>
            <th>Default max total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="py-2">{r.name}{r.isSystem && <span className="ml-1 text-xs text-muted">(system)</span>}</td>
              <td>
                <NumberInput
                  value={r.defaultMaxFileSize}
                  onCommit={(v) => update(r, { defaultMaxFileSize: v })}
                />
              </td>
              <td>
                <NumberInput
                  value={r.defaultMaxTotalStorage}
                  onCommit={(v) => update(r, { defaultMaxTotalStorage: v })}
                />
              </td>
              <td className="text-right">
                {!r.isSystem && (
                  <button className="btn-danger text-xs" onClick={() => remove(r)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={create} className="flex flex-wrap gap-2 items-end pt-2 border-t border-border">
        <div>
          <label className="block text-xs text-muted mb-1">New role name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vip" />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Max file (bytes)</label>
          <input className="input" type="number" value={file} onChange={(e) => setFile(Number(e.target.value))} />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Max total (bytes)</label>
          <input className="input" type="number" value={total} onChange={(e) => setTotal(Number(e.target.value))} />
        </div>
        <button className="btn-primary">Create role</button>
      </form>
    </div>
  );
}

function UsersTable({ users, roles, onChange }: { users: User[]; roles: Role[]; onChange: () => void }) {
  async function update(u: User, patch: Partial<User>) {
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    onChange();
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-2">User</th>
            <th>Discord ID</th>
            <th>Role</th>
            <th>Max file override</th>
            <th>Max total override</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-border align-middle">
              <td className="py-2">{u.name ?? "(no name)"}</td>
              <td className="text-muted text-xs">{u.discordId ?? "—"}</td>
              <td>
                <select
                  className="input"
                  value={u.roleId ?? ""}
                  onChange={(e) => update(u, { roleId: e.target.value || null })}
                >
                  <option value="">(none)</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <OverrideInput
                  value={u.maxFileSizeOverride}
                  onCommit={(v) => update(u, { maxFileSizeOverride: v })}
                />
              </td>
              <td>
                <OverrideInput
                  value={u.maxTotalStorageOverride}
                  onCommit={(v) => update(u, { maxTotalStorageOverride: v })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      className="input w-40"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = Number(v);
        if (!Number.isNaN(n) && n !== value) onCommit(n);
      }}
    />
  );
}

function OverrideInput({ value, onCommit }: { value: number | null; onCommit: (v: number | null) => void }) {
  const [v, setV] = useState(value == null ? "" : String(value));
  useEffect(() => setV(value == null ? "" : String(value)), [value]);
  return (
    <input
      className="input w-40"
      placeholder="(role default)"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v.trim() === "") {
          if (value !== null) onCommit(null);
          return;
        }
        const n = Number(v);
        if (!Number.isNaN(n) && n !== value) onCommit(n);
      }}
    />
  );
}
