# Repository instructions

These rules apply to every contributor and coding assistant working in this repository.

## Branches and commits

- Use plain, descriptive branch names. Do not include assistant, model, vendor, or
  tool names or prefixes in branch names unless the user explicitly requests them.
- Do not add AI attribution to commit messages, pull request descriptions, or
  source changes. This includes assistant co-author trailers, generated-by
  signatures, badges, tags, emojis, or other markers identifying code as AI-written.
- Use the repository's configured Git author and committer identity. Do not replace
  it with an assistant identity or add an assistant as a co-author.
- Only commit or push when explicitly authorized by the user. Authorization for a
  checkpoint does not authorize later commits, pushes, or releases automatically.
- Preserve existing work. Do not discard changes, rewrite history, force-push, or
  publish packages unless the user explicitly requests it.

## How to use this guide

- Keep repository guidance here. `CLAUDE.md` must contain only `@AGENTS.md`.
- Before editing, inspect the working tree and read the relevant source, tests, and
  documentation. Existing uncommitted changes may belong to another task.
- Treat package manifests, scripts, and `.github/workflows/ci.yml` as the source of
  truth for tool versions and commands. Update this guide when those workflows change.
- Read the relevant file under `packages/bunbase/docs/` before changing a feature.
  Verify behavior against the implementation when documentation and code disagree.

## Repository map

- `packages/bunbase/`: published `@naticha/bunbase` library and CLI.
- `packages/bunbase/src/index.ts`: public server API and exports.
- `packages/bunbase/src/core/`: server/configuration, database setup, field policies,
  and SQLite/PostgreSQL/MySQL adapters.
- `packages/bunbase/src/`: feature modules including `auth/`, `crud/`, `rules/`,
  `hooks/`, `realtime/`, `storage/`, `jobs/`, and `mailer/`.
- `packages/bunbase/admin-ui/`: React admin UI; bundled into `dist/admin` by
  `packages/bunbase/build-admin.ts`.
- `packages/bunbase/src/cli/`: scaffolder and generated application templates.
- `packages/bunbase/src/__tests__/`: source tests;
  `packages/bunbase/integration/`: database and security integration suites.
- `examples/task-manager/`: demo application using the workspace library.
- `packages/bunbase/docs/`: canonical Markdown documentation, including frontmatter.
- `docs/`: Astro/Starlight site. `docs/src/content/docs` is a symlink to the canonical
  documentation; edit the source files rather than replacing the symlink.
- `scripts/smoke-scaffold.ts`: packs the library, scaffolds and installs a consumer
  app, then checks its types, tests, migrations, startup, registration, and admin assets.

Package subpaths are defined in `packages/bunbase/package.json`:

| Import | Purpose |
| --- | --- |
| `@naticha/bunbase` | Server API, rules, hooks, auth, jobs, and helpers |
| `@naticha/bunbase/client` | Frontend SDK (`createBunBaseClient`) |
| `@naticha/bunbase/react` | React integration (`createBunBaseReact`) |
| `@naticha/bunbase/testing` | Test utilities (`createTestServer`) |

Runtime exports point to TypeScript source; declaration exports point to
`dist/types`. Public API changes must keep source exports, generated declarations,
consumer usage, and documentation consistent. Do not hand-edit build outputs.

## Tooling and commands

Use Bun for package management, scripts, builds, and tests. Use the version declared
by root `package.json` and CI. Prefer `bun run <script>` and `bunx` over npm/yarn/pnpm
or npx. Keep `bun.lock` in sync with intentional dependency changes.

The docs site has its own manifest and lockfile and is outside the root workspace
globs. Install both dependency sets when setting up a checkout:

```sh
bun install --frozen-lockfile
(cd docs && bun install --frozen-lockfile)
bunx playwright install chromium
```

The Astro toolchain also requires Node; see `docs/package.json` for its engine
requirement and CI for the tested version. The Bun preference does not remove that
requirement.

Run these commands from the repository root:

