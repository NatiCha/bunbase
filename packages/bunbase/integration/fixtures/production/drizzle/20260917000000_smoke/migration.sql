CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
--> statement-breakpoint
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
