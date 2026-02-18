import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ChevronsUpDown,
  Code2,
  Database,
  HardDrive,
  LayoutGrid,
  Layers,
  LogOut,
  Settings2,
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
import { api, type TableInfo } from "../lib/api.ts";

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

interface MeUser {
  id: string;
  email: string;
  role: string;
}

export interface AppSidebarProps {
  active: NavSection;
  onNavigate: (section: NavSection) => void;
  user: MeUser;
  onSignOut: () => void;
  tables: TableInfo[];
  setTables: (t: TableInfo[]) => void;
  selectedTable: string | null;
  onTableSelect: (name: string) => void;
}

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function AppSidebar({
  active,
  onNavigate,
  user,
  onSignOut,
  tables,
  setTables,
  selectedTable,
  onTableSelect,
}: AppSidebarProps) {
  const { setOpen } = useSidebar();
  const [tableSearch, setTableSearch] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  // Close profile dropdown on outside click
  useEffect(() => {
    if (!profileOpen) return;
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [profileOpen]);

  // Load tables when collections is active
  useEffect(() => {
    if (active === "collections") {
      api.getTables().then(setTables).catch(() => {});
    }
  }, [active]);

  const handleNav = (id: NavSection) => {
    onNavigate(id);
    setOpen(id === "collections");
  };

  const filteredTables = tableSearch
    ? tables.filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()))
    : tables;

  return (
    <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row">

      {/* ── Icon rail (always visible) ─────────────────────────────── */}
      <Sidebar collapsible="none" className="w-[--sidebar-width-icon]! shrink-0 border-r border-sidebar-border">

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
                  tooltip={item.label}
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
                tooltip="Drizzle Studio"
                onClick={() => alert("Run: bunx drizzle-kit studio")}
                className="justify-center px-0"
              >
                <Database className="size-4" />
                <span className="sr-only">Drizzle Studio</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {/* User profile */}
            <SidebarMenuItem>
              <div ref={profileRef} className="relative">
                <SidebarMenuButton
                  tooltip={user.email}
                  onClick={() => setProfileOpen((o) => !o)}
                  className="justify-center px-0"
                >
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-[10px] font-semibold text-sidebar-accent-foreground">
                    {initials(user.email)}
                  </div>
                  <span className="sr-only">{user.email}</span>
                </SidebarMenuButton>

                {/* Profile popover */}
                {profileOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-lg border border-sidebar-border bg-sidebar shadow-lg">
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
      <Sidebar collapsible="none" className="hidden w-auto! flex-1 md:flex border-r border-sidebar-border">
        <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4">
          <p className="text-sm font-semibold text-sidebar-foreground">
            {navItems.find((n) => n.id === active)?.label ?? ""}
          </p>
        </SidebarHeader>

        <SidebarContent>
          {active === "collections" && (
            <>
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
        </SidebarContent>
      </Sidebar>

    </Sidebar>
  );
}
