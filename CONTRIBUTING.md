# Contributing

Woodchuck is maintained by one person and built first for their own
furniture. Issues and pull requests are welcome, and replies can take a
while. A bug report or an idea is as useful as code.

## Setup

```bash
git clone https://github.com/shawn-durrani/woodchuck.git
cd woodchuck
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` serves the page at http://127.0.0.1:8906 and the server on
port 8905, and reloads as you change the code. Put your Anthropic key in
`.env` for the chat, or leave it out to work on everything else.
[docs/CONFIG.md](docs/CONFIG.md) lists every setting. Point
`WOODCHUCK_DATA_DIR` at a throwaway folder while you try things, so your
own designs stay out of it.

The tests run with no keys, and CI runs them that way. The Python tests
need Python 3.12 or newer with pytest.

```bash
npm run typecheck
npm test
npm run build
python -m pytest tests/ -q
```

[docs/TESTING.md](docs/TESTING.md) says what they hold, and how to try the
chat with scripted replies and no key.

## How a change lands

- Open an issue first for anything bigger than a small fix, so we can agree
  on the shape before you build it.
- Branch from `main`, never from another open pull request. Squash merging
  the first one leaves the second with no parent.
- Keep a pull request to one change, and link its issue with `Fixes #N`.
- A change in behaviour comes with tests, and every suite stays green with
  no keys set. If a change only works with a key, give it a keyless
  fallback.
- Update the docs a change makes wrong, in the same pull request.
- CI has to pass, and the pull request lands as one squashed commit on
  `main`.

## Ground rules

- Claude changes a design only through the deterministic tools in
  `packages/server/src/tools.ts`. Add a tool when the design needs one, and
  never add a tool that runs code it was handed.
- Every length is in millimetres, and field names say so, such as
  `thickness_mm`.
- No real personal data in any diff. That covers code, tests, fixtures,
  docs, screenshots and example designs. Examples are invented from the
  start, with the names in the pull request template's roster.
- The scope in [ARCHITECTURE.md](ARCHITECTURE.md) is chosen, and that page
  says why. Read it before you widen it.

## The leak scanner

Turn on the pre-commit scan once per clone.

```bash
git config core.hooksPath .githooks
```

`scripts/secret-scan.sh` looks for the shapes of keys and for machine
identifiers such as home paths and tailnet names. It also checks your own
deny-list, if you make one. Copy `secret-scan-local.example` to
`.secret-scan-local`, which git ignores, and list your own names and
places. A line you mean to keep can carry an inline `secret-scan: allow`
marker that says why, and the marker exempts that one line.

A green scan covers key shapes, infrastructure identifiers and your own
deny-list. It isn't a clearance, so write content that's made up from the
start. Run the whole tree before you push.

```bash
bash scripts/secret-scan.sh --tree
```

The scanner is a copy of Crossband's, and a test fails when the two
differ. A fix to its patterns lands in
[Crossband](https://github.com/shawn-durrani/crossband) first and is then
copied here.

## The changelog

A change someone using the app can see gets one new file under
`changelog.d/`, and `CHANGELOG.md` stays as it is. Name the file
`<issue>-<slug>.md`, in lowercase words joined by hyphens, such as
`12-oak-species.md`. Write the finished entry in the changelog's voice, as
one paragraph that starts with `- `. Indent its continuation lines two
spaces, and end the file with a newline. Entries fold into the changelog
at release, so two open pull requests never touch the same line.

## Writing documentation

Write a page the way you'd explain the app to a smart friend who's never
seen it. If you wouldn't say a sentence like that, rewrite it until you
would. Write in Australian English. Contractions are fine, the reader is
"you", and short words beat long ones. Keep one claim to a sentence, with
an average under 18 words and fewer than one sentence in ten over 35. A
caveat gets a sentence of its own. A paragraph is one thought, and it
opens with its point. When you bring in something from outside the app,
say what it is in a sentence and link its own documentation. Don't
announce a count before a list, and don't end a paragraph on a line that
sounds good. Say a thing once, in one place, and link to it from anywhere
else. README.md is the page to measure against.

`tests/test_doc_style.py` checks the mechanical part. Every markdown file
in the repo is held to the same ceilings: no em-dash, no sentence over 55
words, no table cell over 45 words, and a heading at least every 50 lines
of prose. A doc rewritten in the voice is listed in `CONVERTED` near the
top of that file, and those docs also keep to these rules:

- no dashes and no semicolons
- one colon per sentence, and only to introduce a list, a command or a
  quoted value
- bracketed asides under eight words, and no sentence starting with one
- capitals only for acronyms
- none of the filler words the test names
- no sentence that announces a count before the list
- contrasts, such as "X, not Y", kept rare
- no history and no issue numbers
- no pointers to the page itself
- no sentence opening with "So" or "Because"

When you rewrite a doc, add its path to `CONVERTED` in the same pull
request, and the suite tells you what's left. Test files are different,
since a test names the issue it guards.

The same file keeps two indexes whole. Every document in `docs/` is linked
from `docs/README.md`, and `docs/CONFIG.md` names every environment
variable the code reads.

## What gets a warm welcome

- A bug report with the steps on an invented design, and what you expected
  to see.
- A new joint, finish or check, with tests that pin its numbers.
- A woodworking fact the app gets wrong, with a source.
- A part for the library, with the sources its numbers came from.
- A doc fix, when a page says something the app doesn't do.

## Releasing

Versions follow semantic versioning in the 0.x range, with no promise of
stability yet. The `version` in the root `package.json` is the one place
the version lives.

Before a tag, tick every box.

- [ ] `npm run typecheck`, `npm test`, `npm run build` and
      `python -m pytest tests/ -q` pass with no keys set.
- [ ] `npm audit --omit=dev --audit-level=high` is clean.
- [ ] `bash scripts/secret-scan.sh --tree` is green. The bare command
      scans only staged lines, so at release time it scans nothing and
      still reports clean.
- [ ] Screenshots come from invented designs only.
- [ ] `python scripts/fold_changelog.py vX.Y.Z` has run, leaving
      `changelog.d/` empty, the new section dated, and Unreleased empty
      above it.
- [ ] The `version` in `package.json` is bumped.
