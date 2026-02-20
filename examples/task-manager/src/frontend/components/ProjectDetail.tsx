import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { TaskForm } from "./TaskForm.tsx";
import { ArrowLeft, Plus, ListTodo } from "lucide-react";
import type * as schema from "../../schema";

type Task = typeof schema.tasks.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

interface ProjectDetailProps {
  projectId: string;
  userId: string;
  onBack: () => void;
}

export function ProjectDetail({ projectId, userId, onBack }: ProjectDetailProps) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");

  const { data: project, isLoading: projectLoading } = useQuery(
    api.projects.get.queryOptions(projectId),
  );

  const tasksQueryKey = api.tasks.list.queryKey({ filter: { projectId } });
  const { data: tasksData, isLoading: tasksLoading } = useQuery(
    api.tasks.list.queryOptions({ filter: { projectId } }),
  );
  const tasks = tasksData?.data ?? [];

  const invalidateTasks = () => {
    queryClient.invalidateQueries({ queryKey: tasksQueryKey });
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

  const loading = projectLoading || tasksLoading;

  if (loading) {
    return <p className="text-muted-foreground">Loading project...</p>;
  }

  if (!project) {
    return <p className="text-destructive">Project not found.</p>;
  }

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div>
          <h2 className="text-2xl font-semibold">{project.name}</h2>
          {project.description && (
            <p className="text-muted-foreground">{project.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
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
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priority</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
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

      {filteredTasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ListTodo className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {tasks.length === 0
                ? "No tasks yet. Create one to get started!"
                : "No tasks match your filters."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredTasks.map((task) => (
            <TaskCard key={task.id} task={task} onEdit={handleEdit} onDelete={handleDelete} />
          ))}
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
