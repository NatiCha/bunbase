import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ListTodo, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as schema from "../../schema";
import { api } from "../lib/client.ts";
import { TaskCard } from "./TaskCard.tsx";
import { TaskForm } from "./TaskForm.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

type Task = typeof schema.tasks.$inferSelect;

interface ProjectDetailProps {
  projectId: string;
  userId: string;
  onBack: () => void;
}

const PAGE_SIZE = 20;

export function ProjectDetail({ projectId, userId, onBack }: ProjectDetailProps) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // Server-side filters: sent as part of the filter object to the API
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const { data: project, isLoading: projectLoading } = useQuery(
    api.projects.get.queryOptions(projectId),
  );

  // Server-side filter + pagination + expand assignee
  const filter: Record<string, unknown> = { projectId };
  if (statusFilter) filter.status = statusFilter;

  const { data: tasksData, isLoading: tasksLoading } = useQuery(
    api.tasks.list.queryOptions({ filter, limit: PAGE_SIZE, cursor, expand: ["assignee"] }),
  );

  const hasMore = tasksData?.hasMore ?? false;
  const nextCursor = tasksData?.nextCursor ?? null;

  // Accumulate tasks across cursor pages for "Load more" UX.
  // cursorRef lets the effect read the current cursor without being a dep that
  // would cause double-appends on every render.
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    if (!tasksData?.data) return;
    const newData = tasksData.data as Task[];
    if (cursorRef.current === undefined) {
      // First page (fresh load or filter reset) — replace
      setAllTasks(newData);
    } else {
      // Subsequent page — append, deduplicating by id in case of background refetch
      setAllTasks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...newData.filter((t) => !seen.has(t.id))];
      });
    }
  }, [tasksData]);

  const invalidateTasks = () => {
    setCursor(undefined); // cursor reset → effect will replace on next data arrive
    queryClient.invalidateQueries({ queryKey: ["bunbase", "tasks", "list"] });
  };

  const createMutation = useMutation(
    api.tasks.create.mutationOptions({ onSuccess: invalidateTasks }),
  );

  const updateMutation = useMutation(
    api.tasks.update.mutationOptions({ onSuccess: invalidateTasks }),
  );

  const deleteMutation = useMutation(
    api.tasks.delete.mutationOptions({ onSuccess: invalidateTasks }),
  );

  const handleCreateOrUpdate = async (data: {
    title: string;
    description: string | null;
    status: string;
    priority: string;
  }) => {
    if (editingTask) {
      updateMutation.mutate({ id: editingTask.id, data });
    } else {
      createMutation.mutate({
        ...data,
        projectId,
        assigneeId: userId,
      });
    }
    setEditingTask(null);
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate({ id });
  };

  const handleEdit = (task: Task) => {
    setEditingTask(task);
    setFormOpen(true);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value === "all" ? undefined : value);
    setCursor(undefined); // cursor reset → effect replaces allTasks when first page arrives
  };

  const loading = projectLoading || tasksLoading;

  if (loading && !project) {
    return <p className="text-muted-foreground">Loading project...</p>;
  }

  if (!project) {
    return <p className="text-destructive">Project not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div>
          <h2 className="text-2xl font-semibold">{project.name}</h2>
          {project.description && <p className="text-muted-foreground">{project.description}</p>}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          {/* Server-side status filter — sent to /api/tasks?filter=... */}
          <Select value={statusFilter ?? "all"} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="todo">To Do</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => {
            setEditingTask(null);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" />
          New Task
        </Button>
      </div>

      {tasksLoading ? (
        <p className="text-muted-foreground">Loading tasks...</p>
      ) : allTasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ListTodo className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {statusFilter
                ? "No tasks match your filter."
                : "No tasks yet. Create one to get started!"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {allTasks.map((task) => {
            // expand: ["assignee"] enriches each task with its assignee user object
            const assignee = (task as any).assignee as { name?: string; email?: string } | null;
            return (
              <TaskCard
                key={task.id}
                task={task}
                assigneeName={assignee?.name ?? assignee?.email ?? undefined}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            );
          })}
          {/* Cursor-based "Load more" pagination */}
          {hasMore && nextCursor && (
            <div className="pt-2 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCursor(nextCursor)}
                disabled={tasksLoading}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <TaskForm
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingTask(null);
        }}
        onSubmit={handleCreateOrUpdate}
        initial={editingTask}
      />
    </div>
  );
}
