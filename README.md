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
   so upload and analysis share one key per clip. Clips are pre-uploaded three at a time
   on one key while the analysis itself stays strictly sequential, and an upload is cached
   per key so a key the crew rotates back to is never asked to take the same file twice.
4. EDITOR proposes an EDL. **The server validates it**: moment ids must exist, in/out
   points must fall inside the source spans, durations are recomputed server-side. A
   failed EDL earns exactly one re-ask.
5. `assembly` trims each span with ffmpeg and concatenates to `roughcut.mp4` -
   h264, 1080p, 24fps, yuv420p, AAC audio. Clips that carry audio are loudness
   normalized; a clip with no audio track gets silence instead.
6. REVIEWER watches the rendered cut and returns either `ship` or `one_pass` with typed
   orders (trim / extend / swap / drop / reorder, signed delta, max 5). Orders are applied
   deterministically in code; invalid orders are logged as skipped. There is never a
   second review pass. The review is capped at 20 key attempts (`CUTROOM_REVIEW_MAX_ATTEMPTS`);
   if the cap is hit the log says so and the first cut stands as delivered.

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

**Cold check:** `GET /api/health` reports the model ids in use, the key pool size and how
many keys are cooling or benched (counts only, never a value), ffmpeg and ffprobe presence,
temp session usage and free disk. It fires no model call by itself; `?probe=1` runs one
live probe, cached for 60 seconds.

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

## Judging notes

Everything in this section was measured on the public deployment or on the development
Mac and is dated. Nothing here is a target; these are the numbers the app actually produced.

### The sample journey, click by click

1. Open https://cutroom-rough-cut.replit.app. No account, no cookie wall; a session cookie
   is set on first contact.
2. Press **Use sample footage**. Three phone clips (406x720, 24fps, about 19 seconds each)
   are copied into the session and ffprobed; the inventory table fills in.
3. Leave the default brief or type one line, for example
   `A confident 30 second promo of an artist reviewing framed astronaut art prints in a studio`,
   pick a preset, press **Send to the crew**.
4. Watch the log. The four agents run in order: DIRECTOR (seconds), SELECTOR (the long one,
   it uploads and watches every clip), EDITOR (seconds), ASSEMBLY (ffmpeg, per-shot lines),
   REVIEWER (uploads the rendered cut and watches it back).
5. When the player appears, play the cut. Download `roughcut.mp4`, `edl.json`, `edl.csv`.
   If the reviewer ordered a pass, `roughcut_v1.mp4` (the pre-review cut) and `review.json`
   are there too and the player shows v2.
6. Optional cold check at any time: `GET /api/health`.

### Expected timings on the free deployment (measured 2026-09-07)

The deployment box is a fractional vCPU on Replit autoscale, roughly 30 to 80x slower than
the development Mac for ffmpeg work. Two complete production sessions on the shipped build:

| Stage | Session 95182422 (SHIP) | Session 342fa7df (ONE PASS, demo capture) |
|---|---|---|
| DIRECTOR | about 3 min | about 1 min |
| SELECTOR, 3 sample clips | about 22 min, 8 moments | 23 moments |
| EDITOR | seconds, 5 edits / 21.6s | seconds, 5 edits / 18.7s |
| ASSEMBLY, per shot | 17.4 / 30.5 / 18.2 / 27.3 / 15.3s (109s total, 1280x720, 24fps) | two renders (v1 23.5s, v2 18.7s) |
| REVIEWER | SHIP after 17 key rotations, about 14 min | one_pass, 2 orders applied |
| Brief to first downloadable cut | about 39 min | 28.3 min |
| Brief to final state | about 39 min | 54.4 min |

For scale, the same code on an Apple M4 Pro runs the whole crew in about 5 to 8 minutes,
with the selector taking most of it and ffmpeg at roughly 1.4 seconds per shot.

What eats the time on the free box: the selector uploads each clip through the Files API
and Gemini watches it (the per-clip lines in the log carry elapsed seconds), and every
rate limited key costs a fresh upload on the next key. Before the pre-judging pass the
reviewer alone logged 17 upload-and-watch pairs on session 95182422; those are now one
line per attempt and an upload is reused whenever the crew lands back on a key that
already holds the file.

### What the retry and apology paths look like

The crew never hands over a broken cut and never leaves the page blank. Each failure has
its own sentence in the log panel and a Retry button that re-sends the same footage and
brief.

- Per-clip rate limit or 5xx during selection, before any apology:
  `Gemini is busy, the crew is waiting it out... clip_1.mp4 attempt 2/8; retrying in 5s (ApiError/429) 48s`
- Key rotation, one line per attempt (position only, never a key value):
  `clip_2.mp4: key 7/43 was rate limited; uploading then analyzing (attempt 1, rotation 2, key 8/43) 61s`
- Quota wall, every key in the pool exhausted:
  `Sorry about this. The selector was mid-run when it stopped. Gemini turned the crew away at the door: the crew rotated through every API key in the pool and each one is out of quota for now. Nothing is wrong with your footage. Wait a few minutes and press Retry, or add fresh keys to GEMINI_API_KEYS and try again.`
- Model-side outage (5xx that did not clear):
  `Sorry about this. The selector was mid-run when it stopped. Gemini answered with a 503, which is a problem on the model's side, not with your footage. The crew waited it out and it did not clear. Press Retry to send the same footage and brief back in.`
- Invalid keys (401/403):
  `Sorry about this. The director was mid-run when it stopped. Gemini refused the API keys (403). Put at least one valid key in GEMINI_API_KEYS, then press Retry.`
- Footage with nothing usable in it (every shot read as a dead shot): the editor is skipped
  and the log says so; Retry with different footage or a different brief.
- Render budget exceeded (ten minutes per render): `The render exceeded its 600s budget and
  was stopped.` The EDL is still downloadable; Retry re-runs the crew.
- Reviewer cap hit: `gave up after 20 attempts in 312s; the last key was rate limited. The
  first cut stands as delivered and is still downloadable.` The cut, the EDL and the CSV
  are all still there; only the verdict is missing.
- Second render (after review orders) fails: the first cut stands as delivered and the log
  says `the second render failed; the first cut stands as delivered`.

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
