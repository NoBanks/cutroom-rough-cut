import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  generateJSONWithVideo,
  uploadVideo,
} from "../artifacts/api-server/src/lib/gemini.js";

const execFileAsync = promisify(execFile);
const MAX_ANALYSIS_SECONDS = 5 * 60;
const MIN_MOMENT_SECONDS = 0.6;
const MAX_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 90_000;
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

async function analyseClip({ clip, inventory, sessionDir, intent, onProgress }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      onProgress({ state: "uploading", attempt, message: `uploading ${inventory.filename}` });
      const prepared = await prepareAnalysisFile(
        clip,
        Number(inventory.duration_seconds),
        sessionDir,
      );
      const file = await uploadVideo(prepared.filePath);
      onProgress({ state: "analyzing", attempt, message: `analyzing ${inventory.filename}` });
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
      const result = await generateJSONWithVideo(
        prompt,
        file,
        SELECTOR_OUTPUT_SCHEMA,
        userPayload,
      );
      const normalized = normaliseResult(result, prepared.analysisDuration);
      if (inventory.duration_seconds > MAX_ANALYSIS_SECONDS) {
        normalized.quality_flags.unshift("long clip analyzed from first five minutes");
      }
      onProgress({
        state: "complete",
        attempt,
        message: `selected ${normalized.moments.length} moments from ${inventory.filename}`,
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
        message: `Gemini is busy, the crew is waiting it out... ${inventory.filename} attempt ${attempt + 1}/${MAX_ATTEMPTS}; retrying in ${Math.round(backoff / 1000)}s (${failureLabel(error)})`,
      });
      await sleep(backoff);
    }
  }
  onProgress({
    state: "error",
    attempt: MAX_ATTEMPTS,
    message: `${inventory.filename} failed after ${MAX_ATTEMPTS} attempts (${failureLabel(lastError)}).`,
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

  for (const clipInventory of inventory) {
    const clip = clips.find(
      (item) =>
        item.clip_id === clipInventory.clip_id ||
        item.name === clipInventory.filename ||
        item.filename === clipInventory.filename,
    );
    if (!clip) continue;
    const result = await analyseClip({
      clip,
      inventory: clipInventory,
      sessionDir,
      intent,
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