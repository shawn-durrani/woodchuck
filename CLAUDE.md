# CLAUDE.md

Instructions for AI sessions working in this repository.

## Process

The pipeline is documented once, in [CONTRIBUTING.md](CONTRIBUTING.md).
Read it first. Session-specific rules:

- Work on a branch and open a pull request. Never commit to `main`, and
  never branch off another open pull request.
- Every suite runs keyless. Never add a hard dependency on an API key.
- A change someone using the app can see gets one fragment in
  `changelog.d/`, named `<issue>-<slug>.md`. Never edit `CHANGELOG.md`
  outside a release.
- Docs are written in the voice CONTRIBUTING.md describes under Writing
  documentation, and `tests/test_doc_style.py` checks it. A doc you rewrite
  joins `CONVERTED` in that test.
- A new environment variable goes in [docs/CONFIG.md](docs/CONFIG.md), or
  the doc test fails.

## Rules that override convenience

- `data/` holds real designs, chats, room photos and version history.
  Never read, copy or quote its contents into code, tests, docs, commits or
  chat. Debug with a throwaway `WOODCHUCK_DATA_DIR`.
- No real personal data in a diff, including names, designs, sizes from a
  real piece, photos, hostnames and paths. Fixtures are invented, not
  sampled, and use the synthetic roster in
  `.github/pull_request_template.md`. Personal deny-list patterns live only
  in the gitignored `.secret-scan-local`.
- Claude changes a design only through the deterministic tools in
  `packages/server/src/tools.ts`. Never add a tool that runs arbitrary
  code.
- Every length is in millimetres, and field names say so.
- Run `bash scripts/secret-scan.sh --tree` before any push. A green scan
  covers key shapes and identifiers only, so it's no clearance for content.

## Orientation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the settled decisions, then
browse [docs/README.md](docs/README.md), which indexes every document by
what you're trying to do. [docs/TESTING.md](docs/TESTING.md) says what the
suites hold. Open issues hold the active work.
