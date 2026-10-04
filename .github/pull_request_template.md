<!-- Thanks! Small, complete changes land fastest. -->

## What and why

<!-- One or two sentences. Link the issue with "Fixes #" and its number. -->

## Checklist

- [ ] Tests green **keyless**, with no API keys set: `npm run typecheck`, `npm test`, `npm run build` and `python -m pytest tests/ -q`
- [ ] No real personal data anywhere in the diff, and every name in it is invented (see the roster below)
- [ ] `bash scripts/secret-scan.sh --tree` is green
- [ ] `changelog.d/` fragment in this same PR if this is user-visible, and docs updated if they now say something untrue
- [ ] New UI surfaces have a plain-English "what is this and why it matters" line

## Synthetic roster

The rule is invented names only, everywhere: code, tests, fixtures and docs.
Prefer the roster below, so a reviewer can tell invented data from real data
at a glance. If you need a name it doesn't cover, invent an obviously
fictional one and add it here in the same PR.

| Kind | Examples |
| --- | --- |
| People | Alex, Sam, Dave, Mateo |
| Organisations | AcmeCo, Initech, Globex |
| Places | Fairhaven |
| Repositories | globex/woodchuck, example/woodchuck |

Designs are invented too. Sizes, sketches and photos from a real piece of
furniture never go into a commit, an issue or a pull request.

Infrastructure placeholders are fixed rather than free choice, because
`scripts/secret-scan.sh` allowlists exactly these and rejects anything else
of the same shape: `/Users/you/...`, `my-mac.my-tailnet.ts.net`,
`you@example.com`.
