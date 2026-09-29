# Changelog

All notable changes to `@naticha/bunbase` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions
may contain breaking changes).

## 0.2.0 — Production workflows

- Added the `team-workspace` starter: responsive UI, organizations/invitations,
  private attachments, requests, atomic approval, tenant tests, and Docker/Caddy
  deployment/recovery instructions. Both CLI entry points support explicit
  `--template` and `--database` flags.
- Added `/ready` with bounded dependency probes, bootstrap/failure/shutdown states,
  application checks, and a server-side readiness API. `/health` remains liveness.
- Added service-key-only diagnostics and `bunbase doctor`, including JSON output,
  exit codes, migration journal comparison, local-storage access, and environment
  checks. Reports omit secrets and raw dependency errors.
- Added offline SQLite `backup`, `backup verify`, and `restore`: standalone WAL-aware
  snapshots, local files/migrations, optional service-key preservation, checksums,
  integrity validation, and restoration into new directories only.
- File upload rules now receive the parent record/id and enforce SQL predicates
  against that parent before storing attachments.
- Typed rule/hook maps are accepted by server and testing APIs under strict
  TypeScript, including aliased schema exports.
- Expanded packed-package, production browser, and Docker recovery checks.

**Compatibility:** `/ready` is now reserved. Upload predicates that were previously
ignored now deny nonmatching records. Unknown CLI flags now fail. See
[`UPGRADING-0.2.md`](./docs/UPGRADING-0.2.md).

## 0.1.0 — Security & hardening release

This is a security-focused release that closes several data-exposure and
auth-bypass issues found in an audit of the 0.0.x line. It contains **breaking
changes**. See [`docs/UPGRADING-0.1.md`](./docs/UPGRADING-0.1.md) for a
step-by-step migration guide (written to be runnable by a coding agent inside a
consuming app).

### Toolchain and packaging refresh

- Production HTML builds preserve application plugins configured in `bunfig.toml`,
  including Tailwind processing. Added a Chromium smoke check for production
  admin/frontend flows, cookies, CSP, realtime, file transfers, and SQLite restore.
- SIGTERM/SIGINT drain requests, running jobs, and pending request logs before
  closing the database. WebSockets receive close code 1001. Shutdown has a
  ten-second deadline and exits nonzero on timeout or cleanup failure.
- Updated upgrade and deployment guidance for JWT rotation/claims, trusted
  magic-link origins, channel authorization, CSP, backups, and process-local services.

- Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.13, and matched Drizzle 1.0.0-rc.4 pins.
- React 19.3, updated Radix/Lucide/Tailwind/TanStack packages, and Zod 4.6.
- Optional passkeys provider now targets SimpleWebAuthn 14.0.2.
- Fixed workspace and scaffold imports to use `@naticha/bunbase` consistently.
- The compiled executable now runs the CLI; embedded package metadata preserves
  exact Drizzle pins. Added `--skip-install` and `--no-start` options.
- Published packages include generated declarations and admin assets. Passkey
  dependencies are no longer needed to typecheck applications that do not use them.
- `serverFields` describes server-assigned columns in SDK and React mutation types.
- Added read-only checks, installed-package smoke coverage, and database CI services.
- Docs now use Astro 7/Starlight 0.42 with a separate TypeScript 6 API toolchain.

### Security fixes

- JWT verification is isolated per server and requires issuer/audience and family
  claims. Refresh rotates once; replay revokes the family. Logout, password
  reset/change, and account deletion invalidate existing user JWTs.
- PostgreSQL refresh replay recognizes Bun's SQLSTATE error shape, so concurrent
  reuse revokes the family instead of failing before the revocation is stored.
- Magic-link emails use a configured trusted `publicUrl`. Service credentials are
  published atomically to an owner-only file and are omitted from startup logs.
- Realtime rechecks permissions and revoked credentials before delivery, requires
  explicit broadcast/presence authorization, and enforces resource limits.
- Added CSP and other browser response headers, sandboxed development email
  previews, and guards against SMTP header and admin-asset path injection.

- File deletion enforces SQL ownership predicates and provides the parent record
  to boolean rules before removing storage data or metadata.
- `orgMember`, `orgAdmin`, and `orgOwner` now verify persisted membership and role.
  **Breaking:** pass `(orgId, auth, db)` and return or await the resulting promise.

- Pending MFA sessions cannot alter enrollment, disable MFA, or regenerate backup
  codes. TOTP steps, backup codes, and invitation uses are claimed atomically.
- Expanded relationships apply the related table's hidden-field policy, including
  custom secrets and aliased password-hash columns.
- Ownership transfers roll back completely on SQLite/PostgreSQL/MySQL and reject
  competing transfers. Mandatory MFA uses each server's own configuration.

