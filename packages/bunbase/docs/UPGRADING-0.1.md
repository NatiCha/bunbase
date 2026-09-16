---
title: Upgrading to 0.1
description: Migrate existing BunBase applications to version 0.1.
---

# Upgrading to `@naticha/bunbase` 0.1.0

> **Audience: an AI coding agent (or developer) working inside an app that
> depends on bunbase.** This document tells you exactly what changed, how to
> detect whether this app is affected, and what to change. Work top to bottom.
> Each item has **Detect → Fix → Verify**. After finishing, run the app's
> type-checker and tests.

0.1.0 is a **security release with breaking changes**. The theme: bunbase now
(1) protects sensitive columns at the data boundary, (2) blocks mass-assignment,
(3) closes MFA bypasses, and (4) makes the client SDK throw typed errors. None of
these are opt-in — they change default behavior.

If you maintain this app, work through the checklist. If nothing in a section
matches, skip it. **Do not** invent tables/columns that don't exist in this repo;
inspect the actual Drizzle schema and `createServer(...)` call first.

---

## 0. Orient yourself in this repo first

Run these to find the bunbase integration points before changing anything:

```bash
# Where is the server configured?
grep -rln "createServer(" --include=*.ts .
# Where is the client/react SDK created?
grep -rln "createBunBaseClient\|createBunBaseReact" --include=*.ts --include=*.tsx .
# Drizzle schema file(s)
grep -rln "sqliteTable\|pgTable\|mysqlTable" --include=*.ts .
```

Hold the schema and the `createServer` options in mind for the rest of this doc.

---

## 1. Set `NODE_ENV=development` for local dev  ← do this first, everyone is affected

**What changed.** Security toggles (Secure cookies, strict CORS) are now ON
whenever `NODE_ENV` is **not** exactly `development`. An *unset* `NODE_ENV` is
treated as production (fail-closed). Previously unset `NODE_ENV` meant dev.

**Why it breaks you.** If you run the dev server over `http://localhost` with
`NODE_ENV` unset, cookies become `Secure` and the browser won't send them over
http → login appears to silently fail. CORS also stops reflecting arbitrary
origins.

**Detect.**
```bash
grep -rn "NODE_ENV\|\"dev\"\|--hot" package.json
```
Look at the script that starts the bunbase server. If it does **not** set
`NODE_ENV=development`, you're affected.

**Fix.** Prefix the dev server script:
```jsonc
// package.json
"dev:server": "NODE_ENV=development bun --hot src/server.ts"
```
If the app passes config explicitly, you can instead set
`config: { development: true }` in dev. Production should run with
`NODE_ENV=production` (unchanged).

**Verify.** Start the dev server, log in through the browser, confirm the session
cookie is set and `/auth/me` returns the user.

---

## 2. Stop sending server-controlled fields through CRUD

bunbase now refuses to write columns the client shouldn't control.

### 2a. Registration must not send `emailVerified`

**What changed.** `POST /auth/register` rejects `emailVerified`/`email_verified`
in the body (previously a client could self-verify).

**Detect.**
```bash
grep -rn "register(" --include=*.ts --include=*.tsx . | grep -i "emailVerified"
grep -rn "emailVerified" src/**/*Register* src/**/*SignUp* 2>/dev/null
```

**Fix.** Remove `emailVerified` from the registration payload. Verification is set
by the email-verification flow / a hook / the admin API.

**Also:** if your `users` table declares `emailVerified` as `NOT NULL` without a
default, add a default so inserts succeed:
```ts
emailVerified: integer("email_verified").notNull().default(0),
```

### 2b. `id` and timestamps are immutable on update; `id` auto-generates on create

**What changed.** `PATCH /api/:table/:id` ignores `id`, `createdAt`,
`created_at`, `updatedAt`, `updated_at` in the body (a client can't re-key a row
or backdate it). On create, if you don't send `id` and the schema's id column has
no default, bunbase generates a UUIDv7.

**Detect.**
```bash
grep -rn "\.update\.\|update(.*mutationOptions\|PATCH" --include=*.tsx --include=*.ts . | grep -iE "createdAt|updatedAt|\bid\b"
```

