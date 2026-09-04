import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const RENDER_DIR_NAME = "render";
const OUTPUT_NAME = "roughcut.mp4";
const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 1080;
const TARGET_FPS = 24;
const AUDIO_RATE = 48000;
const RENDER_BUDGET_MS = 5 * 60 * 1000;
const STDERR_TAIL_LINES = 12;

function stderrTail(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-STDERR_TAIL_LINES)
    .join(" | ");
}

function runFfmpegTool(command, args, budgetMs) {
  return new Promise((resolve, reject) => {
    if (budgetMs <= 0) {
      reject(new Error("The render exceeded the five minute limit."));
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
          new Error("The render exceeded the five minute limit and was stopped."),
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

async function probeFile(filePath, budgetMs) {
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

function videoFilters() {
  return [
    `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${TARGET_FPS}`,
    "format=yuv420p",
    "setrange=tv",
    "setsar=1",
  ].join(",");
}

function audioFilters() {
  return [
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    `aresample=${AUDIO_RATE}`,
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
  ].join(",");
}

// Every shot is cut to a whole number of frames at 24fps. A partial trailing
// frame makes ffprobe report a bogus r_frame_rate on the concatenated file
// (120/1 was measured on 2026-09-04), which breaks the 24fps rule the whole
// product is judged on. Do not remove this rounding.
function frameAlignedDuration(seconds) {
  const frames = Math.max(1, Math.round(seconds * TARGET_FPS));
  return frames / TARGET_FPS;
}

function buildShotArgs(segment, outputPath) {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", segment.sourcePath];
  if (!segment.hasAudio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`,
    );
  }
  args.push(
    "-ss",
    segment.startSec.toFixed(3),
    "-t",
    segment.durationSec.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    segment.hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    videoFilters(),
    "-af",
    audioFilters(),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
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

  const deadline = Date.now() + RENDER_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const sourceClips = Array.isArray(clips) ? clips : [];
  const renderDir = path.join(sessionDir, RENDER_DIR_NAME);
  await fs.rm(renderDir, { recursive: true, force: true });
  await fs.mkdir(renderDir, { recursive: true });

  log(`cutting ${rows.length} ${rows.length === 1 ? "shot" : "shots"}...`);

  const shotFiles = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sourcePath = resolveSource(row, sourceClips);
    if (!sourcePath) {
      throw new Error(
        `Edit ${index + 1} points at missing footage: ${row.filename}`,
      );
    }
    const startSec = Math.max(0, Number(row.source_start_sec) || 0);
    const endSec = Number(row.source_end_sec);
    const declared = Number(row.duration_sec);
    const rawDuration =
      Number.isFinite(endSec) && endSec > startSec ? endSec - startSec : declared;
    if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
      throw new Error(`Edit ${index + 1} has no usable duration.`);
    }
    const probe = await probeFile(sourcePath, remaining());
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
          hasAudio: probe.audioCodec !== "none",
        },
        shotPath,
      ),
      remaining(),
    );
    shotFiles.push(shotPath);
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
  );

  const measured = await probeFile(outputPath, remaining());
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
