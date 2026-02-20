import React, { createContext, useContext, useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AppSidebar, type NavSection } from "./components/AppSidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar.tsx";
import { AuthDashboard, type AuthTab } from "./pages/AuthDashboard.tsx";
import { RequestLogPage } from "./pages/RequestLog.tsx";
import { StorageBrowser } from "./pages/StorageBrowser.tsx";
import { ApiExplorer, type ApiProcedure, type ApiSchema } from "./pages/ApiExplorer.tsx";
import { DataBrowser } from "./pages/DataBrowser.tsx";
import { Settings } from "./pages/Settings.tsx";
import { api, type AdminUser, type TableInfo } from "./lib/api.ts";

// ─── Theme ────────────────────────────────────────────────────────────────────

type Theme = "light" | "dark" | "system";

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark");
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "system") {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    }
  }
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("tsbase-admin-theme") as Theme) || "system";
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Re-apply when system preference changes
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem("tsbase-admin-theme", t);
    setThemeState(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function useTheme() {
  return useContext(ThemeContext);
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function getHashSection(): NavSection {
  const hash = window.location.hash.replace("#/", "");
  if (hash === "collections" || hash === "auth" || hash === "logs" || hash === "storage" || hash === "api" || hash === "settings") {
    return hash;
  }
  return "collections";
}

const SECTION_LABELS: Record<NavSection, string> = {
  collections: "Collections",
  auth: "Users & Auth",
  logs: "Request Log",
  storage: "Storage",
  api: "API Explorer",
  settings: "Settings",
};

const SECTION_DESCRIPTIONS: Record<NavSection, string> = {
  collections: "Browse and manage collection records.",
  auth: "Manage users, sessions, and OAuth providers.",
  logs: "Live request stream and API diagnostics.",
  storage: "Browse uploaded files and metadata.",
  api: "Test REST API endpoints directly.",
  settings: "Read-only TSBase instance configuration.",
};

function hasExpandedSidebar(section: NavSection): boolean {
  return section === "collections" || section === "api" || section === "auth";
}

interface MeUser {
  id: string;
  email: string;
  role: string;
}

// ─── Login ────────────────────────────────────────────────────────────────────

function LoginPrompt() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        setError(data?.error?.message ?? "Login failed");
        return;
      }
      if (data?.user?.role !== "admin") {
        setError("Your account does not have admin access.");
        return;
      }
      window.location.reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-900 text-white dark:bg-gray-800">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">TSBase Admin</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Sign in with an admin account</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {error && (
            <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 placeholder:text-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-gray-600 dark:placeholder:text-gray-600"
              placeholder="admin@example.com"
            />
          </div>

          <div className="mb-6">
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 placeholder:text-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-gray-600 dark:placeholder:text-gray-600"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-gray-900 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Admin App ────────────────────────────────────────────────────────────────

function AdminApp({ user }: { user: MeUser }) {
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<NavSection>(getHashSection());
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [apiSchema, setApiSchema] = useState<ApiSchema>({});
  const [apiSchemaLoading, setApiSchemaLoading] = useState(false);
  const [apiUsers, setApiUsers] = useState<AdminUser[]>([]);
  const [apiSelectedProcedure, setApiSelectedProcedure] = useState<ApiProcedure>("list");
  const [apiImpersonateId, setApiImpersonateId] = useState<string | null>(null);
  const [authTab, setAuthTab] = useState<AuthTab>("users");

  useEffect(() => {
    const handler = () => setSection(getHashSection());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  useEffect(() => {
    if (section !== "api") return;

    if (Object.keys(apiSchema).length === 0 && !apiSchemaLoading) {
      setApiSchemaLoading(true);
      api.getSchema()
        .then((schema) => setApiSchema(schema))
        .catch(() => {})
        .finally(() => setApiSchemaLoading(false));
    }

    if (apiUsers.length === 0) {
      api.getUsers().then(setApiUsers).catch(() => {});
    }
  }, [section, apiSchema, apiSchemaLoading, apiUsers.length]);

  useEffect(() => {
    if (section !== "api") return;
    const userTables = Object.keys(apiSchema).filter((t) => !t.startsWith("_"));
    if (userTables.length > 0 && (!selectedTable || !userTables.includes(selectedTable))) {
      setSelectedTable(userTables[0]);
    }
  }, [section, apiSchema, selectedTable]);

  const navigate = (s: NavSection) => {
    window.location.hash = `/${s}`;
    setSection(s);
  };

  const handleSignOut = async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // ignore
    }
    window.location.reload();
  };

  return (
    <SidebarProvider
      defaultOpen={true}
      style={{ "--sidebar-width": "280px" } as CSSProperties}
    >
      <AppSidebar
        active={section}
        onNavigate={navigate}
        theme={theme}
        setTheme={setTheme}
        user={user}
        onSignOut={handleSignOut}
        tables={tables}
        setTables={setTables}
        selectedTable={selectedTable}
        onTableSelect={setSelectedTable}
        apiSchema={apiSchema}
        apiLoading={apiSchemaLoading}
        apiUsers={apiUsers}
        apiSelectedProcedure={apiSelectedProcedure}
        onApiProcedureSelect={setApiSelectedProcedure}
        apiImpersonateId={apiImpersonateId}
        onApiImpersonateSelect={setApiImpersonateId}
        authTab={authTab}
        onAuthTabSelect={setAuthTab}
      />
      <SidebarInset className="overflow-hidden">
        <header className="bg-background sticky top-0 z-20 border-b border-sidebar-border p-4">
          <div className="flex items-start gap-2">
            {hasExpandedSidebar(section) ? (
              <SidebarTrigger className="-ml-1 mt-0.5" />
            ) : (
              <div className="w-7" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="hidden text-sidebar-foreground/60 md:inline">Admin</span>
                <span className="hidden text-sidebar-foreground/40 md:inline">/</span>
                <span className="font-medium text-sidebar-foreground">{SECTION_LABELS[section]}</span>
              </div>
              <p className="mt-1 text-xs text-sidebar-foreground/60">{SECTION_DESCRIPTIONS[section]}</p>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {section === "collections" && (
            <DataBrowser
              tables={tables}
              setTables={setTables}
              selectedTable={selectedTable}
              onTableSelect={setSelectedTable}
            />
          )}
          {section === "auth" && <AuthDashboard tab={authTab} />}
          {section === "logs" && <RequestLogPage />}
          {section === "storage" && <StorageBrowser />}
          {section === "api" && (
            <ApiExplorer
              schema={apiSchema}
              loading={apiSchemaLoading}
              selectedTable={selectedTable}
              selectedProcedure={apiSelectedProcedure}
              impersonateId={apiImpersonateId}
            />
          )}
          {section === "settings" && <Settings />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function Root() {
  const [status, setStatus] = useState<"loading" | "unauthenticated" | "not-admin" | "ready">("loading");
  const [user, setUser] = useState<MeUser | null>(null);

  useEffect(() => {
    fetch("/auth/me", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          setStatus("unauthenticated");
          return;
        }
        const data = await res.json() as { user: MeUser };
        if (data.user.role !== "admin") {
          setStatus("not-admin");
          return;
        }
        setUser(data.user);
        setStatus("ready");
      })
      .catch(() => setStatus("unauthenticated"));
  }, []);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center dark:bg-gray-950">
        <div className="text-sm text-gray-400">Loading…</div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <LoginPrompt />;
  }

  if (status === "not-admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="max-w-sm text-center">
          <p className="font-medium text-gray-900 dark:text-gray-100">Access denied</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Your account does not have admin privileges.</p>
        </div>
      </div>
    );
  }

  return <AdminApp user={user!} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <Root />
  </ThemeProvider>
);
