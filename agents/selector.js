import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeVideo,
  pickKeyIndex,
  preuploadVideo,
} from "../artifacts/api-server/src/lib/gemini.js";

const execFileAsync = promisify(execFile);
const MAX_ANALYSIS_SECONDS = 5 * 60;
const MIN_MOMENT_SECONDS = 0.6;
const MAX_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 90_000;
// PRE-JUDGING PASS 2026-09-09: clips are pre-uploaded in parallel on ONE key while the
// analysis stays strictly sequential, so the upload of clip 2 overlaps the analysis of
// clip 1. A Files API upload is bound to the key that made it, so the analysis is asked
// to start on that same key and finds the file already there. If that key is rate
// limited the analysis rotates and re-uploads exactly as before; the worst case is the
// old behaviour. Set CUTROOM_SELECTOR_PARALLEL_UPLOADS=0 to go back to strictly
// sequential upload-then-analyze.
const PARALLEL_UPLOADS =
  process.env.CUTROOM_SELECTOR_PARALLEL_UPLOADS !== "0";
const UPLOAD_CONCURRENCY = 3;
const SHOT_SIZE_ENUM = ["XCU", "CU", "MCU", "MS", "WS", "XWS"];
const SHOT_SIZE_ALIASES = {
  "EXTREME CLOSE UP": "XCU",
  "EXTREME CLOSE-UP": "XCU",
  ECU: "XCU",
  "CLOSE UP": "CU",
  "CLOSE-UP": "CU",
  "MEDIUM CLOSE UP": "MCU",
  "MEDIUM CLOSE-UP": "MCU",
  "MEDIUM SHOT": "MS",
  MEDIUM: "MS",
  "WIDE SHOT": "WS",
  WIDE: "WS",
  "EXTREME WIDE SHOT": "XWS",
  "EXTREME WIDE": "XWS",
  EWS: "XWS",
};
const PROMPT_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "prompts",
  "selector.txt",
);

export const SELECTOR_INTENT = {
  pacing_profile: "hot",
  shot_length_band_sec: [2, 6],
  look_for: [],
  avoid: [],
};

export const SELECTOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          action: { type: "string" },
          shot_size: { type: "string", enum: SHOT_SIZE_ENUM },
          camera_motion: { type: "string" },
          subject_motion: { type: "string" },
          audio_event: { type: "string" },
          intent_score: { type: "number" },
          look_for_hits: { type: "array", items: { type: "string" } },
          dead_shot: { type: "boolean" },
          notes: { type: "string" },
        },
        required: [
          "start_sec",
          "end_sec",
          "action",
          "shot_size",
          "camera_motion",
          "subject_motion",
          "audio_event",
          "intent_score",
          "look_for_hits",
          "dead_shot",
          "notes",
        ],
      },
    },
    quality_flags: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["moments", "quality_flags"],
};

function errorDetails(error) {
  const status = [
    error?.status,
    error?.code,
    error?.response?.status,
    error?.response?.statusCode,
    error?.cause?.status,
  ]
    .map(Number)
    .find(Number.isFinite);
  const errorClass =
    typeof error?.name === "string" && error.name.trim()
      ? error.name.trim()
      : error?.constructor?.name || "Error";
  return {
    status: status ?? null,
    errorClass,
  };
}

