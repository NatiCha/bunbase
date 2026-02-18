import React, { useEffect, useState } from "react";
import { api, type AdminUser, type AdminSession, type AdminOAuthAccount } from "../lib/api.ts";

export type AuthTab = "users" | "sessions" | "oauth";

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "admin" | "user" }) {
  const cls = {
    default: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    admin: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    user: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  }[variant];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
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

  useEffect(() => {
    api.getUsers()
      .then(setUsers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading users…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Email</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Role</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Created</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">No users yet</td>
            </tr>
          )}
          {users.map((u) => (
            <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{u.email}</td>
              <td className="px-4 py-3">
                <Badge variant={u.role === "admin" ? "admin" : "user"}>{u.role}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">{u.id}</td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{formatDate(u.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getSessions()
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
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Session ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">User ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Created</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Expires</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"></th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">No active sessions</td>
            </tr>
          )}
          {sessions.map((s) => {
            const expired = s.expires_at < now;
            return (
              <tr key={s.id} className={`border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900 ${expired ? "opacity-50" : ""}`}>
                <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">{s.id.slice(0, 16)}…</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{s.user_id}</td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{formatDate(s.created_at)}</td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {expired ? <span className="text-red-500 dark:text-red-400">Expired</span> : formatDate(s.expires_at)}
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
    api.getOAuth()
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
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Provider</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Account ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">User ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Linked</th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">No OAuth accounts linked</td>
            </tr>
          )}
          {accounts.map((a) => (
            <tr key={a.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
              <td className="px-4 py-3">
                <Badge>{a.provider}</Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{a.provider_account_id}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-400 dark:text-gray-500">{a.user_id}</td>
              <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{formatDate(a.created_at)}</td>
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
