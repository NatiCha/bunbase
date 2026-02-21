/**
 * Dashboard with live task feed powered by BunBase realtime WebSocket.
 * Demonstrates: client.realtime.subscribe(table, callback)
 */
import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { CheckCircle, Clock, ListTodo, BarChart3, Wifi } from "lucide-react";
import { client } from "../lib/client.ts";
import type { TableChangeEvent } from "bunbase";

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

interface LiveEvent {
  id: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  title: string;
  timestamp: Date;
}

const MAX_LIVE_EVENTS = 5;

export function Dashboard() {
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["bunbase", "custom", "stats"],
    queryFn: async () => {
      const res = await fetch("/api/stats", { credentials: "include" });
      return res.json();
    },
  });

  const { data: myTasks = [], isLoading: tasksLoading } = useQuery<MyTask[]>({
    queryKey: ["bunbase", "custom", "my-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/my-tasks", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Subscribe to realtime task changes and keep the stats counter fresh
  useEffect(() => {
    const unsub = client.realtime.subscribe("tasks", (event: TableChangeEvent) => {
      const record = event.record as { title?: string } | undefined;
      const title = record?.title ?? `Task ${event.id.slice(0, 6)}`;

      // Append to live event feed (most recent first)
      setLiveEvents((prev) => {
        const next: LiveEvent = {
          id: `${event.id}-${Date.now()}`,
          action: event.action,
          title,
          timestamp: new Date(),
        };
        return [next, ...prev].slice(0, MAX_LIVE_EVENTS);
      });

      // Invalidate stats so counters update immediately
      queryClient.invalidateQueries({ queryKey: ["bunbase", "custom", "stats"] });
      queryClient.invalidateQueries({ queryKey: ["bunbase", "custom", "my-tasks"] });
    });

    unsubRef.current = unsub;
    return () => unsub();
  }, [queryClient]);

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

  const actionLabel: Record<string, string> = {
    INSERT: "created",
    UPDATE: "updated",
    DELETE: "deleted",
  };

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

      {/* Live task feed via realtime WebSocket */}
      <div>
        <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Wifi className="h-4 w-4 text-green-500" />
          Live Activity
        </h3>
        {liveEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Watching for task changes in real-time…
          </p>
        ) : (
          <div className="space-y-2">
            {liveEvents.map((ev) => (
              <div key={ev.id} className="flex items-center justify-between p-2 border rounded text-sm">
                <span>
                  <span className="font-medium">{ev.title}</span>
                  {" "}
                  <span className="text-muted-foreground">{actionLabel[ev.action]}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {ev.timestamp.toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
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
