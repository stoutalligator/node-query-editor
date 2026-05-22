# Development Guide

## Prerequisites

- **Node.js 20+** (use [nvm](https://github.com/nvm-sh/nvm) or the Windows [nvm-windows](https://github.com/coreybutler/nvm-windows))
- **npm** (bundled with Node)
- **Git**

## Setup

```bash
git clone https://github.com/stoutalligator/node-query-editor.git
cd node-query-editor
npm install
```

## Development workflow

| Command | What it does |
|---|---|
| `npm run compile` | One-shot build: `src/` → `dist/` via esbuild |
| `npm start` | Compile + launch Electron |
| `npm run dev` | Watch mode + launch Electron with DevTools open |
| `npm run typecheck` | TypeScript type check (no output) |
| `npm run lint` | ESLint on `src/**/*.ts` |
| `npm run lint:fix` | Auto-fix ESLint issues |
| `npm run package` | Build + package Windows installer to `release/` |
| `npm run release` | Build + publish to GitHub Releases (CI use only) |

## Architecture

```
src/
  main.ts           Electron main process — window creation, IPC handlers,
                    file dialog, CSV export, auto-updater setup
  preload.ts        contextBridge — exposes window.api.* to the renderer
  worker.ts         Worker thread — loadFile + runQuery, keeps UI responsive
  query-engine/
    types.ts        TypeScript interfaces: ParsedQuery, ResultRow, etc.
    parser.ts       NXQL tokenizer + recursive descent parser → ParsedQuery
    evaluator.ts    Executes ParsedQuery against an htmlparser2 DOM tree

renderer/
  index.html        App shell — loads Monaco, AG Grid, main.js
  main.js           UI logic: editor, results grid, CSV, auto-update banner
  styles.css        GitHub Dark theme

esbuild.js          Build script (compiles src/ → dist/)
```

### Message flow

```
[Renderer]                              [Main]                    [Worker]
   |─── api.loadFile(path) ──────────>  |─── postMessage ──────>  |
   |<── onWorkerMessage(fileLoaded) ──  |<── parentPort.post ───   |
   |─── api.runQuery(nxql, limit) ───>  |─── postMessage ──────>  |
   |<── onWorkerMessage(queryResult) ─  |<── parentPort.post ───   |
   |─── api.saveQuery(name, text) ───>  | writes saved-queries.json|
   |─── api.loadQueries() ───────────>  | reads saved-queries.json |
   |─── api.deleteQuery(id) ─────────>  | writes saved-queries.json|
```

The renderer never touches the filesystem directly. Query execution and XML I/O happen in the worker thread. Saved-query persistence is handled by the main process via `app.getPath('userData')/saved-queries.json`.

## Branch strategy

| Branch | Purpose |
|---|---|
| `main` | Production — every commit triggers a release build |
| `develop` | Active development and integration |
| `feature/*` | New features branched from `develop` |
| `fix/*` | Bug fixes branched from `develop` |

Typical flow:
1. Branch from `develop`: `git checkout -b feature/my-thing`
2. Push and open a PR to `develop`
3. CI runs typecheck + lint + compile on the PR
4. Merge to `develop`
5. When ready to release: open a PR from `develop` to `main`

## Cutting a release

1. Bump the version in `package.json`:
   ```json
   "version": "1.2.0"
   ```
2. Open a PR from `develop` to `main`
3. CI validates the branch — check that typecheck, lint, and compile all pass
4. Merge the PR
5. The **Release** workflow runs automatically on the `windows-latest` runner:
   - Compiles the app
   - Packages the NSIS installer with `electron-builder`
   - Creates a GitHub Release tagged `v1.2.0`
   - Uploads `NodeQueryEditor-Setup-1.2.0.exe` and `latest.yml`
6. Running instances of the app will detect the new `latest.yml` on next launch and display the update banner

## How auto-update works

1. On launch, `electron-updater` checks GitHub Releases for a `latest.yml` file
2. If the latest version is higher than the running version, the update is downloaded in the background
3. When the download completes, the renderer receives an `update-downloaded` IPC event
4. A green banner appears at the top of the app: **"↑ Version x.x.x ready to install — Restart & Install"**
5. Clicking the button calls `autoUpdater.quitAndInstall()` — the app restarts and installs the update

The NSIS installer is set to `allowToChangeInstallationDirectory: false` by default, so silent reinstalls work without UAC prompts if the app is installed for the current user only.

## Adding a new NXQL keyword or operator

1. Add the keyword string to the `KEYWORDS` set in [src/query-engine/parser.ts](../src/query-engine/parser.ts)
2. Add parsing logic in the appropriate `parse*` function
3. Add the corresponding type/interface changes to [src/query-engine/types.ts](../src/query-engine/types.ts)
4. Implement evaluation in [src/query-engine/evaluator.ts](../src/query-engine/evaluator.ts)
5. Add the keyword to the Monaco tokenizer `keywords` array in [renderer/main.js](../renderer/main.js)
6. Update [docs/nxql-language.md](nxql-language.md)

Recent additions that follow this pattern: `GROUP`, `HAVING`, `COUNT` (added for `GROUP BY` / `HAVING COUNT(*)` support).
