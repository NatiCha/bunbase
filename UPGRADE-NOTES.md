# September 2026 dependency refresh

Implemented directly in the existing checkout on September 15, 2026. Existing
uncommitted 0.1.0 changes were retained. The combined work is being checkpointed
on branch `0.1.0`; it is not release-ready. See [TODO.md](./TODO.md) for the ten
review findings to address before publication. No package has been published.

## Versions

| Component | Updated version |
| --- | --- |
| Bun / Bun types | 1.4.2 |
| TypeScript (library, example, tools) | 7.0.2 |
| Biome | 2.5.13 |
| Drizzle ORM / Kit | 1.0.0-rc.4, matched exact pins |
| SimpleWebAuthn server | 14.0.2, optional consumer peer |
| React / React DOM / React types | 19.3.0 |
| TanStack React Query | 5.102.8 |
| Tailwind CSS / tailwind-merge | 4.3.3 / 3.7.0 |
| Lucide React | 1.46.0 |
| Clack / Zod | 1.8.1 / 4.6.5 |
| Astro / Starlight | 7.3.2 / 0.42.1 |
| Sharp | 0.35.4 |

Radix packages were updated together. The docs keep a separate Bun lockfile and
TypeScript 6 compatibility package for Astro's compiler API requirements.

## Implementation

- Fixed scoped workspace dependencies, example imports, scaffold imports, and install docs.
- Regenerated Bun lockfiles and removed the stale package-level npm lockfile.
- Added explicit tool dependencies, Bun engine requirements, and pinned CI runtime.
- Migrated Biome configuration; check/lint/format are read-only with separate fix scripts.
- Removed TypeScript `baseUrl`, added explicit Bun types and frontend CSS declarations.
- Updated Drizzle SQLite/MySQL constructors and relation generics for rc.4.
- Corrected Web Crypto buffer types; S3 signs and sends the same owned snapshot.
- Compiled the real CLI entry point and embedded package metadata to preserve scaffold versions.
- Published type exports use generated declarations; archives include admin assets and types,
  without bundling the platform-specific CLI executable into the npm package.
- Added CLI `--skip-install` and `--no-start` options plus a consumer-install smoke check.
- Added `serverFields` to SDK/React input types, paired with ownership enforcement in the example.
- Migrated Starlight sidebar configuration and supplied missing page titles.
- Expanded CI to cover the whole workspace, docs, packed-package workflow, and external databases.

## Verified locally

`bun run verify` completed successfully:

- Read-only Biome checks.
- Library, example, tool, and declaration TypeScript checks.
- Compiled CLI and admin UI builds.
- **647 tests passed, 0 failed** (55 test files).
- Astro checks: 0 errors, warnings, or hints; **31 docs pages built**.
- Packed package installation, generated-project typecheck and tests, migration generation,
  generated server startup, registration, and admin asset responses.
- Frozen installs for both the root workspace and docs.
- `git diff --check`.

Browser checks against a disposable instance of the actual example confirmed login,
project creation without a client-supplied owner, task creation, session persistence,
realtime dashboard updates from a separate API request, logout, and admin UI rendering.
React/Radix dialogs, Lucide icons, and Tailwind styling rendered successfully.

## Remaining verification limits

- The PostgreSQL and MySQL integration tests were **skipped locally** because no test
  servers were available. CI now provisions PostgreSQL 17 and MySQL 8.4 and runs real
  generated migrations, repeated bootstrap/migration checks, and Drizzle CRUD. That
  hosted workflow has not been run or pushed from this session. Follow-up: the
  PostgreSQL suite passed on September 15 against a freshly created disposable
  local database, which was removed afterward. The fixture now supplies the
  explicit CORS origin required by its production-mode configuration. MySQL
  was subsequently verified on DBngin MySQL 9.7.2; see the follow-up below.
- SimpleWebAuthn 14 option generation, stored challenges, and invalid-response handling
  were tested; physical passkey enrollment/authentication was not exercised.
- The docs build emits warnings for the optional empty i18n collection, missing custom
  404 entry, and unset canonical `site` (sitemap skipped). The static build and search
  index succeed. Set a canonical site URL when the hosting destination is established.

## Commands

```sh
bun install --frozen-lockfile
bun install --cwd docs --frozen-lockfile
bun run verify
bun run dev
bun run preview:example
```

Use `bun run test:databases` with `BUNBASE_TEST_POSTGRES_URL` and
`BUNBASE_TEST_MYSQL_URL` pointing only to disposable test databases. Without those
variables the corresponding tests report skips.

## SDK pagination follow-up

Fixed `listAll()` to traverse cursor pages of up to 100 rows; the previous
implementation sent the removed `limit=-1` sentinel and silently returned at most
20 rows. Filters, sorting, and relation expansions persist across pages. Later
request failures, missing/repeated cursors, and malformed row arrays reject the
call instead of returning partial results.

Added eight regression tests, including 235 rows against a real SQLite server,
filtered descending results with duplicate sort values and expanded relations,
exact page boundaries, empty results, authenticated requests, and failure paths.
The full `bun run verify` passed with **655 tests** and the packed scaffold smoke.
Updated the SDK docs, upgrade guide, changelog, and stale TODO notes.