- **Field policy / sensitive-field protection.** New `fields` option on
  `createServer` and a `defineFields` helper. `passwordHash`/`password_hash` are
  now stripped from **every** output path — HTTP bodies, pagination cursors, and
  realtime broadcasts — and cannot be filtered or sorted on. Previously
  `?sort=passwordHash` leaked the hash through the cursor, `?filter` could be used
  as a brute-force oracle on hidden columns, and realtime broadcasts shipped the
  raw row.
- **Mass-assignment blocked.** CRUD create/update only write allow-listed
  columns. `id` and timestamp columns are immutable on update by default;
  password-hash columns are never writable; apps can mark privileged columns
  (`role`, `plan`, …) `readonly`. Registration rejects `emailVerified`.
- **Refresh tokens can no longer be used as access tokens** — the bearer path
  requires `type === "access"`.
- **MFA can no longer be bypassed** via magic-link, email OTP, SMS OTP, or OAuth:
  those paths now issue a pending session and require the second factor when the
  user has TOTP enrolled. TOTP verification is rate-limited and codes are
  single-use within their window. `auth.mfa.required` is now actually enforced.
- **Org admins can no longer self-escalate to owner.** Owner can only be assigned
  via the new `POST /auth/organizations/:id/transfer-ownership` (owner-only);
  members can't change their own role.
- **CSRF** now covers `PUT` and the `/files/*` routes.
- **Strict-by-default CORS and Secure cookies** whenever `NODE_ENV` is not
  explicitly `development` (an unset `NODE_ENV` is treated as production).
- Password change now revokes all other sessions and API keys.
- Account deletion requires confirmation for passwordless accounts.
- Constant-time CSRF comparison; login timing equalized against account
  enumeration; OAuth rejects empty/failed provider responses; invitation
  `useCount` is consumed atomically.
- Top-level error handler — internal errors no longer leak stack traces or raw
  SQL; request bodies are size-limited; local storage has a path-traversal guard.

### Features / DX

- SDK passwordless login methods expose the MFA result union; account deletion
  accepts `{ confirmEmail }` or `{ password }` as well as the existing password string.
- SDK list requests support `count: true`; totals honor permissions and filters
  and remain independent of cursor position.
- Invite-required registration treats `inviteCode` as an auth parameter instead
  of a user-table column.

- Fixed MySQL bootstrap failing on invitation role defaults by using the required
  parenthesized expression syntax for TEXT columns. Verified defaults on MySQL 9.7.2.
- Fixed SQLite timestamp-sorted cursor pagination failing after the first page.
- Fixed relationship expansion permission lookup when schema export keys differ
  from SQL table names; denied and row-filtered related tables remain excluded.
- Added matching SQLite/PostgreSQL regression suites for decoded values, SDK CRUD,
  paginated relations, and data-preserving schema upgrades.
- SDK `listAll()` follows bounded cursor pages instead of the removed `limit=-1`
  sentinel, preserving filters, ordering, and expansions. Failed or stalled pages
  reject instead of silently returning incomplete collections.

- `?count=true` returns a `total` on list responses.
- Client SDK: every method now throws a typed `BunBaseClientError` on non-2xx
  (previously most auth/file/realtime methods returned the error envelope typed
  as success). `auth.login` returns `{ user } | { mfaRequired, mfaMethods }`.
  File upload/delete send the CSRF token. Realtime reconnect uses exponential
  backoff + jitter with an `onStatusChange` callback. New `auth.onAuthStateChange`.
- React: `useRealtimeInvalidation(table)` auto-invalidates query keys on table
  changes; `infiniteQueryOptions` factory wired to cursor pagination.
- Testing: `server.loginAs(userOrEmail)` returns a cookie-bound `fetch` for
  authenticated-route tests.
- CRUD auto-generates a UUIDv7 `id` on create when the schema's id column has no
  default.
- CLI scaffolder now emits `@naticha/bunbase` (was the wrong/nonexistent
  `@naticha/bunbase`) and **exact** `drizzle-orm`/`drizzle-kit` pins (was `"beta"`), sets
  `NODE_ENV=development` in the dev script, and scaffolds a sample test.
- `auth.rateLimit.{max,windowMs}` is now configurable (was hardcoded 10/60s).
- Added CI (typecheck + lint + test) and this changelog.

### Migration

Breaking changes are summarized in [`docs/UPGRADING-0.1.md`](./docs/UPGRADING-0.1.md).
The short version for most apps:

1. Set `NODE_ENV=development` in your local dev script.
2. Stop sending `emailVerified` at registration and `id`/`createdAt` on update.
3. Mark privileged columns (`role`, etc.) `readonly` via the `fields` option if
   you expose those tables through CRUD.
4. Wrap client SDK auth/file calls in `try/catch` (they throw now), and handle
   the `{ mfaRequired }` login result if you use MFA.
5. If you use MFA with social/passwordless login, complete the TOTP step those
   flows now require.
