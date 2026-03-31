# Organizations / Teams

Multi-tenant auth. Users belong to organizations with per-org roles.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      organizations: {
        enabled: true,                              // default: false
        roles: ["owner", "admin", "member"],        // default
        maxOrgsPerUser: 10,                         // default: 10
        inviteTtl: 604800,                          // org invite TTL in seconds, default: 604800
      },
    },
  }),
});
```

## Roles

Roles form a hierarchy: `owner > admin > member`. The creator of an org is automatically assigned `owner`.

| Role | Can do |
|---|---|
| `owner` | Everything, including deleting the org and transferring ownership |
| `admin` | Manage members and invites, update org name |
| `member` | View org and members |

## Endpoints

### Organizations

| Method | Path | Min Role | Description |
|---|---|---|---|
| `POST` | `/auth/organizations` | authenticated | Create org |
| `GET` | `/auth/organizations` | authenticated | List user's orgs |
| `GET` | `/auth/organizations/:id` | member | Get org + members |
| `PATCH` | `/auth/organizations/:id` | admin | Update org name |
| `DELETE` | `/auth/organizations/:id` | owner | Delete org |

### Members

| Method | Path | Min Role | Description |
|---|---|---|---|
| `GET` | `/auth/organizations/:id/members` | member | List members |
| `PATCH` | `/auth/organizations/:id/members/:userId` | admin | Update member role |
| `DELETE` | `/auth/organizations/:id/members/:userId` | admin | Remove member |
| `POST` | `/auth/organizations/:id/leave` | member | Leave org |

### Invites

| Method | Path | Min Role | Description |
|---|---|---|---|
| `POST` | `/auth/organizations/:id/invites` | admin | Send invite |
| `GET` | `/auth/organizations/:id/invites` | admin | List pending invites |
| `DELETE` | `/auth/organizations/:id/invites/:inviteId` | admin | Cancel invite |
| `POST` | `/auth/organization-invites/accept` | authenticated | Accept invite (CSRF-exempt) |

## Usage example

```ts
// Create an org
const { organization } = await client.auth.organizations.create({ name: "Acme Inc." });

// Invite a member
const { invite } = await client.auth.organizations.invite(organization.id, {
  email: "bob@example.com",
  role: "member",
});

// Bob accepts the invite
await client.auth.organizations.acceptInvite(token);

// List members
const { members } = await client.auth.organizations.listMembers(organization.id);

// Promote a member
await client.auth.organizations.updateMember(organization.id, bob.id, { role: "admin" });

// Remove a member
await client.auth.organizations.removeMember(organization.id, bob.id);
```

## Using org membership in rules

Use the `requireOrgRole` helper in extend routes, or check membership in hooks:

```ts
import { requireOrgRole } from "bunbase";

extend: ({ db, extractAuth }) => ({
  "/api/org-data": {
    async GET(req) {
      const user = await extractAuth(req);
      const orgId = new URL(req.url).searchParams.get("orgId")!;
      await requireOrgRole(db, internalSchema, user.id, orgId, "member");
      // ...
    },
  },
}),
```

## Hooks

```ts
defineAuthHooks({
  afterOrgCreate: async ({ organization, userId }) => {},
  afterOrgMemberAdd: async ({ orgId, userId, role }) => {},
  afterOrgMemberRemove: async ({ orgId, userId }) => {},
  afterOrgInviteAccept: async ({ orgId, userId, email }) => {},
});
```
