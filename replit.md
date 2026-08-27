# CUTROOM

CUTROOM is a temporary-session virtual cutting room for turning raw video clips into a first-cut brief.

## Run & Operate

- `pnpm --filter @workspace/cutroom run dev` — run the Express app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/cutroom run build` — copy the server-rendered app into the production directory

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Backend: Node.js + Express 5
- Frontend: static HTML, vanilla JavaScript, and one CSS file
- Upload handling: Multer, with temporary per-session directories
- Persistence: none by design

## Where things live

- `artifacts/api-server/src/routes/cutroom.ts` — Express routes and session/file handling
- `artifacts/cutroom/` — HTML shell plus `public/` browser JS and styles
- `sample_clips/` — manually supplied sample footage

## Architecture decisions

- Sessions use an HTTP-only crypto-random cookie and in-memory metadata; clip bytes live only under a matching temporary directory.
- The app intentionally avoids accounts, a database, AI/model calls, and payments for this milestone.
- Sample footage is copied into the current session so the sample path behaves like uploaded footage.

## Product

Users can start with sample footage or upload up to 10 `.mp4`/`.mov` clips, write or choose a brief, and enter the placeholder assembly state.

## User preferences

- Keep CUTROOM lightweight and cinematic; do not add AI, accounts, payments, or a database.

## Gotchas

- The app requires `PORT` from its managed workflow.

## Pointers

- `README.md` contains the user-facing setup notes.
