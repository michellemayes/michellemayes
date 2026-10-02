# michellemayes profile

Self-refreshing GitHub profile README, modeled on cameronsjo/cameronsjo.

- `scripts/generate-profile.mjs` (zero-dep, Node 20+) queries the GitHub GraphQL API, renders `assets/stats.svg` and `assets/stats-light.svg` from `assets/stats.template.svg`, and rewrites the README block between `<!-- PINS:START -->` / `<!-- PINS:END -->`.
- `.github/workflows/profile.yml` runs it Mondays and on `workflow_dispatch`, committing only when something changed.
- Pins come from the profile's pinned repos (set in the GitHub UI). With none pinned, it falls back to the six most recently pushed public repos.
- Every hex in the template needs a light value in `LIGHT_THEME`, or the run fails.
- Optional `STATS_TOKEN` secret (classic PAT, no scopes); otherwise the workflow's `GITHUB_TOKEN` is used.
