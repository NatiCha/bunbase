import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  Code2,
  Database,
  HardDrive,
  LayoutGrid,
  Layers,
  LogOut,
  Monitor,
  Moon,
  Settings2,
  Sun,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar.tsx";
import { api, type AdminUser, type TableInfo } from "../lib/api.ts";
import type { ApiProcedure, ApiSchema } from "../pages/ApiExplorer.tsx";
import type { AuthTab } from "../pages/AuthDashboard.tsx";

export type NavSection = "collections" | "auth" | "logs" | "storage" | "api" | "settings";

interface NavItem {
  id: NavSection;
  label: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: "collections", label: "Collections", icon: LayoutGrid },
  { id: "auth",        label: "Users & Auth",  icon: Users },
  { id: "logs",        label: "Request Log",   icon: Activity },
  { id: "storage",     label: "Storage",       icon: HardDrive },
  { id: "api",         label: "API Explorer",  icon: Code2 },
  { id: "settings",    label: "Settings",      icon: Settings2 },
];

const sectionDescriptions: Record<Exclude<NavSection, "collections">, string> = {
  auth: "Manage users, sessions, and OAuth providers.",
  logs: "Inspect request logs, statuses, and durations.",
  storage: "Browse uploaded files and metadata.",
  api: "Test generated REST API endpoints against your tables.",
  settings: "Configure instance-level options and defaults.",
};

function hasExpandedSidebar(section: NavSection): boolean {
  return section === "collections" || section === "api" || section === "auth";
}

const API_PROCEDURES: ApiProcedure[] = ["list", "get", "create", "update", "delete"];
const AUTH_TABS: { id: AuthTab; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "sessions", label: "Sessions" },
  { id: "oauth", label: "OAuth" },
];

interface MeUser {
  id: string;
  email: string;
  role: string;
}

