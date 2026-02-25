import type React from "react";
import { useEffect, useState } from "react";
import { type AdminOAuthAccount, type AdminSession, type AdminUser, api } from "../lib/api.ts";

export type AuthTab = "users" | "sessions" | "oauth";

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "admin" | "user";
}) {
  const cls = {
    default: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    admin: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    user: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  }[variant];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

function formatDate(val: string | number | undefined) {
  if (!val) return "—";
  const d = typeof val === "number" ? new Date(val * 1000) : new Date(val);
  return d.toLocaleString();
}

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create User modal state
  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createPass, setCreatePass] = useState("");
  const [createConfirm, setCreateConfirm] = useState("");
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  // Set Password modal state
  const [resetTarget, setResetTarget] = useState<{ id: string; email: string } | null>(null);
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  useEffect(() => {
    api
      .getUsers()
      .then(setUsers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreateUser = async () => {
    if (createPass.length < 8) {
      setCreateError("Password must be at least 8 characters");
      return;
    }
    if (createPass !== createConfirm) {
      setCreateError("Passwords do not match");
      return;
    }
    setCreateLoading(true);
    setCreateError(null);
    try {
      const user = await api.createUser({
        email: createEmail,
        password: createPass,
        role: createRole,
      });
      setUsers((prev) => [...prev, user]);
      setCreating(false);
      setCreateEmail("");
      setCreatePass("");
      setCreateConfirm("");
      setCreateRole("user");
    } catch (e: any) {
      setCreateError(e.message);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSetPassword = async () => {
    if (!resetTarget) return;
    if (newPass.length < 8) {
      setResetError("Password must be at least 8 characters");
      return;
    }
    if (newPass !== confirmPass) {
      setResetError("Passwords do not match");
      return;
    }
    setResetLoading(true);
    setResetError(null);
    try {
      await api.setUserPassword(resetTarget.id, newPass);
      setResetTarget(null);
      setNewPass("");
      setConfirmPass("");
    } catch (e: any) {
      setResetError(e.message);
    } finally {
      setResetLoading(false);
    }
  };

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading users…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;

  return (
    <div className="overflow-auto">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {users.length} user{users.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => setCreating(true)}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
        >
          Create User
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Email
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Role
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Created
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"></th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
                No users yet
              </td>
            </tr>
          )}
          {users.map((u) => (
            <tr
              key={u.id}
              className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
            >
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{u.email}</td>
              <td className="px-4 py-3">
                <Badge variant={u.role === "admin" ? "admin" : "user"}>{u.role}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">
                {u.id}
              </td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                {formatDate(u.created_at)}
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => setResetTarget({ id: String(u.id), email: String(u.email) })}
                  className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Set Password
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Create User modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
              Create User
            </h2>
            <div className="space-y-3">
              <input
                type="email"
                placeholder="Email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <input
                type="password"
                placeholder="Password"
                value={createPass}
                onChange={(e) => setCreatePass(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={createConfirm}
                onChange={(e) => setCreateConfirm(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value as "user" | "admin")}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              {createError && <p className="text-xs text-red-500">{createError}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => {
                    setCreating(false);
                    setCreateEmail("");
                    setCreatePass("");
                    setCreateConfirm("");
                    setCreateError(null);
                  }}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateUser}
                  disabled={createLoading}
                  className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                >
                  {createLoading ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set Password modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
            <h2 className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
              Set Password
            </h2>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{resetTarget.email}</p>
            <div className="space-y-3">
              <input
                type="password"
                placeholder="New password"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              {resetError && <p className="text-xs text-red-500">{resetError}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => {
                    setResetTarget(null);
                    setNewPass("");
                    setConfirmPass("");
                    setResetError(null);
                  }}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSetPassword}
                  disabled={resetLoading}
                  className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                >
                  {resetLoading ? "Saving…" : "Set Password"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .getSessions()
      .then(setSessions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleRevoke = async (id: string) => {
    await api.deleteSession(id);
    load();
  };

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading sessions…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Session ID
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              User ID
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Created
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Expires
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"></th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
                No active sessions
              </td>
            </tr>
          )}
          {sessions.map((s) => {
            const expired = s.expires_at < now;
            return (
              <tr
                key={s.id}
                className={`border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900 ${expired ? "opacity-50" : ""}`}
              >
                <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">
                  {s.id.slice(0, 16)}…
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {s.user_id}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(s.created_at)}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {expired ? (
                    <span className="text-red-500 dark:text-red-400">Expired</span>
                  ) : (
                    formatDate(s.expires_at)
                  )}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleRevoke(s.id)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OAuthTab() {
  const [accounts, setAccounts] = useState<AdminOAuthAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getOAuth()
      .then(setAccounts)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading OAuth accounts…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Provider
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Account ID
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              User ID
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
              Linked
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
                No OAuth accounts linked
              </td>
            </tr>
          )}
          {accounts.map((a) => (
            <tr
              key={a.id}
              className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
            >
              <td className="px-4 py-3">
                <Badge>{a.provider}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                {a.provider_account_id}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">
                {a.user_id}
              </td>
              <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                {formatDate(a.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuthDashboard({ tab }: { tab: AuthTab }) {
  return (
    <div className="h-full overflow-auto">
      {tab === "users" && <UsersTab />}
      {tab === "sessions" && <SessionsTab />}
      {tab === "oauth" && <OAuthTab />}
    </div>
  );
}
