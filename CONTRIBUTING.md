# Contributing

Thanks for your interest in sunaba. Issues and pull requests are welcome.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not in a public issue.

## Setup

Published packages support Node ≥20. Development tooling (vite/vitest)
needs ≥20.19 — use the latest Node 20.x or newer.

```bash
npm install
npm run build     # sdk → agent, cdk, cli (dependency order)
npm run typecheck # tsc over src, tests and examples (after build)
npm test          # vitest — offline, no AWS credentials needed
npm run check     # biome lint + format
```

## Conventions

- TypeScript strict mode; Biome for lint/format (`npm run check:write`)
- Conventional Commits: `feat` / `fix` / `chore` / `docs` / `refactor` / `test`
- Never commit credentials or secrets
- Tests must not hit real AWS — inject fake clients (see `tests/` in each package)

## Pull requests

- Keep changes focused; add regression tests for bug fixes
- `npm run build && npm run typecheck && npm test && npm run check` must be green
- Describe the "why", not just the "what"

## Releasing

Tag, `npm publish` and create the GitHub release only from a commit whose
`ci` run on `main` passed on every Node version:

```bash
sha=$(git rev-parse HEAD)
run=$(gh run list --workflow ci --commit "$sha" --event push --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "${run:?no ci run for $sha yet}" --exit-status   # waits; non-zero unless every job passed
```
