import React, { useEffect, useState } from "react";

export type ApiSchema = Record<string, Array<{ key: string; name: string; type: string; notNull: boolean; primary: boolean }>>;

const TRPC_PROCEDURES = ["list", "get", "create", "update", "delete"] as const;
export type ApiProcedure = typeof TRPC_PROCEDURES[number];

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function callTrpc(table: string, procedure: ApiProcedure, input: unknown, impersonateId?: string | null) {
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

function defaultInputFor(procedure: ApiProcedure): string {
  switch (procedure) {
    case "list": return "{}";
    case "get": return '{"id": ""}';
    case "create": return "{}";
    case "update": return '{"id": "", "data": {}}';
    case "delete": return '{"id": ""}';
  }
}

export interface ApiExplorerProps {
  schema: ApiSchema;
  loading: boolean;
  selectedTable: string | null;
  selectedProcedure: ApiProcedure;
  impersonateId: string | null;
}

export function ApiExplorer({
  schema,
  loading,
  selectedTable,
  selectedProcedure,
  impersonateId,
}: ApiExplorerProps) {
  const [inputText, setInputText] = useState(() => defaultInputFor(selectedProcedure));
  const [response, setResponse] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInputText(defaultInputFor(selectedProcedure));
    setResponse(null);
    setError(null);
  }, [selectedProcedure]);

  useEffect(() => {
    setResponse(null);
    setError(null);
  }, [selectedTable]);

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

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading schema…</div>;

  return (
    <div className="flex h-full flex-col">
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
            Select a table in the sidebar to explore its API
          </div>
        )}
      </div>
    </div>
  );
}
