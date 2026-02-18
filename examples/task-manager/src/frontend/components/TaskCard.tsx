import React from "react";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Pencil, Trash2 } from "lucide-react";

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: string;
  assignee_id: string | null;
}

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
}

const statusColors: Record<string, string> = {
  todo: "bg-blue-100 text-blue-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  done: "bg-green-100 text-green-800",
};

const priorityColors: Record<string, string> = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-orange-100 text-orange-700",
  high: "bg-red-100 text-red-700",
};

export function TaskCard({ task, onEdit, onDelete }: TaskCardProps) {
  return (
    <div className="flex items-start justify-between p-4 border rounded-lg group">
      <div className="space-y-1 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{task.title}</span>
        </div>
        {task.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">{task.description}</p>
        )}
        <div className="flex gap-2 mt-2">
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${statusColors[task.status] ?? ""}`}>
            {task.status.replace("_", " ")}
          </span>
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${priorityColors[task.priority] ?? ""}`}>
            {task.priority}
          </span>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
        <Button variant="ghost" size="icon" onClick={() => onEdit(task)}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => onDelete(task.id)}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}