export interface AppSidebarProps {
  active: NavSection;
  onNavigate: (section: NavSection) => void;
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
  user: MeUser;
  onSignOut: () => void;
  tables: TableInfo[];
  setTables: (t: TableInfo[]) => void;
  selectedTable: string | null;
  onTableSelect: (name: string) => void;
  apiSchema: ApiSchema;
  apiLoading: boolean;
  apiUsers: AdminUser[];
  apiSelectedProcedure: ApiProcedure;
  onApiProcedureSelect: (procedure: ApiProcedure) => void;
  apiImpersonateId: string | null;
  onApiImpersonateSelect: (id: string | null) => void;
  authTab: AuthTab;
  onAuthTabSelect: (tab: AuthTab) => void;
}

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function AppSidebar({
  active,
  onNavigate,
  theme,
  setTheme,
  user,
  onSignOut,
  tables,
  setTables,
  selectedTable,
  onTableSelect,
  apiSchema,
  apiLoading,
  apiUsers,
  apiSelectedProcedure,
  onApiProcedureSelect,
  apiImpersonateId,
  onApiImpersonateSelect,
  authTab,
  onAuthTabSelect,
}: AppSidebarProps) {
  const { setOpen } = useSidebar();
  const [tableSearch, setTableSearch] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const previousActiveRef = useRef<NavSection | null>(null);
  const [profileMenuPosition, setProfileMenuPosition] = useState({ left: 0, bottom: 0 });

  // Close profile dropdown on outside click
  useEffect(() => {
    if (!profileOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (profileRef.current?.contains(target)) return;
      if (profileMenuRef.current?.contains(target)) return;
      setProfileOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [profileOpen]);

  useEffect(() => {
    if (!themeOpen) return;
    const handler = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [themeOpen]);

  // Load tables when collections/API is active
  useEffect(() => {
    if (active === "collections" || active === "api") {
      api.getTables().then(setTables).catch(() => {});
    }
  }, [active]);

  useEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    setOpen(hasExpandedSidebar(active));
  }, [active, setOpen]);

  const handleNav = (id: NavSection) => {
    onNavigate(id);
    setOpen(hasExpandedSidebar(id));
  };

  const toggleProfileMenu = () => {
    if (!profileOpen && profileRef.current) {
      const rect = profileRef.current.getBoundingClientRect();
      setProfileMenuPosition({
        left: rect.right + 8,
        bottom: window.innerHeight - rect.bottom,
      });
    }
    setProfileOpen((open) => !open);
  };

  const filteredTables = tableSearch
    ? tables.filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()))
    : tables;
  const apiTables = Object.keys(apiSchema).filter((t) => !t.startsWith("_"));
  const activeLabel = navItems.find((n) => n.id === active)?.label ?? "";
  const themeIcon = theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />;

  return (
    <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row">

      {/* ── Icon rail (always visible) ─────────────────────────────── */}
      <Sidebar collapsible="none" className="w-[calc(var(--sidebar-width-icon)+1px)]! shrink-0 border-r border-sidebar-border">

        {/* Logo */}
        <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-0">
          <div className="flex items-center justify-center">
            <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <Layers className="size-4" />
            </div>
          </div>
        </SidebarHeader>

        {/* Nav */}
        <SidebarContent className="px-2 py-3">
          <SidebarMenu className="gap-1">
            {navItems.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={{ children: item.label, hidden: false }}
                  isActive={active === item.id}
                  onClick={() => handleNav(item.id)}
                  className="justify-center px-0"
                >
                  <item.icon className="size-4" />
                  {/* Hidden span keeps a11y label; visually hidden in icon-only rail */}
                  <span className="sr-only">{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>

        {/* Footer */}
        <SidebarFooter className="border-t border-sidebar-border px-2 py-3">
          <SidebarMenu className="gap-1">
            {/* Drizzle Studio */}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{ children: "Drizzle Studio", hidden: false }}
                onClick={() => alert("Run: bunx drizzle-kit studio")}
                className="justify-center px-0"
              >
                <Database className="size-4" />
                <span className="sr-only">Drizzle Studio</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <div ref={themeRef} className="relative">
                <SidebarMenuButton
                  tooltip={{ children: "Theme", hidden: false }}
                  onClick={() => setThemeOpen((o) => !o)}
                  className="justify-center px-0"
                >
                  {themeIcon}
                  <span className="sr-only">Theme</span>
                </SidebarMenuButton>
                {themeOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 w-28 rounded-lg border border-sidebar-border bg-sidebar p-1 shadow-lg">
                    {(["light", "dark", "system"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setTheme(t);
                          setThemeOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                          theme === t
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                        }`}
                      >
                        <span className="shrink-0">
                          {t === "dark" ? <Moon className="size-3.5" /> : t === "light" ? <Sun className="size-3.5" /> : <Monitor className="size-3.5" />}
                        </span>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <div ref={profileRef} className="relative">
                <SidebarMenuButton
                  tooltip={{ children: "Account", hidden: false }}
                  onClick={toggleProfileMenu}
                  className="justify-center px-0"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-[10px] font-semibold text-sidebar-accent-foreground">
                    {initials(user.email)}
                  </div>
                  <span className="sr-only">User menu</span>
                </SidebarMenuButton>
                {profileOpen && (
                  <div
                    ref={profileMenuRef}
                    className="fixed z-50 w-56 rounded-lg border border-sidebar-border bg-sidebar shadow-lg"
                    style={profileMenuPosition}
                  >
                    <div className="border-b border-sidebar-border px-3 py-2.5">
                      <p className="truncate text-xs font-medium text-sidebar-foreground">{user.email}</p>
                      <p className="text-[10px] text-sidebar-foreground/50">Role: {user.role}</p>
                    </div>
                    <div className="p-1">
                      <button
                        onClick={() => { setProfileOpen(false); onSignOut(); }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-red-500 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut className="size-3.5" />
                        Sign out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </SidebarMenuItem>

          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* ── Second panel (section content) ─────────────────────────── */}
      {hasExpandedSidebar(active) && (
      <Sidebar collapsible="none" className="hidden w-auto! flex-1 md:flex border-r border-sidebar-border">
        <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4">
          <p className="text-sm font-semibold text-sidebar-foreground">
            {activeLabel}
          </p>
        </SidebarHeader>

        <SidebarContent>
          {active === "collections" && (
            <>
              <div className="px-3 pt-2.5">
                <button
                  onClick={() => handleNav("api")}
                  className="flex w-full items-center gap-2 rounded-md border border-sidebar-border px-3 py-2 text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
                >
                  <Code2 className="size-3.5" />
                  Open API Explorer
                </button>
              </div>
              <div className="px-3 py-2.5">
                <SidebarInput
                  placeholder="Filter tables…"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                />
              </div>
              <div className="flex-1 overflow-auto pb-2">
                {filteredTables.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-sidebar-foreground/40">
                    {tables.length === 0 ? "No tables found" : "No matches"}
                  </p>
                ) : (
                  filteredTables.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => onTableSelect(t.name)}
                      className={`flex w-full items-center justify-between px-4 py-2 text-left transition-colors ${
                        selectedTable === t.name
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      }`}
                    >
                      <span className="truncate text-sm">{t.name}</span>
                      <span
                        className={`ml-2 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${
                          t.type === "auth"
                            ? "bg-purple-500/15 text-purple-400"
                            : "bg-sidebar-accent text-sidebar-foreground/50"
                        }`}
                      >
                        {t.count}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
          {active === "api" && (
            <>
              <div className="border-b border-sidebar-border px-3 py-2.5">
                <select
                  value={apiImpersonateId ?? ""}
                  onChange={(e) => onApiImpersonateSelect(e.target.value || null)}
                  className="w-full rounded-md border border-sidebar-border bg-sidebar px-2 py-1.5 text-xs text-sidebar-foreground focus:outline-none focus:ring-2 focus:ring-sidebar-ring"
                >
                  <option value="">Test as (self)</option>
                  {apiUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 overflow-auto pb-2">
                {apiLoading ? (
                  <p className="px-4 py-2 text-xs text-sidebar-foreground/40">Loading schema…</p>
                ) : apiTables.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-sidebar-foreground/40">No user tables found</p>
                ) : (
                  apiTables.map((table) => (
                    <div key={table}>
                      <button
                        onClick={() => onTableSelect(table)}
                        className={`w-full px-4 py-2 text-left text-sm font-medium transition-colors ${
                          selectedTable === table
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                        }`}
                      >
                        {table}
                      </button>
                      {selectedTable === table && (
                        <div className="bg-sidebar px-2 py-1">
                          {API_PROCEDURES.map((p) => (
                            <button
                              key={p}
                              onClick={() => onApiProcedureSelect(p)}
                              className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs transition-colors ${
                                apiSelectedProcedure === p
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                  : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  p === "create" || p === "update" || p === "delete"
                                    ? "bg-orange-400"
                                    : "bg-blue-400"
                                }`}
                              />
                              {p}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
          {active === "auth" && (
            <div className="px-2 py-2">
              {AUTH_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onAuthTabSelect(tab.id)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    authTab === tab.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          {active !== "collections" && active !== "api" && active !== "auth" && (
            <div className="space-y-3 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-sidebar-foreground/50">
                {activeLabel}
              </p>
              <p className="text-sm leading-relaxed text-sidebar-foreground/70">
                {sectionDescriptions[active]}
              </p>
              <p className="text-xs text-sidebar-foreground/50">
                Use the icon rail to switch sections, or collapse this panel using the top-left toggle.
              </p>
            </div>
          )}
        </SidebarContent>
      </Sidebar>
      )}

    </Sidebar>
  );
}
