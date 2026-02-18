import React, { useEffect, useRef, useState } from "react";
import { api, type RequestLog } from "../lib/api.ts";

function StatusBadge({ status }: { status: number }) {
  let cls = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  if (status >= 200 && status < 300) cls = "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400";
  else if (status >= 300 && status < 400) cls = "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400";
  else if (status >= 400) cls = "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";

  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium ${cls}`}>
      {status}
    </span>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "text-blue-600 dark:text-blue-400",
    POST: "text-green-600 dark:text-green-400",
    PUT: "text-yellow-600 dark:text-yellow-400",
    PATCH: "text-orange-600 dark:text-orange-400",
    DELETE: "text-red-600 dark:text-red-400",
  };
  return (
    <span className={`font-mono text-xs font-semibold ${colors[method] ?? "text-gray-600 dark:text-gray-400"}`}>
      {method}
    </span>
  );
}

export function RequestLogPage() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    api.getLogs()
      .then(setLogs)
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleClear = async () => {
    setClearing(true);
    try {
      await api.clearLogs();
      setLogs([]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 justify-end border-b border-gray-200 px-6 py-3 dark:border-gray-800">
        <button
          onClick={handleClear}
          disabled={clearing}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          {clearing ? "Clearing…" : "Clear log"}
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-gray-950">
            <tr className="border-b border-gray-100 dark:border-gray-800">
              <th className="w-20 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Method</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Path</th>
              <th className="w-16 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
              <th className="w-20 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Duration</th>
              <th className="w-32 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">User</th>
              <th className="w-40 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Time</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
                  No requests recorded yet
                </td>
              </tr>
            )}
            {logs.map((entry) => (
              <tr key={entry.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
                <td className="px-4 py-2">
                  <MethodBadge method={entry.method} />
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">{entry.path}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={entry.status} />
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{entry.durationMs}ms</td>
                <td className="max-w-32 truncate px-4 py-2 font-mono text-xs text-gray-400 dark:text-gray-500">
                  {entry.userId ?? "—"}
                </td>
                <td className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
