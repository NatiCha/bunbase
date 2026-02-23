import type React from "react";
import { useEffect, useState } from "react";
import { type AdminConfig, api } from "../lib/api.ts";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
  if (s >= 60) return `${(s / 60).toFixed(0)}m`;
  return `${s}s`;
}

function Badge({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        enabled
          ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
          : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? "bg-green-500 dark:bg-green-400" : "bg-gray-300 dark:bg-gray-600"
        }`}
      />
      {label}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="border-b border-gray-100 px-5 py-3 dark:border-gray-800">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {title}
        </h2>
      </div>
      <div className="divide-y divide-gray-50 dark:divide-gray-800">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between px-5 py-3">
      <span className="shrink-0 text-sm text-gray-500 dark:text-gray-400">{label}</span>
      <span className="ml-4 text-right text-sm text-gray-900 dark:text-gray-100">{children}</span>
    </div>
  );
}

export function Settings() {
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-6">
        {loading && <div className="text-sm text-gray-400">Loading config…</div>}

        {error && (
          <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {config && (
          <div className="mx-auto max-w-2xl space-y-4">
            {/* Server */}
            <SectionCard title="Server">
              <Row label="Mode">
                <Badge
                  enabled={config.development}
                  label={config.development ? "Development" : "Production"}
                />
              </Row>
              <Row label="Note">
                <span className="text-gray-400 dark:text-gray-500 text-xs">
                  Port is set at process start
                </span>
              </Row>
            </SectionCard>

            {/* Database */}
            <SectionCard title="Database">
              <Row label="Driver">SQLite (bun:sqlite)</Row>
              <Row label="Path">
                <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {config.dbPath}
                </code>
              </Row>
            </SectionCard>

            {/* Storage */}
            <SectionCard title="Storage">
              <Row label="Driver">
                <span className="font-mono text-xs">{config.storage.driver}</span>
              </Row>
              <Row label="Max file size">{formatBytes(config.storage.maxFileSize)}</Row>
              <Row label="Allowed MIME types">
                {config.storage.allowedMimeTypes ? (
                  <div className="flex flex-wrap justify-end gap-1">
                    {config.storage.allowedMimeTypes.map((m) => (
                      <code
                        key={m}
                        className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      >
                        {m}
                      </code>
                    ))}
                  </div>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">All types allowed</span>
                )}
              </Row>
            </SectionCard>

            {/* Auth */}
            <SectionCard title="Auth">
              <Row label="Token expiry">{formatSeconds(config.auth.tokenExpiry)}</Row>
              <Row label="Providers">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Badge enabled={config.auth.hasEmail} label="Email" />
                  <Badge enabled={config.auth.hasGoogle} label="Google" />
                  <Badge enabled={config.auth.hasGithub} label="GitHub" />
                  <Badge enabled={config.auth.hasDiscord} label="Discord" />
                </div>
              </Row>
            </SectionCard>

            {/* CORS */}
            <SectionCard title="CORS">
              <Row label="Allowed origins">
                {config.cors.origins.length === 0 ? (
                  <span className="text-gray-400 dark:text-gray-500">None configured</span>
                ) : (
                  <div className="flex flex-wrap justify-end gap-1">
                    {config.cors.origins.map((o) => (
                      <code
                        key={o}
                        className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      >
                        {o}
                      </code>
                    ))}
                  </div>
                )}
              </Row>
            </SectionCard>
          </div>
        )}
      </div>
    </div>
  );
}
