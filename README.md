# CUTROOM

**Your first cut, tonight.**

CUTROOM turns raw footage and one line of creative intent into a watchable rough cut,
plus the edit decision list and the reasoning behind every cut.

**Live app:** https://cutroom-rough-cut.replit.app

Built for the Agentic Cinema hackathon, Replit track.

---

## The idea

Shooting is fast. Cutting is slow. So most footage dies unwatched in a folder.

CUTROOM is a virtual cutting room staffed by four AI film agents. You hand it clips and a
single line of intent. It hands back a 1080p/24fps rough cut, an EDL you can open in any
NLE, and a live log of the crew's reasoning so you can see exactly why every cut exists.

It does not replace an editor. It replaces the empty timeline.

---

## The crew

| Agent | Job | Input | Output |
|---|---|---|---|
| **DIRECTOR** | Turns one line of intent into an editorial brief | brief text + preset | target runtime, pacing band, tone, opening and closing strategy |
| **SELECTOR** | Watches each clip, up to its first five minutes | video via the Gemini Files API | timecoded moments with shot size, motion, subject, strength score |
| **EDITOR** | Cuts against the intent | moments + director intent | validated EDL with a "why" on every cut |
| **REVIEWER** | Watches the assembled cut back | the rendered cut, as video | verdict plus at most one bounded pass of typed orders |

Each agent's system prompt lives in `agents/prompts/` and is loaded at call time, so the
craft rules are editable without touching code.

---

## Architecture

**Agents decide. Code executes.** The models never touch the timeline directly.

1. Upload -> `ffprobe` inventory (duration, resolution, fps, audio presence) per clip.
2. DIRECTOR produces the editorial brief as structured JSON.
3. SELECTOR uploads each clip through the Gemini Files API and returns timecoded moments.
   Retries use exponential backoff from 5s to a 90s cap with per-clip resume, because
   model-side 503 waves last minutes. A Files API upload is bound to the key that made it,
   so upload and analysis share one key per clip.
4. EDITOR proposes an EDL. **The server validates it**: moment ids must exist, in/out
   points must fall inside the source spans, durations are recomputed server-side. A
   failed EDL earns exactly one re-ask.
5. `assembly` trims each span with ffmpeg and concatenates to `roughcut.mp4` -
   h264, 1080p, 24fps, yuv420p, AAC audio. Clips that carry audio are loudness
   normalized; a clip with no audio track gets silence instead.
6. REVIEWER watches the rendered cut and returns either `ship` or `one_pass` with typed
   orders (trim / extend / swap / drop / reorder, signed delta, max 5). Orders are applied
   deterministically in code; invalid orders are logged as skipped. There is never a
   second review pass.

**Models:** `gemini-3.8-flash`, falling back to `gemini-3.5-flash-lite`, all through
the `@google/genai` SDK. That SDK is the only AI dependency in the project. Both are
overridable without a code edit via `CUTROOM_MODEL_PRIMARY` and `CUTROOM_MODEL_FALLBACK`.

---

## Running it

**Required secret:** `GEMINI_API_KEYS` - one or more Google AI Studio API keys, separated
by commas, whitespace or newlines. Set it in the Replit Secrets pane. Keys are read from
the environment and never written to disk or logged; logs refer to a key by its position
in the pool only. The crew round-robins across the pool and rotates to the next key on a
rate limit or a quota error, so one key's ceiling cannot stall a session. A key that hits
a per-day quota is benched for the day rather than retried every minute. The older
single-key `GEMINI_API_KEY` still works and is read as a pool of one.

**Optional render knobs:** `CUTROOM_RENDER_MAX_HEIGHT` caps the output canvas height
(default 1080). The render never upscales, so the canvas is the tallest source in the EDL
capped by this number; 720p phone footage renders on a 1280x720 canvas either way, and a
slow deployment box can pin the ceiling lower. `CUTROOM_RENDER_TIMEOUT_MS` is the budget
for one render (default 600000, ten minutes). Chunk 7 renders twice per session, an
initial cut then an improved one, and each render gets its own full budget.

**System dependency:** ffmpeg / ffprobe must be declared for the deployment, not only
present in dev. In this repo that is `packages = ["ffmpeg"]` under `[nix]` in `.replit`.
The deployment image does not inherit dev-only system packages; this was a real bug we
hit and fixed (see Notes).

```
pnpm install
PORT=8080 pnpm --filter @workspace/api-server run dev     # API on :8080
PORT=25719 BASE_PATH=/ pnpm --filter @workspace/cutroom run dev   # web on :25719
```

The repo is a pnpm workspace and its `preinstall` script refuses npm and yarn.
Both services read `PORT` from the environment; on Replit that is supplied by the
artifact runner, which builds with `pnpm --filter @workspace/api-server run build`
and serves `node artifacts/api-server/dist/index.mjs`.

Then open the app, drop in clips, type one line of intent, and press the button.

**Sample path:** the repo ships sample clips in `sample_clips/`, so the whole journey can
be run without uploading anything.

**Limits:** 10 files, 200MB per file and 200MB per session, 30 minutes of footage per
session, `.mp4` and `.mov` only. A file that declares a non-video MIME type is rejected
before it is written, and anything ffprobe cannot read is rejected before the crew starts.
Temporary session directories older than 24 hours are swept hourly.

---

## Notes from the build

- **Test against the deployed URL, never the dev preview.** The published deployment
  returned "unreadable or corrupt" for every clip while dev passed cleanly, because
  ffprobe was not in the deployment image. Every acceptance gate in this project runs
  against production for that reason.
- **Never trust a prompt to enforce a type.** With the schema referenced rather than
  embedded, the model invented field names and returned `"00:03"` strings. Embedding the
  exact schema JSON in every request, with "numbers as plain seconds, never MM:SS", fixed
  it - and shot sizes still occasionally arrived as prose, so normalization lives in code.
- **One free-tier key is worth roughly one heavy day of video analysis.** Quota exhaustion
  presents as a wall of 429s that looks exactly like a broken app.

---

## License

MIT. See LICENSE.