**Fix.** Drop `id`/timestamps from update payloads. (No action needed if you
already don't send them.)

### 2c. Mark privileged columns `readonly` (otherwise users can mass-assign them)

**What changed.** There is a new `fields` option on `createServer`. **Hidden**
columns are stripped from all output and can't be filtered/sorted; **readonly**
columns can never be written via CRUD. Password-hash columns are always hidden +
readonly automatically. Everything else is writable unless you say otherwise.

**Why it matters.** If you expose a table via CRUD and a rule lets a user update
their own row, they can still set *any* writable column — e.g.
`PATCH /api/users/<me> { "role": "admin" }`. Mark such columns `readonly`.

**Detect.** For each table exposed through `rules` in `createServer`, look for
privileged/sensitive columns: `role`, `isAdmin`, `plan`, `credits`, `balance`,
`ownerId`, `organizationId`, `emailVerified`, MFA/secret/token columns.
```bash
grep -rn "role\|isAdmin\|plan\|credits\|emailVerified\|secret\|token" <your schema file>
```

**Fix.** Add a `fields` map next to `rules`:
```ts
import { createServer, defineFields } from "@naticha/bunbase";
import * as schema from "./schema";

createServer({
  schema,
  rules,
  fields: {
    users: defineFields(schema.users, {
      // never returned to clients, not filterable/sortable:
      hidden: ["mfaSecret"],
      // never settable via CRUD (set by hooks/admin/auth only):
      readonly: ["role", "emailVerified", "plan"],
    }),
  },
  // ...
});
```
The untyped form also works: `fields: { users: { readonly: ["role"] } }`.

To stamp a server-controlled value (instead of trusting the client), use a hook:
```ts
import { defineHooks } from "@naticha/bunbase";
hooks: {
  projects: defineHooks(schema.projects, {
    beforeCreate: ({ data, auth }) => ({ ...data, ownerId: auth?.id }),
  }),
}
```
and remove `ownerId` from the client create payload.

**Verify.** As a non-admin user, `PATCH` your own row with `{ "role": "admin" }`
and confirm the role does **not** change.

---

## 3. Client SDK now throws typed errors

**What changed.** Every client method now throws `BunBaseClientError` on a non-2xx
response (previously most `auth.*`, `files.*`, and realtime methods returned the
error envelope typed as success). `BunBaseClientError` is a class with
`code`, `message`, `status`, and optional `fields`.

**Detect.**
```bash
# Calls that inspect the returned object for errors instead of catching:
grep -rn "\.auth\.\|\.magicLink\.\|\.otp\.\|\.mfa\.\|\.passkeys\.\|\.sessions\.\|\.organizations\.\|\.files\.\|\.invites\.\|\.apiKeys\." --include=*.ts --include=*.tsx . \
  | grep -vi "queryOptions\|mutationOptions"
```
Look for code like `const res = await client.auth.login(...); if (res.error) {...}`
or that reads `res.user` without a try/catch.

**Fix.** Wrap calls in `try/catch` and read the error from the thrown value:
```ts
import { BunBaseClientError } from "@naticha/bunbase"; // or "@naticha/bunbase"
try {
  const { user } = await client.auth.login({ email, password });
} catch (e) {
  if (e instanceof BunBaseClientError) {
    // e.code, e.message, e.status, e.fields
  }
}
```
If you use the React hooks, `useAuth().login` now throws `BunBaseClientError`
(was a plain `Error`); update any `catch` blocks that special-cased `Error`.

**Verify.** Trigger a failed login (wrong password) and confirm your error UI shows
the message instead of crashing on `undefined`.

---

## 4. MFA: handle the second factor on every login path

Only relevant **if this app uses MFA (TOTP)** with social/passwordless login. If
you don't use `auth.mfa.totp`, skip.

**What changed.** Magic-link, email OTP, SMS OTP, and OAuth login now return a
**pending** session for users who have TOTP enrolled, and the login response is
`{ mfaRequired: true, mfaMethods: ["totp"] }` (OAuth redirect gains
`?mfa_required=1`). The session does not grant API access until the user completes
`POST /auth/mfa/totp/verify`. Previously these paths fully logged the user in
(the bypass this release fixes).

`auth.login`, `auth.magicLink.verify`, `auth.otp.verify`, and `auth.smsOtp.verify`
now return the discriminated union
`{ user } | { mfaRequired: true; mfaMethods: string[] }`.

**Detect.**
```bash
grep -rn "mfaRequired\|mfa/totp/verify\|magicLink\|smsOtp\|oauth" --include=*.ts --include=*.tsx .
```

**Fix.** After any login call, branch on `mfaRequired` and route the user to your
TOTP entry screen, then call the verify endpoint:
```ts
const result = await client.auth.login({ email, password });
if ("mfaRequired" in result) {
  // show TOTP input, then:
  await client.auth.mfa.verify(code);   // completes the pending session
} else {
  // result.user is authenticated
}
```
For OAuth, handle `?mfa_required=1` on your callback page.

Also note: `config.auth.mfa.required = true` is now actually enforced — users
without MFA are gated until they enroll. Only set it if your UI has an enrollment
flow.

**Verify.** With a TOTP-enrolled user, log in via each method you support and
confirm you're prompted for the code before API calls succeed.

---

## 5. CSRF now covers `/files/*` and `PUT`

**What changed.** Cookie-authenticated requests to `/files/*` (upload/delete) and
any `PUT` under `/api/`, `/_admin/api/`, or `/files/` now require the
`X-CSRF-Token` header. Bearer/API-key requests (no session cookie) still bypass
CSRF.

**If you use the bunbase client SDK:** nothing to do — `files.upload`/`files.delete`
now send the token automatically (you just need the updated SDK, which ships in
0.1.0).

**Detect (only if you call these endpoints with hand-rolled `fetch`):**
```bash
grep -rn "/files/\|method:\s*['\"]PUT" --include=*.ts --include=*.tsx . | grep -i fetch
```

**Fix.** Send the CSRF token (read from the `csrf_token` cookie) on those requests,
or switch to the SDK helpers.

**Verify.** Upload a file while logged in via cookies; confirm 2xx.

---

## 6. Other behavior changes (usually no code change needed)

- **`limit=-1` no longer returns the whole table.** It clamps to the default page
  size (20); max page is 100. If you relied on `?limit=-1` to fetch everything,
  use the updated SDK's `listAll()` or paginate with `list()` and `nextCursor`.
  Audit dynamically constructed query parameters too: `searchParams.set("limit", "-1")`
  and oversized values such as `limit=1000` also return only a bounded page. Search
  all `limit` assignments and review callers that assume one response is complete.
  Preserve filters, sorting, and expansions on every cursor request; verify with
  more than 100 matching records. Raw API requests remain capped at 100 rows.
- **Password change logs out other sessions/keys.** `POST /auth/change-password`
  now returns a fresh `Set-Cookie` and revokes the user's other sessions and **all**
  their API keys. Bearer/API-key callers must mint a new key afterward.
- **Account deletion for passwordless accounts** requires `{ confirmEmail }` in the
  body matching the account email (password accounts still require the password).
- **CORS** in production only reflects origins in `config.cors.origins`. Ensure
  your production origins are listed.
- **`?count=true`** on list endpoints now returns a `total` field — opt-in, additive.
- **`auth.rateLimit.{max,windowMs}`** is now configurable (default 10 / 60s).

---

## 7. Keep your Drizzle version pinned to bunbase's

bunbase ships `drizzle-orm` as a regular dependency and relies on Symbol-based
table identity. If your app installs a **different** drizzle-orm version, you get
two physical copies and table identity breaks (rule/hook/relations types stop
matching, runtime `getTableName` mismatches).

**Detect.**
```bash
grep '"drizzle-orm"' package.json
# Compare to bunbase's pin:
cat node_modules/@naticha/bunbase/package.json | grep drizzle-orm
bun pm ls | grep drizzle-orm   # should show ONE version
```

**Fix.** Pin `drizzle-orm` (and `drizzle-kit`) in your app to the **exact** version
bunbase depends on (0.1.0 uses `1.0.0-rc.4`), then reinstall.

**Verify.** `bun pm ls | grep drizzle-orm` shows a single version.

---

## Final checklist

```bash
bun run type   # or: bunx tsc --noEmit
bun test
```

Then manually: log in (cookie + MFA if used), create/update a record, upload a
file, and confirm a privileged column can't be mass-assigned. If all pass, the
upgrade is complete.

## Toolchain refresh (September 2026)

- Use Bun 1.4.2 or newer; the repository and CI pin 1.4.2 for reproducibility.
- Pin both Drizzle packages to `1.0.0-rc.4`. Its SQLite/MySQL clients now take
  `relations` without `schema`, and their database types have one relation generic.
- TypeScript 7 replaces `baseUrl` with relative `paths`; include `types: ["bun"]`.
  Use explicit CSS module declarations for frontend side-effect imports.
- Package exports now point TypeScript to generated declarations. Build the package
  before consuming it from a checkout; published archives contain these declarations.
- Passkeys use the optional `@simplewebauthn/server@^14.0.2` peer. Applications that
  enable passkeys must install it; ordinary consumers do not need the provider.
- Use `serverFields` in clients for columns filled by server hooks, as described
  in [the client guide](./client.md#server-assigned-fields).

## Organization rule helpers now require the database

**Detect.** Search for `orgMember(`, `orgAdmin(`, and `orgOwner(`.

**Fix.** These helpers now return `Promise<boolean>` and require the current
rule's database as their third argument. The old two-argument placeholders did
not check membership. Omitted database arguments now deny access at runtime and
fail TypeScript checks.

```ts
update: ({ record, auth, db }) => orgAdmin(record?.orgId as string, auth, db)
```

When combining checks, use `await orgAdmin(orgId, auth, db)` inside an async rule.
Do not use an unawaited promise in a boolean condition. Use persisted record
organization IDs for update/delete, and protect that field from reassignment.

**Verify.** A nonmember must receive 403. Members cannot perform admin/owner
operations; organization admins cannot perform owner-only operations. Removing
membership must deny the next request.

File deletion now enforces SQL predicates returned by the collection's delete
rule and supplies the parent `record` to boolean rules. Check that owners can
still delete files and nonowners cannot; orphaned file records are denied.
