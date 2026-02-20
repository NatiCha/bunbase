import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Label } from "./ui/label.tsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.tsx";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.tsx";
import { Plus, FolderOpen } from "lucide-react";
import type * as schema from "../../schema";

type Project = typeof schema.projects.$inferSelect;

interface ProjectListProps {
  userId: string;
  onSelectProject: (id: string) => void;
}

export function ProjectList({ userId, onSelectProject }: ProjectListProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const { data, isLoading } = useQuery(api.projects.list.queryOptions());
  const projects = data?.data ?? [];

  const createMutation = useMutation(
    api.projects.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: api.projects.list.queryKey() });
        setName("");
        setDescription("");
        setDialogOpen(false);
      },
    }),
  );

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      name,
      description: description || null,
      ownerId: userId,
    });
  };

  if (isLoading) {
    return <p className="text-muted-foreground">Loading projects...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Projects</h2>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
              <DialogDescription>Add a new project to organize your tasks.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Project name"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-desc">Description</Label>
                <Textarea
                  id="project-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create Project"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No projects yet. Create one to get started!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => onSelectProject(project.id)}
            >
              <CardHeader>
                <CardTitle>{project.name}</CardTitle>
                {project.description && (
                  <CardDescription>{project.description}</CardDescription>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
