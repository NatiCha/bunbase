---
title: Team workspace starter
---

Create a complete SQLite application with private team requests, invitations,
attachments, and an approval workflow:

```sh
bunx @naticha/bunbase init my-workspace --template team-workspace -y
```

The CLI installs dependencies, generates migrations, and starts development.
For a non-interactive build without starting a server, add `--no-start`. For files
only, add `--skip-install`, then run `bun install` and `bun run db:generate` inside
the generated project. The installed `create-bunbase` binary accepts the same flags
with the project name directly.

## Try the complete workflow

1. Open `http://localhost:3000`, create an account, and create a workspace.
2. Add a request and upload its supporting attachment.
3. Create an invitation for a second email address. Share the generated token.
4. In another browser profile, register with that email and accept the token under
   **Join a workspace**. Members can read and contribute; owners/admins approve.
5. Approve the request as its workspace owner. Repeated approvals return `409`.

Invitations are shared manually; this starter does not send email. Use **Refresh**
to load changes from other users. The frontend uses Bun HTML imports, plain
TypeScript/CSS, and the typed client SDK. It needs no extra frontend framework.

## What ships

| File | Purpose |
| --- | --- |
| `src/schema.ts` | Users and organization-scoped requests |
| `src/rules.ts` | Row filters, organization rules, protected fields, creation hooks |
| `src/routes.ts` | Atomic approval and authorized attachment listing |
| `src/portal/` | Responsive application UI |
| `src/index.test.ts` | Isolation, invitations, revocation, attachments, and approval tests |
| `Dockerfile`, `compose.yaml`, `Caddyfile` | Single-instance deployment with persistent data and HTTPS |
| `README.md`, `.env.example` | Setup, deployment, upgrade, backup, and recovery instructions |

The existing organization subsystem owns membership; the starter does not create
another organizations implementation. List/get rules filter each record using
persisted membership. Creation checks the submitted organization; updates cannot
move a record to another organization. Creator and approval fields are assigned
by the server. File upload rules receive the parent record and enforce its scope.
A global admin role does not grant customer-workspace membership through these
application routes. The separate `/_admin` UI remains a privileged operator tool.

Approval is an application-specific REST route. It validates organization role
and conditionally updates the open request and approver fields in one SQLite
statement. Direct CRUD cannot forge approval. This illustrates the existing
extension API; it does not introduce a new generic actions framework.

## Validate and deploy

```sh
bun run type
bun test
bun run doctor
```

Follow the generated README to configure a domain, production credentials, and
Docker Compose. Only the proxy exposes ports; the app container runs as the Bun
user, stores data on a volume, and uses `/ready` for health checks. Keep reviewed
migrations and `bun.lock` under version control. Public TLS issuance requires a
reachable domain and open ports 80/443.

The starter fixes its driver to SQLite. Other templates and the library retain
PostgreSQL/MySQL support. Changing the starter's driver also requires adapting its
schema and SQLite-specific approval query.

See [Production operations](/operations/) for diagnostic guarantees and recovery
steps. BunBase's release checks exercise the packed starter in Chromium, including
sign-in and file access after a real backup and restore. Container CI separately
builds the generated image and rehearses restoration with Docker volumes.
