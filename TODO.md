# BunBase release follow-ups

## 0.2.0 — Production workflows

- [x] Team-workspace starter with organization isolation, invitations, private files, and approvals.
- [x] Readiness and service-key diagnostics with migration-history checks.
- [x] Offline SQLite backup, verification, and restore into a new directory.
- [x] Packed starter tests, production browser recovery, docs, and upgrade guidance.
- [ ] Review the 0.2.0 PR and authorize package publication separately.

The 0.1.0 notes below are historical; the current implementation and release
contracts are documented in the package changelog and `docs/UPGRADING-0.2.md`.


The September 2026 refresh resolved the earlier workspace dependency, Drizzle
version, example typecheck, scaffold, and package build issues. See
[UPGRADE-NOTES.md](./UPGRADE-NOTES.md) for the verified work and limitations.

## Before publishing 0.1.0

- [x] Fix SDK `listAll()` to follow bounded cursor pages and add regression tests.
- [x] Update pagination documentation, including dynamically constructed and
  oversized limits in consuming applications.
- [x] Verify the dedicated PostgreSQL integration suite against a disposable database.
- [x] Expand SQLite/PostgreSQL database and SDK regressions, including schema upgrades.
- [x] Verify the MySQL integration smoke on DBngin MySQL 9.7.2.
- [x] Resolve the review findings below before treating 0.1.0 as release-ready.
- [ ] Complete the deferred security review areas before release; the partial scan was not a complete audit.
- [ ] Review the final diff and authorize publication. No automatic release.

## 0.1.0 review findings

All ten review findings have fixes and permanent regression coverage. The full
verification command now passes with 690 tests; the separate SQLite/PostgreSQL/MySQL
suite passes 46 tests, including concurrent claims and ownership rollback.
These follow-up changes are included on branch `0.1.0`; publication still requires authorization.

- [x] Require completed MFA before changing MFA settings or regenerating backup codes.
- [x] Apply related-table hidden-field policies to expanded objects and arrays.
- [x] Make TOTP replay prevention atomic under concurrent verification requests.
- [x] Verify that each invitation consumption actually claimed an available use.
- [x] Make ownership transfers roll back fully on SQLite and test concurrent transfers.
- [x] Keep mandatory-MFA configuration isolated to each server instance.
- [x] Support passwordless account-deletion confirmation in the client SDK.
- [x] Include MFA challenge results in all passwordless-login SDK return types.
- [x] Keep list totals independent of cursor position and expose counts in the SDK.
- [x] Process invitation codes separately from user-table signup fields.

## Additional authorization findings

- [x] Enforce the parent-record SQL predicate before deleting files; provide
  `record` to boolean rules and reject orphaned files.
- [x] Replace `orgMember`, `orgAdmin`, and `orgOwner` placeholders with persisted
  membership/role checks. Document the async `(orgId, auth, db)` signature.
- [x] Cover denied-file preservation and allowed deletion through HTTP, all
  organization roles, nonmembers, revoked memberships, and database lookup failure.
- [x] Verify membership queries on SQLite, PostgreSQL, and MySQL.

The partial security review's deferred authentication, CRUD, and remaining-file
checks are still unresolved. These fixes address only its confirmed findings.

## Optional follow-ups

- Set the docs canonical site URL when its hosting destination is established.
- Exercise physical passkey enrollment and authentication.
- Consider schema-drift tooling, OpenAPI generation, thumbnails, and backup CLI as
  separate features; they are outside this dependency update.