CMAIS now installs `naticha-bunbase-0.1.0-listall.tgz`; a new archive name avoids
reusing cached contents under the unchanged 0.1.0 package version. Its complete
verification passes with **171 tests**. No commits, pushes, or publication.

## Database and consumer regression follow-up

Added seven shared scenarios per dialect in `integration/database-regression.test.ts`:
decoded timestamp/JSON/boolean/null values; SDK CRUD over HTTP; ascending/descending
pagination by text and timestamps with duplicate values and optional relations;
to-many/empty expansions; denied and SQL-filtered relation access with aliased
schema keys; and real generated schema upgrades that preserve existing rows and
can be applied twice.

These tests reproduced two bugs before the fixes: SQLite timestamp cursors passed
JSON strings into Drizzle's Date encoder on subsequent pages, and expansion checked
rules using the schema export key instead of the SQL table name. The fixes restore
Date values for date columns and resolve the related table's SQL name for rules.

`bun run test` includes the SQLite suite in a separate process, isolating it from
the unit suite's global migrator mock. `bun run test:databases` runs the same suite
plus the existing database smoke tests. PostgreSQL uses only the explicitly supplied
disposable test URL; MySQL remains out of scope. CMAIS was not modified.

### Verification

The dedicated run passed **15 tests** (seven SQLite, seven PostgreSQL, and the
existing PostgreSQL smoke) with **0 failures**. MySQL was skipped. The disposable
local PostgreSQL database was removed afterward.

The full `bun run verify` also passed: **655 existing tests plus seven SQLite
regressions**, typechecks, builds, documentation checks, and the installed-package
scaffold smoke. PostgreSQL cases skip in that run without their test URL and were
verified separately above. `git diff --check` passed. No commits or publication.

## MySQL DBngin follow-up

Created a DBngin-managed **BunBase MySQL 9.7** instance using its newest offered
Apple Silicon build, **9.7.2**, with the `bunbase_test` database on
`127.0.0.1:3306`. The service uses a dedicated socket (`/tmp/bunbase_mysql.sock`)
and a local-only bind configuration; automatic start on login is disabled.
DBngin's default local account is `root` with an empty password.

The integration smoke initially failed during bootstrap because `_invites.role`
and `_organization_invites.role` used literal defaults on TEXT columns. Changed
them to `DEFAULT ('user')` and `DEFAULT ('member')`, preserving the existing types
and values. The smoke now also inserts rows with role omitted and asserts both
database defaults. Generated migrations, repeated bootstrap/migrations, CRUD,
and both defaults passed on MySQL 9.7.2. This is the dedicated MySQL smoke;
the seven expanded consumer scenarios above still target SQLite/PostgreSQL.

Run from the repository root while the DBngin service is running:

```sh
BUNBASE_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306/bunbase_test bun run test:databases
```

## shadcn component maintenance

Reviewed the `@shadcn` New York / Radix registry with shadcn CLI **4.21.0** on
September 15, 2026. Added `examples/task-manager/components.json` with the existing
Tailwind 4 stylesheet, neutral palette, Lucide icons, and frontend aliases.

Merged upstream changes into all eight example components: button, input, textarea,
select, badge, dialog, label, and card. The components now use React 19 ref props,
`data-slot` attributes, improved focus/invalid states, and the expanded upstream
composition APIs. Select menus include scroll controls and available-height bounds;
dialogs keep a 16px margin at phone widths. Select items are grouped, and task selects
have associated accessible labels. Added `tw-animate-css` **1.4.0** and its stylesheet
import so the existing animation utilities work, with a reduced-motion override.

Preserved the example's button cursor, existing sizes/shadows, card padding, badge
shape and div-based props, full-width popper selects, textarea minimum height, and
dialog overlay opacity. Kept the local `cn` helper and individually pinned Radix
packages. These files deliberately differ from the registry; a full overwrite
would discard these choices. The copied component files now participate in Biome
checks instead of being excluded.

The admin sidebar received a selective merge: slot attributes, Tailwind 4 outline
utilities, submenu grouping, and outline shadows using the actual theme variables.
Its desktop layout, direct Radix imports, inlined primitives, and omitted mobile
Sheet/Skeleton behavior remain intentional. Review this file manually against the
registry; the example CLI configuration does not manage the admin UI.

### Future reviews

Run from `examples/task-manager`:

```sh
bunx --bun shadcn@latest info --json
bunx --bun shadcn@latest add button input textarea select badge dialog label card --dry-run
bunx --bun shadcn@latest add button --diff button.tsx
bunx --bun shadcn@latest view @shadcn/sidebar
```

Repeat the per-file diff for each component and merge relevant changes, retaining
the adaptations above. Preview dependency and CSS changes before applying them.
See the official [CLI documentation](https://ui.shadcn.com/docs/cli) and
[Tailwind 4 migration guide](https://ui.shadcn.com/docs/tailwind-v4).

The full `bun run verify` passed again after the component refresh: **647 tests**,
typechecks, builds, docs checks, and packed scaffold smoke checks. Frozen install
and `git diff --check` passed. Browser checks covered login, project/task creation,
keyboard selection, accessible select labels, Escape dismissal, dashboard/cards/
badges, a 390px-wide dialog/select, and admin sidebar collapse/expansion. No browser
errors were reported; Bun emitted a development hot-update fallback warning during
editing. All test data lived in a disposable preview database.
