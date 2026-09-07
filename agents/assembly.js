import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const RENDER_DIR_NAME = "render";
const OUTPUT_NAME = "roughcut.mp4";
const TARGET_FPS = 24;
const AUDIO_RATE = 48000;
const STDERR_TAIL_LINES = 12;

// NEVER UPSCALE. The canvas is the tallest source in the EDL, capped by
// CUTROOM_RENDER_MAX_HEIGHT. Phone footage at 406x720 used to be blown up to
// 1920x1080, which cost 2.25x the pixels per encoded frame and bought nothing:
// the extra pixels are interpolation, not detail. 720p sources now render on a
// 1280x720 canvas.
const DEFAULT_MAX_HEIGHT = 1080;
const MIN_CANVAS_HEIGHT = 144;

// The deployment box is roughly 30 to 80x slower than a laptop (a fractional
// vCPU), so the old hardcoded five minute wall killed real renders mid-shot.
// The budget is now an env knob and every timeout message states the number it
// used, so a production log says what to raise.
const DEFAULT_RENDER_TIMEOUT_MS = 10 * 60 * 1000;

// One thread on both sides of the pipe. Measured on 2026-09-07: a thread pool
// costs more total CPU than it saves in wall time, and on a fractional vCPU
// total CPU is what the render is actually billed in. Encoder threads=1 was
// 0.38 CPU seconds per shot against 0.50 for threads=0, and a single decoder
// thread took another 0.08 off the same shot.
const FFMPEG_THREADS = "1";

// Cheapest sane x264. -tune fastdecode was measured and gave nothing, so it is
// not here. crf 26 plus single reference frame, no B frames, diamond motion
// search, no trellis and CAVLC entropy coding is the floor that still looks
// like a rough cut.
const X264_PARAMS =
  "ref=1:bframes=0:subme=0:me=dia:trellis=0:no-cabac=1:rc-lookahead=0:8x8dct=0:weightp=0:mixed-refs=0:no-scenecut=1";
const X264_CRF = "26";

// Per source loudness, single pass. The old per shot loudnorm was a second full
// decode of the audio on every shot. volumedetect runs once per SOURCE file
// (about 0.03s for a 19 second clip) and the shot encode applies a plain gain.
const TARGET_MEAN_DBFS = -20;
const PEAK_CEILING_DBFS = -1.5;
const MAX_GAIN_DB = 12;

