import React, { useCallback, useEffect, useState } from "react";
import { api, type TableInfo } from "../lib/api.ts";

type ColumnDef = { key: string; name: string; type: string; notNull: boolean; primary: boolean };
type Schema = Record<string, ColumnDef[]>;
type RecordData = Record<string, unknown>;
type PanelMode = "new" | "edit" | null;
type ApiTab = "js" | "curl";

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str.length > 60 ? str.slice(0, 60) + "…" : str;
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="opacity-30">
        <path d="M5 1L8 4H2L5 1ZM5 9L2 6H8L5 9Z" />
      </svg>
    );
  }
  return dir === "asc" ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M5 1L8 5H2L5 1Z" />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M5 9L2 5H8L5 9Z" />
    </svg>
  );
}

// ─── API Preview Panel ────────────────────────────────────────────────────────

function apiJsExample(table: string): string {
  return `// List records
const res = await fetch('/trpc/${table}.list?input=%7B%22json%22%3A%7B%7D%7D', {
  credentials: 'include',
});
const { result } = await res.json();
// result.data = array of records

// Get single record
const id = 'record-id-here';
const params = encodeURIComponent(JSON.stringify({ json: { id } }));
const single = await fetch(\`/trpc/${table}.get?input=\${params}\`, {
  credentials: 'include',
}).then(r => r.json());

// Create record
const created = await fetch('/trpc/${table}.create', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'x-csrf-token': '<csrf-token>',
  },
  body: JSON.stringify({ json: { /* fields */ } }),
}).then(r => r.json());

// Update record
const updated = await fetch('/trpc/${table}.update', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'x-csrf-token': '<csrf-token>',
  },
  body: JSON.stringify({ json: { id, data: { /* fields */ } } }),
}).then(r => r.json());

// Delete record
await fetch('/trpc/${table}.delete', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'x-csrf-token': '<csrf-token>',
  },
  body: JSON.stringify({ json: { id } }),
}).then(r => r.json());`;
}

function apiCurlExample(table: string): string {
  return `# List records
curl -s -b 'session=<token>' \\
  '/trpc/${table}.list?input=%7B%22json%22%3A%7B%7D%7D'

# Get single record
ID="record-id-here"
curl -s -b 'session=<token>' \\
  "/trpc/${table}.get?input=$(python3 -c "import urllib.parse,json; print(urllib.parse.quote(json.dumps({'json':{'id':'$ID'}})))")"

# Create record
curl -s -b 'session=<token>' \\
  -H 'Content-Type: application/json' \\
  -H 'x-csrf-token: <csrf-token>' \\
  -X POST '/trpc/${table}.create' \\
  -d '{"json":{"field":"value"}}'

# Update record
curl -s -b 'session=<token>' \\
  -H 'Content-Type: application/json' \\
  -H 'x-csrf-token: <csrf-token>' \\
  -X POST '/trpc/${table}.update' \\
  -d '{"json":{"id":"record-id","data":{"field":"new-value"}}}'

# Delete record
curl -s -b 'session=<token>' \\
  -H 'Content-Type: application/json' \\
  -H 'x-csrf-token: <csrf-token>' \\
  -X POST '/trpc/${table}.delete' \\
  -d '{"json":{"id":"record-id"}}'`;
}

