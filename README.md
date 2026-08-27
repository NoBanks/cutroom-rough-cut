# CUTROOM

CUTROOM is a virtual cutting room where a crew of AI film agents will turn raw
video clips into a rough cut. This first milestone provides the session-based
footage intake, sample footage flow, creative brief handoff, and a placeholder
assembly screen; the real editing pipeline comes later.

## How to run

1. Install dependencies with `pnpm install`.
2. Start the app with `pnpm --filter @workspace/cutroom run dev`.
3. Open the preview URL shown by Replit.

Add `.mp4` or `.mov` files to `sample_clips/` to make the sample footage button
use real clips. Uploads are kept in temporary, randomly named session
directories and are not persisted to a database.