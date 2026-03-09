import type React from "react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";

type Mode = "login" | "register" | "forgot";

interface LoginFormProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, name: string) => Promise<void>;
}

export function LoginForm({ onLogin, onRegister }: LoginFormProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setInfo("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    try {
      if (mode === "login") {
        await onLogin(email, password);
      } else if (mode === "register") {
        await onRegister(email, password, name);
        setInfo("Check your email to verify your account.");
      } else if (mode === "forgot") {
        await client.auth.requestPasswordReset(email);
        setInfo("If an account exists, a reset link has been sent.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">Task Manager</h1>
        <p className="text-sm text-muted-foreground mt-1">Powered by BunBase</p>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">
            {mode === "login" && "Sign in"}
            {mode === "register" && "Create an account"}
            {mode === "forgot" && "Reset password"}
          </CardTitle>
          <CardDescription>
            {mode === "login" && "Enter your email and password to sign in"}
            {mode === "register" && "Enter your details to get started"}
            {mode === "forgot" && "Enter your email and we'll send a reset link"}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>

            {mode !== "forgot" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "login" && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                      onClick={() => switchMode("forgot")}
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "At least 8 characters" : "Password"}
                  required
                  minLength={mode === "register" ? 8 : undefined}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {info && (
              <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                {info}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "Loading..."
                : mode === "login"
                  ? "Sign in"
                  : mode === "register"
                    ? "Create account"
                    : "Send reset link"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm">
            {mode === "login" && (
              <span className="text-muted-foreground">
                Don't have an account?{" "}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => switchMode("register")}
                >
                  Create one
                </button>
              </span>
            )}
            {mode === "register" && (
              <span className="text-muted-foreground">
                Already have an account?{" "}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => switchMode("login")}
                >
                  Sign in
                </button>
              </span>
            )}
            {mode === "forgot" && (
              <button
                type="button"
                className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => switchMode("login")}
              >
                Back to sign in
              </button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