function ApiPreviewPanel({
  table,
  onClose,
}: {
  table: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ApiTab>("js");

  return (
    <div className="fixed inset-0 z-30 flex">
      <div className="flex-1" onClick={onClose} />
      <div className="flex h-full w-[480px] shrink-0 flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-5 dark:border-gray-800">
          <div>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              API Preview
            </span>
            <span className="ml-2 font-mono text-xs text-gray-400 dark:text-gray-500">
              {table}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-gray-200 px-5 dark:border-gray-800">
          {(["js", "curl"] as ApiTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`mr-4 border-b-2 py-2.5 text-xs font-medium transition-colors ${
                tab === t
                  ? "border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100"
                  : "border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {t === "js" ? "JS / TS" : "curl"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-5">
          <pre className="whitespace-pre-wrap rounded-md border border-gray-100 bg-gray-50 p-4 font-mono text-xs leading-relaxed text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">
            {tab === "js" ? apiJsExample(table) : apiCurlExample(table)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─── Record Panel (create / edit) ─────────────────────────────────────────────

function RecordPanel({
  mode,
  columns,
  formData,
  saving,
  onFieldChange,
  onClose,
  onSave,
}: {
  mode: "new" | "edit";
  columns: ColumnDef[];
  formData: Record<string, string>;
  saving: boolean;
  onFieldChange: (name: string, value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex">
      <div className="flex-1" onClick={onClose} />
      <div className="flex h-full w-96 shrink-0 flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-5 dark:border-gray-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {mode === "new" ? "New record" : "Edit record"}
          </span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            {columns.map((col) => {
              const isId = col.name === "id";
              const isTimestamp = col.name.endsWith("_at");
              const isReadonly = isId && mode === "edit";
              const isHidden = isId && mode === "new";

              if (isHidden) {
                return (
                  <div key={col.key}>
                    <label className="mb-1 block text-xs font-medium text-gray-400 dark:text-gray-500">
                      {col.name}
                    </label>
                    <p className="text-xs italic text-gray-400 dark:text-gray-500">
                      Auto-generated
                    </p>
                  </div>
                );
              }

              if (isTimestamp) {
                return (
                  <div key={col.key}>
                    <label className="mb-1 block text-xs font-medium text-gray-400 dark:text-gray-500">
                      {col.name}
                    </label>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {formData[col.name] || "Auto-managed"}
                    </p>
                  </div>
                );
              }

              const inputType =
                col.type === "SQLiteInteger"
                  ? "number"
                  : col.type === "SQLiteReal"
                    ? "number"
                    : "text";
              const step = col.type === "SQLiteReal" ? "any" : col.type === "SQLiteInteger" ? "1" : undefined;

              return (
                <div key={col.key}>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                    {col.name}
                    {col.notNull && (
                      <span className="ml-1 text-red-400">*</span>
                    )}
                    <span className="ml-2 font-normal text-gray-400 dark:text-gray-500">
                      {col.type.replace("SQLite", "").replace("Column", "").toLowerCase()}
                    </span>
                  </label>
                  <input
                    type={inputType}
                    step={step}
                    value={formData[col.name] ?? ""}
                    onChange={(e) => onFieldChange(col.name, e.target.value)}
                    readOnly={isReadonly}
                    className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 ${
                      isReadonly
                        ? "border-gray-100 bg-gray-50 text-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-500"
                        : "border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    }`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-800">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DataBrowser ──────────────────────────────────────────────────────────────

interface DataBrowserProps {
  tables: TableInfo[];
  setTables: (t: TableInfo[]) => void;
  selectedTable: string | null;
  onTableSelect: (name: string) => void;
}

export function DataBrowser({ tables, setTables, selectedTable, onTableSelect }: DataBrowserProps) {
  const [schema, setSchema] = useState<Schema>({});
  const [records, setRecords] = useState<RecordData[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState("id");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [editRecord, setEditRecord] = useState<RecordData | null>(null);
  const [apiPreviewOpen, setApiPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});

  // Load schema on mount
  useEffect(() => {
    api.getSchema().then(setSchema).catch(() => {});
  }, []);

  // Select first table when list loads and none is selected
  useEffect(() => {
    if (tables.length > 0 && !selectedTable) {
      onTableSelect(tables[0].name);
    }
  }, [tables, selectedTable]);

  const fetchRecords = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRecords(selectedTable, {
        page,
        limit: 20,
        search,
        sort,
        order,
      });
      setRecords(result.data);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedTable, page, search, sort, order]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const handleTableSelect = (name: string) => {
    onTableSelect(name);
    setSearch("");
    setSearchInput("");
    setSort("id");
    setOrder("asc");
    setPage(1);
    setPanelMode(null);
    setApiPreviewOpen(false);
  };

  const columns: ColumnDef[] = selectedTable ? (schema[selectedTable] ?? []) : [];

  const handleSortColumn = (colName: string) => {
    if (sort === colName) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(colName);
      setOrder("asc");
    }
    setPage(1);
  };

  const handleDelete = async (id: unknown) => {
    if (!selectedTable) return;
    if (!window.confirm("Delete this record? This cannot be undone.")) return;
    try {
      await api.deleteRecord(selectedTable, String(id));
      setTables(
        tables.map((t) => (t.name === selectedTable ? { ...t, count: Math.max(0, t.count - 1) } : t)),
      );
      await fetchRecords();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openNewPanel = () => {
    setFormData({});
    setPanelMode("new");
    setEditRecord(null);
    setApiPreviewOpen(false);
  };

  const openEditPanel = (record: RecordData) => {
    setFormData(
      Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v == null ? "" : String(v)])),
    );
    setEditRecord(record);
    setPanelMode("edit");
    setApiPreviewOpen(false);
  };

  const closePanel = () => {
    setPanelMode(null);
    setEditRecord(null);
    setFormData({});
  };

  const handleSave = async () => {
    if (!selectedTable) return;
    setSaving(true);
    setError(null);
    try {
      if (panelMode === "new") {
        await api.createRecord(selectedTable, formData);
        setTables(
          tables.map((t) => (t.name === selectedTable ? { ...t, count: t.count + 1 } : t)),
        );
      } else if (panelMode === "edit" && editRecord) {
        await api.updateRecord(selectedTable, String(editRecord.id), formData);
      }
      closePanel();
      await fetchRecords();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const handleFieldChange = (name: string, value: string) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const displayColumns = columns.filter((c) => c.name !== "password_hash");

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex h-20 shrink-0 items-center justify-between border-b border-gray-200 pl-6 pr-4 dark:border-gray-800">
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {selectedTable ?? "Collections"}
            </h1>
            {selectedTable && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {total} record{total !== 1 ? "s" : ""}
              </p>
            )}
          </div>
          {selectedTable && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setApiPreviewOpen((o) => !o);
                  setPanelMode(null);
                }}
                className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                API Preview
              </button>
              <button
                onClick={openNewPanel}
                className="flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New record
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-3 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {selectedTable ? (
          <>
            {/* Toolbar */}
            <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-6 py-3 dark:border-gray-800">
              <form onSubmit={handleSearchSubmit} className="flex flex-1 items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search…"
                    className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-gray-600"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Search
                </button>
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setSearchInput("");
                      setPage(1);
                    }}
                    className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    Clear
                  </button>
                )}
              </form>
              <button
                onClick={fetchRecords}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Refresh
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              {loading ? (
                <div className="flex h-40 items-center justify-center text-sm text-gray-400">
                  Loading…
                </div>
              ) : records.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center text-gray-400 dark:text-gray-600">
                  <p className="text-sm">{search ? "No records match your search." : "No records yet."}</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white dark:bg-gray-950">
                    <tr className="border-b border-gray-100 dark:border-gray-800">
                      {displayColumns.map((col) => (
                        <th
                          key={col.key}
                          className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"
                        >
                          <button
                            onClick={() => handleSortColumn(col.name)}
                            className="flex items-center gap-1.5 hover:text-gray-900 dark:hover:text-gray-100"
                          >
                            {col.name}
                            <SortIcon active={sort === col.name} dir={order} />
                          </button>
                        </th>
                      ))}
                      <th className="w-10 px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record, i) => (
                      <tr
                        key={String(record.id ?? i)}
                        className="cursor-pointer border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                        onClick={() => openEditPanel(record)}
                      >
                        {displayColumns.map((col) => (
                          <td
                            key={col.key}
                            className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300"
                          >
                            {renderCell(record[col.name])}
                          </td>
                        ))}
                        <td
                          className="px-4 py-3"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleDelete(record.id)}
                            className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 dark:text-gray-700 dark:hover:bg-red-950 dark:hover:text-red-400"
                            title="Delete record"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4h6v2" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-6 py-3 dark:border-gray-800">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  ← Prev
                </button>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Page {page} of {totalPages} &middot; {total} total
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400 dark:text-gray-600">
            <p className="text-sm">Select a collection to browse records</p>
          </div>
        )}
      </div>

      {/* Slide-in panels */}
      {panelMode && (
        <RecordPanel
          mode={panelMode}
          columns={columns}
          formData={formData}
          saving={saving}
          onFieldChange={handleFieldChange}
          onClose={closePanel}
          onSave={handleSave}
        />
      )}
      {apiPreviewOpen && selectedTable && (
        <ApiPreviewPanel
          table={selectedTable}
          onClose={() => setApiPreviewOpen(false)}
        />
      )}
    </div>
  );
}
