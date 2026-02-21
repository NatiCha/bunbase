import React from "react";
import { Button } from "./ui/button.tsx";
import { LayoutDashboard, FolderKanban, KeyRound, LogOut } from "lucide-react";

interface LayoutProps {
  user: { id: string; email: string; role: string };
  page: { name: string };
  onNavigate: (page: any) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

export function Layout({ user, page, onNavigate, onLogout, children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1
              className="font-semibold text-lg cursor-pointer"
              onClick={() => onNavigate({ name: "dashboard" })}
            >
              Task Manager
            </h1>
            <nav className="flex items-center gap-1">
              <Button
                variant={page.name === "dashboard" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onNavigate({ name: "dashboard" })}
              >
                <LayoutDashboard className="h-4 w-4 mr-1" />
                Dashboard
              </Button>
              <Button
                variant={page.name === "projects" || page.name === "project" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onNavigate({ name: "projects" })}
              >
                <FolderKanban className="h-4 w-4 mr-1" />
                Projects
              </Button>
              <Button
                variant={page.name === "api-keys" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onNavigate({ name: "api-keys" })}
              >
                <KeyRound className="h-4 w-4 mr-1" />
                API Keys
              </Button>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={onLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