function failureLabel(error) {
  const { errorClass, status } = errorDetails(error);
  return `${errorClass}${status === null ? "" : `/${status}`}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function seconds(sinceMs) {
  return `${Math.round((Date.now() - sinceMs) / 1000)}s`;
}

// Runs tasks with at most `limit` in flight; results keep their input order.
async function mapWithLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }
  const workers = [];
  for (let count = 0; count < Math.min(limit, items.length); count += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function readSelectorPrompt() {
  return (await fs.readFile(PROMPT_PATH, "utf8")).trim();
}

async function prepareAnalysisFile(clip, duration, sessionDir) {
  if (!Number.isFinite(duration) || duration <= MAX_ANALYSIS_SECONDS) {
    return { filePath: clip.storedPath, analysisDuration: duration };
  }

  const trimDir = path.join(sessionDir, "selector");
  await fs.mkdir(trimDir, { recursive: true });
  const outputPath = path.join(
    trimDir,
    `${clip.clip_id || clip.filename.replace(/[^\w.-]+/g, "_")}.first-five-minutes.mp4`,
  );
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      clip.storedPath,
      "-t",
      String(MAX_ANALYSIS_SECONDS),
      "-map",
      "0",
      "-c",
      "copy",
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  return { filePath: outputPath, analysisDuration: MAX_ANALYSIS_SECONDS };
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeShotSize(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (SHOT_SIZE_ENUM.includes(raw)) return raw;
  return SHOT_SIZE_ALIASES[raw] || null;
}

function normaliseMoment(moment, duration) {
  if (!moment || typeof moment !== "object") return null;
  const start = Math.max(0, Math.min(duration, Number(moment.start_sec)));
  const end = Math.max(0, Math.min(duration, Number(moment.end_sec)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start < MIN_MOMENT_SECONDS || moment.dead_shot === true) return null;
  const shotSize = normalizeShotSize(moment.shot_size);
  if (!shotSize) return null;
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(end.toFixed(3)),
    action: typeof moment.action === "string" ? moment.action.trim() : "",
    shot_size: shotSize,
    camera_motion:
      typeof moment.camera_motion === "string" ? moment.camera_motion.trim() : "",
    subject_motion:
      typeof moment.subject_motion === "string" ? moment.subject_motion.trim() : "",
    audio_event:
      typeof moment.audio_event === "string" ? moment.audio_event.trim() : "",
    intent_score: Number.isFinite(Number(moment.intent_score))
      ? Math.max(0, Math.min(1, Number(moment.intent_score)))
      : 0,
    look_for_hits: stringArray(moment.look_for_hits),
    dead_shot: false,
    notes: typeof moment.notes === "string" ? moment.notes.trim() : "",
  };
}

function normaliseResult(result, duration) {
  const moments = Array.isArray(result?.moments)
    ? result.moments.map((moment) => normaliseMoment(moment, duration)).filter(Boolean)
    : [];
  return {
    moments,
    quality_flags: stringArray(result?.quality_flags),
  };
}

async function analyseClip({
  clip,
  inventory,
  sessionDir,
  intent,
  onProgress,
  prepared: preparedFile,
  preferKeyIndex,
}) {
  let lastError;
  const startedAt = Date.now();
  const name = inventory.filename;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const prepared =
        preparedFile ||
        (await prepareAnalysisFile(clip, Number(inventory.duration_seconds), sessionDir));
      const prompt = await readSelectorPrompt();
      const userPayload = [
        "SELECTOR TASK",
        `Clip filename: ${inventory.filename}`,
        `Clip id: ${inventory.clip_id}`,
        `Analysis duration in seconds: ${prepared.analysisDuration}`,
        `Director intent: ${JSON.stringify(intent)}`,
        "numbers as plain seconds, never MM:SS strings",
        "Return only JSON matching this complete output schema:",
        JSON.stringify(SELECTOR_OUTPUT_SCHEMA),
      ].join("\n");
      // analyzeVideo keeps the upload and the analysis on one key and re-uploads on the
      // next key when a key is rate limited, so a single key's quota cannot stall the crew.
      // One log line per key attempt, with the elapsed time for this clip; the analyzing
      // state update is silent so the log stays one line per attempt.
      const result = await analyzeVideo(
        prepared.filePath,
        prompt,
        SELECTOR_OUTPUT_SCHEMA,
        userPayload,
        (stage, info) => {
          if (stage === "analyzing") {
            onProgress({
              state: "analyzing",
              attempt,
              silent: true,
              message: `analyzing ${name}`,
            });
            return;
          }
          const where =
            info.attempt > 1
              ? `attempt ${attempt}, rotation ${info.attempt}, ${info.key}`
              : `attempt ${attempt}, ${info.key}`;
          const before = info.previous
            ? `${info.previous.key} was ${info.previous.shape}; `
            : "";
          const action = info.reusedUpload
            ? `already uploaded, analyzing`
            : `uploading then analyzing`;
          onProgress({
            state: info.reusedUpload ? "analyzing" : "uploading",
            attempt,
            message: `${name}: ${before}${action} (${where}) ${seconds(startedAt)}`,
          });
        },
        { preferKeyIndex },
      );
      const normalized = normaliseResult(result, prepared.analysisDuration);
      if (inventory.duration_seconds > MAX_ANALYSIS_SECONDS) {
        normalized.quality_flags.unshift("long clip analyzed from first five minutes");
      }
      onProgress({
        state: "complete",
        attempt,
        message: `${name}: selected ${normalized.moments.length} moments in ${seconds(startedAt)}`,
        moments: normalized.moments.length,
      });
      return normalized;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      const backoff = Math.min(
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
      );
      onProgress({
        state: "retrying",
        attempt,
        message: `Gemini is busy, the crew is waiting it out... ${name} attempt ${attempt + 1}/${MAX_ATTEMPTS}; retrying in ${Math.round(backoff / 1000)}s (${failureLabel(error)}) ${seconds(startedAt)}`,
      });
      await sleep(backoff);
    }
  }
  onProgress({
    state: "error",
    attempt: MAX_ATTEMPTS,
    message: `${name} failed after ${MAX_ATTEMPTS} attempts in ${seconds(startedAt)} (${failureLabel(lastError)}).`,
  });
  return {
    moments: [],
    quality_flags: ["selector unavailable"],
    error: `failed after ${MAX_ATTEMPTS} attempts (${failureLabel(lastError)})`,
  };
}

export async function runSelector({
  clips,
  inventory,
  sessionDir,
  intent = SELECTOR_INTENT,
  onProgress = () => {},
}) {
  const clipsResult = [];
  const moments = [];
  const errors = [];
  const startedAt = Date.now();

  const jobs = [];
  for (const clipInventory of inventory) {
    const clip = clips.find(
      (item) =>
        item.clip_id === clipInventory.clip_id ||
        item.name === clipInventory.filename ||
        item.filename === clipInventory.filename,
    );
    if (!clip) continue;
    jobs.push({ clip, inventory: clipInventory });
  }

  // Trim long clips to their first five minutes up front (stream copy, cheap) so the
  // pre-upload pass pushes the file the model will actually watch.
  for (const job of jobs) {
    try {
      job.prepared = await prepareAnalysisFile(
        job.clip,
        Number(job.inventory.duration_seconds),
        sessionDir,
      );
    } catch {
      job.prepared = undefined;
    }
  }

  let uploads = jobs.map(() => Promise.resolve(undefined));
  if (PARALLEL_UPLOADS && jobs.length > 1) {
    const keyIndex = pickKeyIndex();
    if (keyIndex !== undefined) {
      const keyText = `key ${keyIndex + 1}`;
      onProgress({
        state: "uploading",
        attempt: 0,
        message: `pre-uploading ${jobs.length} clips on ${keyText}, ${UPLOAD_CONCURRENCY} at a time; analysis stays sequential`,
      });
      const uploadOne = async (job) => {
        if (!job.prepared) return undefined;
        const uploadStart = Date.now();
        try {
          const outcome = await preuploadVideo(job.prepared.filePath, keyIndex);
          onProgress({
            clipId: job.inventory.clip_id,
            state: "queued",
            attempt: 0,
            message: outcome.ok
              ? `${job.inventory.filename}: pre-uploaded on ${keyText} in ${seconds(uploadStart)}`
              : `${job.inventory.filename}: pre-upload on ${keyText} was ${outcome.shape}; the analysis will upload it on the next key`,
          });
          return outcome.ok ? outcome.index : undefined;
        } catch (error) {
          onProgress({
            clipId: job.inventory.clip_id,
            state: "queued",
            attempt: 0,
            message: `${job.inventory.filename}: pre-upload failed (${failureLabel(error)}); the analysis will upload it`,
          });
          return undefined;
        }
      };
      // Kick every upload off now (bounded concurrency) and hand each clip its own
      // promise, so clip 1 starts analyzing the moment its own upload is ACTIVE while
      // clips 2 and 3 are still going up.
      const settled = jobs.map(() => {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        return { promise, resolve };
      });
      mapWithLimit(jobs, UPLOAD_CONCURRENCY, async (job, index) => {
        const used = await uploadOne(job);
        settled[index].resolve(used);
        return used;
      }).catch(() => {
        settled.forEach((entry) => entry.resolve(undefined));
      });
      uploads = settled.map((entry) => entry.promise);
    }
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const { clip, inventory: clipInventory, prepared } = jobs[index];
    const preferKeyIndex = await uploads[index];
    const result = await analyseClip({
      clip,
      inventory: clipInventory,
      sessionDir,
      intent,
      prepared,
      preferKeyIndex,
      onProgress: (progress) =>
        onProgress({ ...progress, clipId: clipInventory.clip_id }),
    });
    const clipResult = {
      clip_id: clipInventory.clip_id,
      filename: clipInventory.filename,
      quality_flags: result.quality_flags,
      moments: result.moments.map((moment) => ({
        clip_id: clipInventory.clip_id,
        filename: clipInventory.filename,
        ...moment,
      })),
    };
    if (result.error) errors.push(`${clipInventory.filename}: ${result.error}`);
    clipsResult.push(clipResult);
    moments.push(...clipResult.moments);
    onProgress({
      state: result.error ? "error" : "complete",
      attempt: 0,
      silent: true,
      message: `${index + 1}/${jobs.length} clips done, ${seconds(startedAt)} elapsed`,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    intent,
    clips: clipsResult,
    moments,
    errors,
    partial: errors.length > 0,
  };
}
