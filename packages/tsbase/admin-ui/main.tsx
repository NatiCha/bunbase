import React, { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AppSidebar, type NavSection } from "./components/AppSidebar.tsx";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar.tsx";
import { AuthDashboard } from "./pages/AuthDashboard.tsx";
import { RequestLogPage } from "./pages/RequestLog.tsx";
import { StorageBrowser } from "./pages/StorageBrowser.tsx";
import { ApiExplorer } from "./pages/ApiExplorer.tsx";
import { DataBrowser } from "./pages/DataBrowser.tsx";
import { Settings } from "./pages/Settings.tsx";
import { type TableInfo } from "./lib/api.ts";

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

// ─── Mode Toggle ──────────────────────────────────────────────────────────────

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const icon = theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <MonitorIcon />;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
        title="Toggle theme"
      >
        {icon}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 min-w-[110px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {(["light", "dark", "system"] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTheme(t); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                theme === t
                  ? "text-gray-900 font-medium dark:text-gray-100"
                  : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
              }`}
            >
              <span className="shrink-0 text-gray-500 dark:text-gray-400">
                {t === "light" ? <SunIcon /> : t === "dark" ? <MoonIcon /> : <MonitorIcon />}
              </span>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function getHashSection(): NavSection {
  const hash = window.location.hash.replace("#/", "");
  if (hash === "collections" || hash === "auth" || hash === "logs" || hash === "storage" || hash === "api" || hash === "settings") {
    return hash;
  }
  return "collections";
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
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-gray-600"
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
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-gray-600"
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
  const [section, setSection] = useState<NavSection>(getHashSection());
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => setSection(getHashSection());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

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
      defaultOpen={section === "collections"}
      style={{ "--sidebar-width": "280px" } as CSSProperties}
    >
      <AppSidebar
        active={section}
        onNavigate={navigate}
        user={user}
        onSignOut={handleSignOut}
        tables={tables}
        setTables={setTables}
        selectedTable={selectedTable}
        onTableSelect={setSelectedTable}
      />
      <SidebarInset className="overflow-hidden">
        <div className="absolute right-4 top-4 z-50">
          <ModeToggle />
        </div>
        {section === "collections" && (
          <DataBrowser
            tables={tables}
            setTables={setTables}
            selectedTable={selectedTable}
            onTableSelect={setSelectedTable}
          />
        )}
        {section === "auth" && <AuthDashboard />}
        {section === "logs" && <RequestLogPage />}
        {section === "storage" && <StorageBrowser />}
        {section === "api" && <ApiExplorer />}
        {section === "settings" && <Settings />}
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