| Command | Purpose |
| --- | --- |
| `bun run dev` | Build admin assets and start the demo server/client |
| `bun run check` | Biome formatting, lint, and import checks |
| `bun run type` | Library, declaration, example, and root script type checks |
| `bun run build:admin` | Build assets required by admin routes and their tests |
| `bun run build` | Build admin assets, compiled CLI, and type declarations |
| `bun run test` | Build admin assets and run source plus SQLite regression suites |
| `bun run test:databases` | Database integration suites, with optional external databases |
| `bun run docs:check` | Astro/content checks |
| `bun run docs:build` | Build the documentation site |
| `bun run smoke` | Exercise a packed consumer app; run `bun run build` first |
| `bun run smoke:production` | Chromium production flows and offline SQLite/upload restore; run `bun run build:admin` first |
| `bun run verify` | Full local CI verification chain, including scaffold and production browser smoke tests |

- Use targeted `bun test <path>` runs while developing. Prefer `bun run test` for
  the standard suite: its separate test processes prevent migration mocks from
  leaking into regression tests. Plain `bun test` at the root is not equivalent.
- For code changes, run relevant tests and checks. Use `bun run verify` for broad
  changes to the public API, scaffolder, packaging, or shared infrastructure.
  For documentation-only changes, validate affected paths/content and use docs
  checks when site content changes; an unrelated full test run is unnecessary.
- Report what actually ran, including failures or skipped database coverage.
- `bun run verify` does not run the separate external-database CI job.
  `BUNBASE_TEST_POSTGRES_URL` and `BUNBASE_TEST_MYSQL_URL` enable the corresponding
  integration cases. Use disposable databases: these suites create tables,
  migrations, and triggers. Unset URLs mean skipped coverage, not verified support.
  CI connects to its disposable MySQL service with `sslmode=require` so password
  authentication runs over TLS with the container's self-signed certificate.
- Fix scripts such as `check:fix` modify files. Scope formatting to the work being
  changed rather than rewriting unrelated work.
- `bun run release` publishes to npm; it requires explicit user authorization.

## Coding conventions

- Follow `biome.json`: two-space indentation, double quotes, semicolons, and a
  100-character line width. Use explicit type imports and existing `.ts`/`.tsx`
  relative-import conventions.
- Keep strict TypeScript checks enabled. Preserve optional-value checks and use
  existing types instead of broad casts that hide a contract mismatch.
- Prefer Bun-native APIs: `Bun.serve`, `bun:sqlite`, `Bun.sql`, `Bun.redis`, built-in
  `WebSocket`, `Bun.file`/`Bun.write`, and Bun shell/process APIs where appropriate.
  Bun loads `.env`; do not add dotenv. Existing `node:` utilities are acceptable.
- Use the existing Drizzle and `DatabaseAdapter` abstractions for database work.
  Shared code must account for SQLite, PostgreSQL, and MySQL; keep dialect-specific
  SQL in the appropriate adapter or explicitly handle the dialect.
- Keep Drizzle ORM and Kit versions aligned with the manifests. Read the relevant
  repository skills in `.agents/skills/` before migration generation, push, or pull.
- The admin UI and demo use Bun HTML imports and the existing Tailwind build setup.
  Follow those patterns rather than introducing an additional frontend bundler.
  The documentation site keeps its existing Astro toolchain.
- Before using unfamiliar Bun APIs, consult documentation matching the installed
  version. If bundled Bun docs are available, use them; otherwise consult official
  Bun documentation. Do not assume `node_modules/bun-types/docs` exists.

## API and test patterns

### Rules and hooks

Missing operation rules deny access. Define each exposed operation explicitly and
prefer typed `defineRules(table, rules)` and `defineHooks(table, hooks)` overloads.
Rule `record` and `auth` can be absent; guard them before ownership checks:

```ts
const postRules = defineRules(schema.posts, {
  list: () => true,
  get: () => true,
  create: ({ auth }) => auth !== null,
  update: ({ record, auth }) =>
    auth !== null && record !== undefined && record.authorId === auth.id,
  delete: ({ auth }) => auth?.role === "admin",
});
```

