import React, { useEffect, useState } from "react";
import { api, type AdminFile } from "../lib/api.ts";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mimeType: string) {
  return mimeType.startsWith("image/");
}

export function StorageBrowser() {
  const [files, setFiles] = useState<AdminFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getFiles()
      .then(setFiles)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    setDeleting(id);
    try {
      await api.deleteFile(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading files…</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-gray-200 px-6 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {files.length} file{files.length !== 1 ? "s" : ""} stored
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {files.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center text-gray-400 dark:text-gray-600">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p>No files uploaded yet</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-950">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"></th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Filename</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Collection</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Record ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Size</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">MIME Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Uploaded</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id} className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900">
                  <td className="px-4 py-2">
                    {isImage(file.mime_type) ? (
                      <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                        <img
                          src={`/files/${file.id}`}
                          alt={file.filename}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-gray-100 dark:bg-gray-800">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 dark:text-gray-500">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-800 dark:text-gray-200">{file.filename}</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{file.collection}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-400 dark:text-gray-500">{file.record_id}</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{formatSize(file.size)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-400 dark:text-gray-500">{file.mime_type}</td>
                  <td className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500">
                    {new Date(file.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDelete(file.id)}
                      disabled={deleting === file.id}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      {deleting === file.id ? "…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
