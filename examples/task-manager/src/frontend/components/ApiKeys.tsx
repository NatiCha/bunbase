/**
 * ApiKeys component — demonstrates client.auth.apiKeys.create/list/delete()
 *
 * Shows the created key only once (the raw value is never stored server-side).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";

interface CreatedKey {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  expiresAt: number | null;
}

export function ApiKeys() {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [justCreated, setJustCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ["bunbase", "auth", "api-keys"],
    queryFn: () => client.auth.apiKeys.list(),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => client.auth.apiKeys.create({ name }),
    onSuccess: (created) => {
      setJustCreated(created);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["bunbase", "auth", "api-keys"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.auth.apiKeys.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bunbase", "auth", "api-keys"] });
    },
  });

  const handleCopy = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">API Keys</h2>
      <p className="text-muted-foreground text-sm">
        API keys allow server-to-server access without browser sessions. The raw key value is shown
        only once — store it securely.
      </p>

      {/* Create new key */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create new key</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Key name, e.g. CI/CD pipeline"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newKeyName.trim()) {
                  createMutation.mutate(newKeyName.trim());
                }
              }}
            />
            <Button
              onClick={() => createMutation.mutate(newKeyName.trim())}
              disabled={!newKeyName.trim() || createMutation.isPending}
            >
              <KeyRound className="h-4 w-4 mr-1" />
              Create
            </Button>
          </div>

          {/* Show new key once after creation */}
          {justCreated && (
            <div className="mt-4 p-3 rounded-md bg-yellow-50 border border-yellow-200 space-y-2">
              <p className="text-sm font-medium text-yellow-800">
                Copy this key now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs break-all font-mono bg-white border rounded px-2 py-1">
                  {justCreated.key}
                </code>
                <Button variant="ghost" size="icon" onClick={() => handleCopy(justCreated.key)}>
                  {copied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setJustCreated(null)}
              >
                Dismiss
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Existing keys */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading keys...</p>
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">No API keys yet.</p>
        ) : (
          keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between p-3 border rounded-lg">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{key.name}</span>
                  <Badge variant="outline" className="text-xs font-mono">
                    {key.keyPrefix}…
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {key.expiresAt
                    ? `Expires ${new Date(key.expiresAt * 1000).toLocaleDateString()}`
                    : "Never expires"}
                  {key.lastUsedAt &&
                    ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteMutation.mutate(key.id)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