- Use `true`/`false` for explicit decisions. Legacy `null` means allow, not deny;
  SQL results are row filters and must remain enforced by the consuming operation.
- Use `get`; `view` is a deprecated alias. The multi-table `defineRules({...})`
  overload remains available but does not infer record shapes from tables.
- Organization helpers `orgMember`, `orgAdmin`, and `orgOwner` take `(orgId, auth, db)`
  and return promises. Return or await them in rules.
- CRUD hook contexts include `request: { method, path, ip, headers }`. Consult
  `src/hooks/types.ts` for per-operation data and return types, and
  `src/hooks/auth-types.ts` for auth hooks (paths relative to `packages/bunbase/`).
- `AuthUser` has `id`, `email`, and `role` and supports declaration merging for
  application fields. Adding types does not populate those fields at runtime.
- For changes to authorization or credential handling, include regression cases
  for denied access as well as allowed behavior.

### Test helpers

Prefer `createTestServer` from `@naticha/bunbase/testing` for SQLite HTTP tests. It
creates temporary tables/storage, listens on port `0`, and handles CSRF headers.
Always call `server.cleanup()` in `afterAll`.

- `server.fetch()` is unauthenticated; use `await server.loginAs(...)` and the
  returned session's `fetch()` for authenticated requests.
- Use `server.db` or `await server.adapter.rawExecute(sql, params)` for seeding.
- The helper forces SQLite and development mode. It does not establish production
  cookie/CORS behavior or PostgreSQL/MySQL compatibility; test those explicitly
  when relevant to the change.

### CLI changes

The `bunbase` binary uses `init [name]` (`src/cli/index.ts`). The `create-bunbase`
binary accepts the project name directly (`src/cli/create.ts`). Keep both entry
points and `src/cli/templates.ts` consistent, and exercise the packed scaffold
when changing generated apps or CLI behavior.

## Documentation lookup

Read the relevant guide under `packages/bunbase/docs/`:

- Getting started/data: `quickstart.md`, `schema.md`, `configuration.md`,
  `rules.md`, `hooks.md`, `testing.md`, `UPGRADING-0.1.md`.
- Runtime/client: `client.md`, `realtime.md`, `jobs.md`, `email.md`,
  `extending.md`, `deployment.md`.
- Endpoint and auth contracts: `api/` (CRUD, files, authentication, API/service
  keys, JWT, sessions, MFA, passkeys, organizations, invitations, and other flows).

Keep public behavior changes reflected in these docs and relevant examples.
Update `docs/astro.config.mjs` when a navigation change is needed. Preserve the
frontmatter required by Starlight.

<!-- ccc:start -->
## Project Context — bunbase

Client: personal
Project Hub: /Users/charlessqueri/Library/Mobile Documents/iCloud~md~obsidian/Documents/work/clients/personal/projects/bunbase

This project is managed through the Claude Command Center (CCC). The project hub above is a directory of markdown files containing tasks, status, decisions, PRDs, and session logs. You can read these files directly — they are organized for self-discovery:

```
/Users/charlessqueri/Library/Mobile Documents/iCloud~md~obsidian/Documents/work/clients/personal/projects/bunbase/
├── PROJECT.md        # Project overview and metadata
├── TASKS.md          # Task list with checkbox statuses
├── STATUS.md         # Current project status
├── DECISIONS.md      # Decision log
├── prds/             # Product requirement documents
├── sessions/         # Timestamped session logs
└── comms/            # Client communications
```

Task statuses in TASKS.md: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked.

### CCC CLI
Use the `ccc` CLI for structured operations (creating, updating, scaffolding). Read files directly for exploration.

- List tasks: `ccc task list personal bunbase`
- Project status: `ccc status personal bunbase`
- Update a task: `ccc task update personal bunbase <line> <status>`  (statuses: todo, in_progress, done, blocked)
- Add a task: `ccc task add personal bunbase "<text>"`
- Log a session: `ccc session create personal bunbase "<description>"`
<!-- ccc:end -->
