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

## Project conventions

Read [CLAUDE.md](./CLAUDE.md) for architecture and coding conventions. These
repository instructions apply regardless of which assistant or tool is used.
