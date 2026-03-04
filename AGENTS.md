# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is **Mission Control** — a Next.js 16 dashboard for the OpenClaw AI agent platform. It is a single-service frontend with no database or Docker dependencies of its own. All data comes from the OpenClaw gateway (port 18789) or the `openclaw` CLI binary.

### Running the app

- **Dev server:** `npm run dev` (serves on `http://127.0.0.1:3000`)
- **Production build:** `npm run build` then `npm run start`
- The OpenClaw gateway/CLI is not installed in this environment. The dashboard starts and renders all pages correctly without it, but data-fetching features will show "offline" / connection errors — this is expected and not a bug.

### Lint / Test / Build

- **Lint:** `npm run lint` — runs ESLint 9. The codebase has a few pre-existing warnings/errors (unused vars, a `prefer-const`, a React hooks warning); these are not environment issues.
- **Build:** `npm run build` — Next.js webpack production build. Compiles cleanly.
- **E2E tests:** `npm run test:e2e` — Playwright. Requires `npx playwright install` first to download browsers.

### Gotchas

- The `setup.sh` script is designed for end-user installation (production builds + systemd/launchd services). For development, use `npm run dev` directly.
- `lightningcss` is an optional native dependency needed by the Tailwind/Next build pipeline. `npm ci --include=optional` installs it. If the build fails with a lightningcss error, reinstall with `npm install --include=optional lightningcss`.
- Next.js 16 uses webpack mode (not Turbopack) as configured in `package.json` scripts.
