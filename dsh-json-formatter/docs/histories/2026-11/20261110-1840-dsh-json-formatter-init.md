## [2026-11-10 18:40] | Task: Initial Implementation of @max/dsh-json-formatter

### Context
- User requested a DSH plugin for JSON formatting inside Better Sidebar.
- Target location: `/var/lib/dsh/max-dsh-plugins/dsh-json-formatter`.

### Actions Taken
- Created `@max/dsh-json-formatter` package with `package.json`, `cordis.patch.yml`, `icon.svg`, `logo.svg`.
- Implemented `index.mjs` (host) and `client.js` (client).
- Implemented dual Better Sidebar integration:
  - Tab: `dsh-json-formatter:tab`
  - Viewer: `dsh-json-formatter:viewer` (`exts: ['json']`)
- Structured Agent Wiki docs (`AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/REPO_COLLAB_GUIDE.md`).