function renderTimeoutMs() {
  const raw = Number(process.env.CUTROOM_RENDER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RENDER_TIMEOUT_MS;
}

function maxCanvasHeight() {
  const raw = Number(process.env.CUTROOM_RENDER_MAX_HEIGHT);
  return Number.isFinite(raw) && raw >= MIN_CANVAS_HEIGHT
    ? Math.floor(raw)
    : DEFAULT_MAX_HEIGHT;
}

function budgetLabel(budgetMs) {
  const seconds = budgetMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function stderrTail(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-STDERR_TAIL_LINES)
    .join(" | ");
}

function runFfmpegTool(command, args, budgetMs, totalBudgetMs) {
  return new Promise((resolve, reject) => {
    const stated = budgetLabel(totalBudgetMs);
    if (budgetMs <= 0) {
      reject(
        new Error(`The render exceeded its ${stated} budget and was stopped.`),
      );
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, budgetMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64000) stderr = stderr.slice(-64000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `The render exceeded its ${stated} budget and was stopped.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}. stderr tail: ${stderrTail(stderr)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseRate(value) {
  if (!value) return null;
  const [numerator, denominator] = String(value).split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(3)) : null;
}

async function probeFile(filePath, budgetMs, totalBudgetMs) {
  const { stdout } = await runFfmpegTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    budgetMs,
    totalBudgetMs,
  );
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.format?.duration);
  return {
    durationSec: Number.isFinite(duration) ? Number(duration.toFixed(2)) : 0,
    fps: parseRate(video?.r_frame_rate),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    videoCodec: video?.codec_name || "unknown",
    pixelFormat: video?.pix_fmt || "unknown",
    audioCodec: audio?.codec_name || "none",
  };
}

function evenUp(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

// A source shorter than the cap keeps its own height, so nothing is ever blown
// up. Width follows from 16:9 on the chosen height, and both sides are forced
// even because yuv420p cannot describe an odd dimension.
function canvasFor(sourceHeights) {
  const tallest = sourceHeights.reduce(
    (best, height) => (height > best ? height : best),
    0,
  );
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    Math.min(maxCanvasHeight(), tallest || DEFAULT_MAX_HEIGHT),
  );
  const evenHeight = evenUp(height);
  return { width: evenUp((evenHeight * 16) / 9), height: evenHeight };
}

// Reads mean_volume and max_volume off one audio-only decode of the source.
// Cheap enough to run per file (0.03s on a 19 second clip) and it replaces the
// per shot loudnorm pass, which decoded the audio a second time on every cut.
async function measureGainDb(filePath, budgetMs, totalBudgetMs) {
  const { stderr } = await runFfmpegTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    budgetMs,
    totalBudgetMs,
  );
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1]);
  const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1]);
  if (!Number.isFinite(mean) || !Number.isFinite(peak)) return 0;
  // Lift toward a common mean so clips do not jump, but never past the peak
  // headroom, so no shot is ever driven into clipping.
  const towardMean = TARGET_MEAN_DBFS - mean;
  const headroom = PEAK_CEILING_DBFS - peak;
  const gain = Math.min(towardMean, headroom);
  const clamped = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gain));
  return Number(clamped.toFixed(2));
}

// fps comes FIRST when the source is not already 24. Real footage is often 30
// or 60fps, and dropping to 24 before the scale and pad means the expensive
// stages only ever see the frames that survive into the cut (measured 0.75
// against 0.85 CPU seconds on a 60fps shot). A source already at 24 skips the
// filter entirely; the encoder still runs -r 24 -fps_mode cfr, so the output
// is 24fps CFR either way.
function videoFilters(canvas, sourceFps) {
  const filters = [];
  if (sourceFps !== TARGET_FPS) filters.push(`fps=${TARGET_FPS}`);
  filters.push(
    `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
    `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "format=yuv420p",
    "setrange=tv",
    "setsar=1",
  );
  return filters.join(",");
}

// A gain of exactly nothing still needs the resample and layout stages so every
// shot hands the concat step an identical audio format. Clips with no audio
// track get generated silence passed straight through: the old loudnorm pass
// resolved to an infinite gain on silence and fed the AAC encoder NaN samples,
// which killed the whole render.
function audioFilters(hasAudio, gainDb) {
  const filters = [];
  if (hasAudio && gainDb !== 0) filters.push(`volume=${gainDb}dB`);
  filters.push(`aresample=${AUDIO_RATE}`);
  filters.push("aformat=sample_fmts=fltp:channel_layouts=stereo");
  return filters.join(",");
}

// Every shot is cut to a whole number of frames at 24fps. A partial trailing
// frame makes ffprobe report a bogus r_frame_rate on the concatenated file
// (120/1 was measured on 2026-09-04), which breaks the 24fps rule the whole
// product is judged on. Do not remove this rounding.
function frameAlignedDuration(seconds) {
  const frames = Math.max(1, Math.round(seconds * TARGET_FPS));
  return frames / TARGET_FPS;
}

function buildShotArgs(segment, canvas, outputPath) {
  // -ss goes BEFORE -i so ffmpeg seeks to the span instead of decoding the clip
  // from zero for every shot. It is still frame accurate because the shot is
  // re-encoded. Output seeking made a 12 shot render miss its budget on the
  // deployment box.
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-threads",
    FFMPEG_THREADS,
    "-ss",
    segment.startSec.toFixed(3),
    "-t",
    segment.durationSec.toFixed(3),
    "-i",
    segment.sourcePath,
  ];
  if (!segment.hasAudio) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      segment.durationSec.toFixed(3),
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`,
    );
  }
  args.push(
    "-t",
    segment.durationSec.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    segment.hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    videoFilters(canvas, segment.sourceFps),
    "-af",
    audioFilters(segment.hasAudio, segment.gainDb),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    X264_CRF,
    "-x264-params",
    X264_PARAMS,
    "-threads",
    FFMPEG_THREADS,
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
    "-r",
    String(TARGET_FPS),
    "-fps_mode",
    "cfr",
    "-video_track_timescale",
    String(TARGET_FPS * 1000),
    "-c:a",
    "aac",
    // The default twoloop AAC coder cost 0.08 CPU seconds a shot; the fast
    // coder does the same 192k stereo for 0.03 and a rough cut cannot hear it.
    "-aac_coder",
    "fast",
    "-b:a",
    "192k",
    "-ar",
    String(AUDIO_RATE),
    "-ac",
    "2",
    "-shortest",
    outputPath,
  );
  return args;
}

function resolveSource(row, clips) {
  const byFileName = clips.find((clip) => clip.name === row.filename);
  if (byFileName) return byFileName.storedPath;
  const byStored = clips.find(
    (clip) => path.basename(clip.storedPath) === row.filename,
  );
  return byStored ? byStored.storedPath : null;
}

export async function runAssembly({ edl, clips, sessionDir, onLog }) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const rows = Array.isArray(edl) ? edl : [];
  if (rows.length === 0) {
    throw new Error("There are no edits to render.");
  }

  const budgetMs = renderTimeoutMs();
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  const sourceClips = Array.isArray(clips) ? clips : [];
  const renderDir = path.join(sessionDir, RENDER_DIR_NAME);
  await fs.rm(renderDir, { recursive: true, force: true });
  await fs.mkdir(renderDir, { recursive: true });

  // Resolve every edit to a source first. The canvas cannot be chosen until the
  // tallest source in the EDL is known, and the loudness pass wants one
  // measurement per file rather than one per cut.
  const resolved = rows.map((row, index) => {
    const sourcePath = resolveSource(row, sourceClips);
    if (!sourcePath) {
      throw new Error(
        `Edit ${index + 1} points at missing footage: ${row.filename}`,
      );
    }
    return sourcePath;
  });

  const sources = new Map();
  for (const sourcePath of resolved) {
    if (sources.has(sourcePath)) continue;
    const probe = await probeFile(sourcePath, remaining(), budgetMs);
    const hasAudio = probe.audioCodec !== "none";
    const gainDb = hasAudio
      ? await measureGainDb(sourcePath, remaining(), budgetMs)
      : 0;
    sources.set(sourcePath, { probe, hasAudio, gainDb });
  }

  const canvas = canvasFor(
    Array.from(sources.values(), (entry) => entry.probe.height),
  );
  log(`canvas ${canvas.width}x${canvas.height} (no upscale)`);
  log(`cutting ${rows.length} ${rows.length === 1 ? "shot" : "shots"}...`);

  const shotFiles = [];
  for (let index = 0; index < rows.length; index += 1) {
    const shotStartedAt = Date.now();
    const row = rows[index];
    const sourcePath = resolved[index];
    const source = sources.get(sourcePath);
    const startSec = Math.max(0, Number(row.source_start_sec) || 0);
    const endSec = Number(row.source_end_sec);
    const declared = Number(row.duration_sec);
    const rawDuration =
      Number.isFinite(endSec) && endSec > startSec ? endSec - startSec : declared;
    if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
      throw new Error(`Edit ${index + 1} has no usable duration.`);
    }
    // Shot filenames come from the edit index, never from user input.
    const shotPath = path.join(
      renderDir,
      `shot_${String(index).padStart(3, "0")}.mp4`,
    );
    await runFfmpegTool(
      "ffmpeg",
      buildShotArgs(
        {
          sourcePath,
          startSec,
          durationSec: frameAlignedDuration(rawDuration),
          hasAudio: source.hasAudio,
          gainDb: source.gainDb,
          sourceFps: source.probe.fps,
        },
        canvas,
        shotPath,
      ),
      remaining(),
      budgetMs,
    );
    shotFiles.push(shotPath);
    // A slow deployment box needs to show life instead of a silent wait.
    log(
      `shot ${index + 1}/${rows.length} done, ${((Date.now() - shotStartedAt) / 1000).toFixed(1)}s`,
    );
  }

  const listPath = path.join(renderDir, "concat.txt");
  await fs.writeFile(
    listPath,
    `${shotFiles
      .map((file) => `file '${file.replaceAll("'", "'\\''")}'`)
      .join("\n")}\n`,
    "utf8",
  );

  const outputPath = path.join(sessionDir, OUTPUT_NAME);
  await fs.rm(outputPath, { force: true });
  await runFfmpegTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    remaining(),
    budgetMs,
  );

  const measured = await probeFile(outputPath, remaining(), budgetMs);
  const stats = await fs.stat(outputPath);
  const fpsLabel =
    measured.fps === null
      ? "fps unknown"
      : `${Number.isInteger(measured.fps) ? measured.fps : measured.fps.toFixed(2)}fps`;
  log(
    `rough cut rendered: ${measured.durationSec}s, ${fpsLabel}, ${measured.height}p`,
  );

  await fs.rm(renderDir, { recursive: true, force: true });

  return {
    filename: OUTPUT_NAME,
    path: outputPath,
    shots: rows.length,
    sizeBytes: stats.size,
    durationSec: measured.durationSec,
    fps: measured.fps,
    width: measured.width,
    height: measured.height,
    videoCodec: measured.videoCodec,
    pixelFormat: measured.pixelFormat,
    audioCodec: measured.audioCodec,
  };
}
