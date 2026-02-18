import React, { useEffect, useState } from "react";
import { api, type AdminUser } from "../lib/api.ts";

type Schema = Record<string, Array<{ key: string; name: string; type: string; notNull: boolean; primary: boolean }>>;

const TRPC_PROCEDURES = ["list", "get", "create", "update", "delete"] as const;
type Procedure = typeof TRPC_PROCEDURES[number];

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function callTrpc(table: string, procedure: Procedure, input: unknown, impersonateId?: string | null) {
  const isMutation = procedure === "create" || procedure === "update" || procedure === "delete";
  const endpoint = `/trpc/${table}.${procedure}`;
  const extraHeaders = impersonateId ? { "x-impersonate-user": impersonateId } : {};

  if (isMutation) {
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": getCsrfToken(),
        ...extraHeaders,
      },
      body: JSON.stringify({ json: input }),
    });
    return res.json();
  } else {
    const params = encodeURIComponent(JSON.stringify({ json: input }));
    const res = await fetch(`${endpoint}?input=${params}`, {
      credentials: "include",
      headers: extraHeaders,
    });
    return res.json();
  }
}

export function ApiExplorer() {
  const [schema, setSchema] = useState<Schema>({});
  const [loading, setLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedProcedure, setSelectedProcedure] = useState<Procedure>("list");
  const [inputText, setInputText] = useState("{}");
  const [response, setResponse] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [impersonateId, setImpersonateId] = useState<string | null>(null);

  useEffect(() => {
    api.getSchema()
      .then((s) => {
        setSchema(s);
        const tables = Object.keys(s).filter((t) => !t.startsWith("_"));
        if (tables.length > 0) setSelectedTable(tables[0]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.getUsers().then(setUsers).catch(() => {});
  }, []);

  const handleRun = async () => {
    if (!selectedTable) return;
    setRunning(true);
    setResponse(null);
    setError(null);
    try {
      let input: unknown = {};
      try {
        input = JSON.parse(inputText);
      } catch {
        setError("Invalid JSON input");
        return;
      }
      const result = await callTrpc(selectedTable, selectedProcedure, input, impersonateId);
      setResponse(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const userTables = Object.keys(schema).filter((t) => !t.startsWith("_"));

  const defaultInputFor = (procedure: Procedure): string => {
    switch (procedure) {
      case "list": return '{}';
      case "get": return '{"id": ""}';
      case "create": return '{}';
      case "update": return '{"id": "", "data": {}}';
      case "delete": return '{"id": ""}';
    }
  };

  const handleProcedureChange = (p: Procedure) => {
    setSelectedProcedure(p);
    setInputText(defaultInputFor(p));
    setResponse(null);
  };

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading schema…</div>;

  return (
    <div className="flex h-full flex-col">
      {/* h-20 matches sidebar header height */}
      <div className="flex h-20 shrink-0 flex-row justify-between border-b border-gray-200 pl-6 pr-14 dark:border-gray-800">
        <div className="flex flex-col justify-center">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">API Explorer</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Test tRPC endpoints directly</p>
        </div>
        <div className="flex items-center gap-2 self-start pt-4">
          {impersonateId && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              Testing as {users.find(u => u.id === impersonateId)?.email}
            </span>
          )}
          <select
            value={impersonateId ?? ""}
            onChange={e => setImpersonateId(e.target.value || null)}
            className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
          >
            <option value="">Test as (self)</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.email} ({u.role})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — table + procedure picker */}
        <div className="w-56 shrink-0 overflow-auto border-r border-gray-200 py-3 dark:border-gray-800">
          {userTables.length === 0 ? (
            <p className="px-4 text-sm text-gray-400 dark:text-gray-600">No user tables found</p>
          ) : (
            userTables.map((table) => (
              <div key={table}>
                <button
                  onClick={() => {
                    setSelectedTable(table);
                    setResponse(null);
                  }}
                  className={`w-full px-4 py-2 text-left text-sm font-medium transition-colors ${
                    selectedTable === table
                      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                      : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900"
                  }`}
                >
                  {table}
                </button>
                {selectedTable === table && (
                  <div className="bg-gray-50 px-2 py-1 dark:bg-gray-900">
                    {TRPC_PROCEDURES.map((p) => (
                      <button
                        key={p}
                        onClick={() => handleProcedureChange(p)}
                        className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs transition-colors ${
                          selectedProcedure === p
                            ? "bg-white text-gray-900 font-medium shadow-sm dark:bg-gray-800 dark:text-gray-100"
                            : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${
                          ["create", "update", "delete"].includes(p) ? "bg-orange-400" : "bg-blue-400"
                        }`} />
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right panel — input + response */}
        <div className="flex flex-1 flex-col gap-4 overflow-hidden p-6">
          {selectedTable && (
            <>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    Input (JSON) — {selectedTable}.{selectedProcedure}
                  </label>
                  <button
                    onClick={handleRun}
                    disabled={running}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
                  >
                    {running ? "Running…" : "Run →"}
                  </button>
                </div>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-gray-600"
                  spellCheck={false}
                />
              </div>

              {error && (
                <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
                  {error}
                </div>
              )}

              {response !== null && (
                <div className="flex-1 overflow-auto">
                  <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">Response</div>
                  <pre className="overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    {JSON.stringify(response, null, 2)}
                  </pre>
                </div>
              )}

              {/* Schema reference */}
              {schema[selectedTable] && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-gray-400 dark:text-gray-500">Schema — {selectedTable}</div>
                  <div className="max-h-40 overflow-auto rounded-md border border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100 dark:border-gray-800">
                          <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">Column</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">Type</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">Constraints</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schema[selectedTable].map((col) => (
                          <tr key={col.key} className="border-b border-gray-50 dark:border-gray-800">
                            <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{col.name}</td>
                            <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">{col.type.replace("SQLite", "").replace("Column", "")}</td>
                            <td className="px-3 py-1.5 text-gray-400 dark:text-gray-500">
                              {[col.primary && "PK", col.notNull && "NOT NULL"].filter(Boolean).join(", ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {!selectedTable && (
            <div className="flex flex-1 items-center justify-center text-gray-400 dark:text-gray-600">
              Select a table to explore its API
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
