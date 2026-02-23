import { useEffect, useState } from "react";

export type ApiSchema = Record<
  string,
  Array<{ key: string; name: string; type: string; notNull: boolean; primary: boolean }>
>;

const REST_OPERATIONS = ["list", "get", "create", "update", "delete"] as const;
export type ApiProcedure = (typeof REST_OPERATIONS)[number];

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function methodFor(procedure: ApiProcedure): string {
  switch (procedure) {
    case "list":
      return "GET";
    case "get":
      return "GET";
    case "create":
      return "POST";
    case "update":
      return "PATCH";
    case "delete":
      return "DELETE";
  }
}

function endpointFor(procedure: ApiProcedure, table: string, id = ":id"): string {
  switch (procedure) {
    case "list":
      return `/api/${table}`;
    case "get":
      return `/api/${table}/${id}`;
    case "create":
      return `/api/${table}`;
    case "update":
      return `/api/${table}/${id}`;
    case "delete":
      return `/api/${table}/${id}`;
  }
}

const METHOD_COLORS: Record<string, string> = {
  GET: "text-green-600 dark:text-green-400",
  POST: "text-blue-600 dark:text-blue-400",
  PATCH: "text-yellow-600 dark:text-yellow-400",
  DELETE: "text-red-600 dark:text-red-400",
};

async function callRestApi(
  table: string,
  procedure: ApiProcedure,
  id: string,
  bodyText: string,
  impersonateId?: string | null,
) {
  const extraHeaders: Record<string, string> = {};
  if (impersonateId) extraHeaders["x-impersonate-user"] = impersonateId;

  switch (procedure) {
    case "list": {
      const params = new URLSearchParams();
      let inp: Record<string, unknown> = {};
      try {
        inp = JSON.parse(bodyText) || {};
      } catch {
        /* ignore */
      }
      if (inp.filter) params.set("filter", JSON.stringify(inp.filter));
      if (inp.cursor) params.set("cursor", String(inp.cursor));
      if (inp.limit != null) params.set("limit", String(inp.limit));
      if (inp.sort) params.set("sort", String(inp.sort));
      if (inp.order) params.set("order", String(inp.order));
      const qs = params.toString();
      const res = await fetch(`/api/${table}${qs ? `?${qs}` : ""}`, {
        credentials: "include",
        headers: extraHeaders,
      });
      return res.json();
    }

    case "get": {
      const res = await fetch(`/api/${table}/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: extraHeaders,
      });
      return res.json();
    }

    case "create": {
      const res = await fetch(`/api/${table}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": getCsrfToken(),
          ...extraHeaders,
        },
        body: bodyText,
      });
      return res.json();
    }

    case "update": {
      const res = await fetch(`/api/${table}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": getCsrfToken(),
          ...extraHeaders,
        },
        body: bodyText,
      });
      return res.json();
    }

    case "delete": {
      const res = await fetch(`/api/${table}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          "x-csrf-token": getCsrfToken(),
          ...extraHeaders,
        },
      });
      return res.json();
    }
  }
}

function defaultBodyFor(procedure: ApiProcedure): string {
  switch (procedure) {
    case "list":
      return "{}";
    case "create":
      return "{}";
    case "update":
      return "{}";
    default:
      return "";
  }
}

const NEEDS_ID = new Set<ApiProcedure>(["get", "update", "delete"]);
const NEEDS_BODY = new Set<ApiProcedure>(["list", "create", "update"]);

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
  const [id, setId] = useState("");
  const [bodyText, setBodyText] = useState(() => defaultBodyFor(selectedProcedure));
  const [response, setResponse] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setId("");
    setBodyText(defaultBodyFor(selectedProcedure));
    setResponse(null);
    setError(null);
  }, [selectedProcedure]);

  useEffect(() => {
    setResponse(null);
    setError(null);
  }, []);

  const needsId = NEEDS_ID.has(selectedProcedure);
  const needsBody = NEEDS_BODY.has(selectedProcedure);
  const method = methodFor(selectedProcedure);
  const endpoint = selectedTable
    ? endpointFor(selectedProcedure, selectedTable, needsId ? id || ":id" : "")
    : "";

  const handleRun = async () => {
    if (!selectedTable) return;
    if (needsId && !id.trim()) {
      setError("ID is required");
      return;
    }
    if (needsBody) {
      try {
        JSON.parse(bodyText);
      } catch {
        setError("Invalid JSON body");
        return;
      }
    }
    setRunning(true);
    setResponse(null);
    setError(null);
    try {
      const result = await callRestApi(
        selectedTable,
        selectedProcedure,
        id.trim(),
        bodyText,
        impersonateId,
      );
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
            {/* Endpoint badge */}
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900">
              <span className={`font-bold ${METHOD_COLORS[method]}`}>{method}</span>
              <span className="text-gray-700 dark:text-gray-300">{endpoint}</span>
            </div>

            {/* ID input (get / update / delete) */}
            {needsId && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  Record ID
                </label>
                <input
                  type="text"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="e.g. 01935f2a-4b3c-7d8e-9f0a-1b2c3d4e5f6a"
                  className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-gray-600"
                />
              </div>
            )}

            {/* JSON body (list / create / update) */}
            {needsBody && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  {selectedProcedure === "list"
                    ? "Query options (JSON) — filter, cursor, limit, sort, order"
                    : selectedProcedure === "update"
                      ? "Fields to update (JSON)"
                      : "Record data (JSON)"}
                </label>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-gray-600"
                  spellCheck={false}
                />
              </div>
            )}

            {/* Run button */}
            <div className="flex justify-end">
              <button
                onClick={handleRun}
                disabled={running}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
              >
                {running ? "Running…" : "Run →"}
              </button>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
                {error}
              </div>
            )}

            {response !== null && (
              <div className="flex-1 overflow-auto">
                <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                  Response
                </div>
                <pre className="overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                  {JSON.stringify(response, null, 2)}
                </pre>
              </div>
            )}

            {schema[selectedTable] && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-gray-400 dark:text-gray-500">
                  Schema — {selectedTable}
                </div>
                <div className="max-h-40 overflow-auto rounded-md border border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">
                          Column
                        </th>
                        <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">
                          Type
                        </th>
                        <th className="px-3 py-2 text-left font-medium text-gray-400 dark:text-gray-500">
                          Constraints
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {schema[selectedTable].map((col) => (
                        <tr key={col.key} className="border-b border-gray-50 dark:border-gray-800">
                          <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">
                            {col.name}
                          </td>
                          <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">
                            {col.type.replace("SQLite", "").replace("Column", "")}
                          </td>
                          <td className="px-3 py-1.5 text-gray-400 dark:text-gray-500">
                            {[col.primary && "PK", col.notNull && "NOT NULL"]
                              .filter(Boolean)
                              .join(", ") || "—"}
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
