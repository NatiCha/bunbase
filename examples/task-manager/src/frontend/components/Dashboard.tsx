import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { CheckCircle, Clock, ListTodo, BarChart3 } from "lucide-react";

interface Stats {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
}

interface MyTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  project_id: string;
}

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

export function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["tsbase", "custom", "stats"],
    queryFn: async () => {
      const res = await fetch("/api/stats", { credentials: "include" });
      return res.json();
    },
  });

  const { data: myTasks = [], isLoading: tasksLoading } = useQuery<MyTask[]>({
    queryKey: ["tsbase", "custom", "my-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/my-tasks", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const loading = statsLoading || tasksLoading;

  if (loading) {
    return <p className="text-muted-foreground">Loading dashboard...</p>;
  }

  const statCards = [
    { label: "Total Tasks", value: stats?.total ?? 0, icon: BarChart3, color: "text-foreground" },
    { label: "To Do", value: stats?.todo ?? 0, icon: ListTodo, color: "text-blue-600" },
    { label: "In Progress", value: stats?.in_progress ?? 0, icon: Clock, color: "text-yellow-600" },
    { label: "Done", value: stats?.done ?? 0, icon: CheckCircle, color: "text-green-600" },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {myTasks.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">My Tasks</h3>
          <div className="space-y-2">
            {myTasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between p-3 border rounded-lg">
                <span className="font-medium">{task.title}</span>
                <div className="flex gap-2">
                  <Badge variant="secondary">{task.priority}</Badge>
                  <Badge variant={task.status === "done" ? "default" : "outline"}>
                    {task.status.replace("_", " ")}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
