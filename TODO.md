# BunBase release follow-ups

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
- [ ] Resolve the review findings below before treating 0.1.0 as release-ready.
- [ ] Review the final diff and authorize publication. No automatic release.

## 0.1.0 review findings

The current branch is a work-in-progress checkpoint. The existing 662 tests pass,
but focused reproductions found the following gaps. Add permanent regression
coverage for each correction.

- [ ] Require completed MFA before changing MFA settings or regenerating backup codes.
- [ ] Apply related-table hidden-field policies to expanded objects and arrays.
- [ ] Make TOTP replay prevention atomic under concurrent verification requests.
- [ ] Verify that each invitation consumption actually claimed an available use.
- [ ] Make ownership transfers roll back fully on SQLite and test concurrent transfers.
- [ ] Keep mandatory-MFA configuration isolated to each server instance.
- [ ] Support passwordless account-deletion confirmation in the client SDK.
- [ ] Include MFA challenge results in all passwordless-login SDK return types.
- [ ] Keep list totals independent of cursor position and expose counts in the SDK.
- [ ] Process invitation codes separately from user-table signup fields.

## Optional follow-ups

- Set the docs canonical site URL when its hosting destination is established.
- Exercise physical passkey enrollment and authentication.
- Consider schema-drift tooling, OpenAPI generation, thumbnails, and backup CLI as
  separate features; they are outside this dependency update.
