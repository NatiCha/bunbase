import React, { useState } from "react";
import { useAuth } from "./lib/client.ts";
import { Layout } from "./components/Layout.tsx";
import { LoginForm } from "./components/LoginForm.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { ProjectDetail } from "./components/ProjectDetail.tsx";

type Page =
  | { name: "dashboard" }
  | { name: "projects" }
  | { name: "project"; id: string };

export function App() {
  const { user, isLoading, login, register, logout } = useAuth();
  const [page, setPage] = useState<Page>({ name: "dashboard" });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginForm
        onLogin={async (email, password) => {
          await login(email, password);
        }}
        onRegister={async (email, password, name) => {
          await register({ email, password, name });
        }}
      />
    );
  }

  const handleLogout = async () => {
    await logout();
    setPage({ name: "dashboard" });
  };

  return (
    <Layout user={user} page={page} onNavigate={setPage} onLogout={handleLogout}>
      {page.name === "dashboard" && <Dashboard />}
      {page.name === "projects" && (
        <ProjectList userId={user.id} onSelectProject={(id) => setPage({ name: "project", id })} />
      )}
      {page.name === "project" && (
        <ProjectDetail
          projectId={page.id}
          userId={user.id}
          onBack={() => setPage({ name: "projects" })}
        />
      )}
    </Layout>
  );
}
