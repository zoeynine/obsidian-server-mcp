# Contributing

The supported deployment target is a Linux headless server/VPS. Windows is an
optional local development environment, not a deployment compatibility target.
Use Node.js 22 or newer and install dependencies with `npm ci`. CI checks Linux
on Node 22 and 24.

For changes to code, dependencies, builds or tests, run `npm run check` once in
your local environment before submitting. A manual OS/Node matrix is not
required. Use additional Linux evidence for filesystem, permissions, native
dependency or platform-specific changes, and release needs; reuse passing CI
results when they cover the change. Repeat checks only after relevant changes,
failures or an unresolved concern. Documentation-only and instruction-only
edits need a focused readback. Tests create disposable Vault fixtures; do not
point tests at your personal Vault or a deployed service.

Keep filesystem, path, version, parser, patch and semantic rules in `src/core`.
MCP schema validation and result/error mapping belong in `src/transport`;
transport code must not access `node:fs` directly. Vault files remain the source
of truth, with no persistent search index.

Treat every tool path as untrusted Vault-relative input. Keep containment,
symlink, protected-path and exact-byte `ifMatch` checks intact. Mutations use
the shared atomic publication layer. Add focused regression coverage when
changing these contracts, and document intentional compatibility changes.

Edit README sections marked `obsidian-help` to change tool help, then run
`npm run generate:help`. Commit the updated generated file with the source
documentation. `npm run check:help` detects drift.

Include only code, tests and public documentation in a contribution. Do not
include real Vault content, credentials, personal logs or machine-specific
configuration. Use synthetic examples and `example.invalid` URLs in tests.
Before committing, choose the public name/email you intend to expose; GitHub
offers a noreply address in account email settings.

Describe the problem, resulting behavior and relevant checks in a pull request.
Retain [third-party notices](THIRD_PARTY_NOTICES.md) when adapting upstream code.
