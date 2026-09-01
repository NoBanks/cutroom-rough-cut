import fs from "node:fs/promises";
import path from "node:path";
import { generateJSON } from "../artifacts/api-server/src/lib/gemini.js";

const PROMPT_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "prompts",
  "director.txt",
);

export const PRESET_INTENTS = {
  "Energetic promo": {
    preset_key: "promo",
    pacing_profile: "hot",
    shot_length_band_sec: [1, 4],
    tone_words: ["urgent", "bold", "kinetic"],
    target_length_sec: 30,
  },
  "Quiet documentary": {
    preset_key: "documentary",
    pacing_profile: "slow",
    shot_length_band_sec: [4, 10],
    tone_words: ["observational", "human", "patient"],
    target_length_sec: 90,
  },
  "Social short 60s": {
    preset_key: "social60",
    pacing_profile: "hot",
    shot_length_band_sec: [1, 3],
    tone_words: ["immediate", "clear", "shareable"],
    target_length_sec: 60,
  },
};

export const DIRECTOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    pacing_profile: { type: "string", enum: ["hot", "steady", "slow"] },
    shot_length_band_sec: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    look_for: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
    tone_words: { type: "array", items: { type: "string" } },
    target_length_sec: { type: "number" },
    structure: { type: "string" },
    directors_note: { type: "string" },
  },
  required: [
    "pacing_profile",
    "shot_length_band_sec",
    "look_for",
    "avoid",
    "tone_words",
    "target_length_sec",
    "structure",
    "directors_note",
  ],
};

function stringArray(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function presetIntent(preset) {
  return PRESET_INTENTS[preset] || {};
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeBand(value, fallback) {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const band = value.map(Number);
  if (!band.every((number) => Number.isFinite(number) && number > 0)) {
    return fallback;
  }
  const [start, end] = band[0] <= band[1] ? band : [band[1], band[0]];
  return [Number(start.toFixed(2)), Number(end.toFixed(2))];
}

export function normalizeDirectorResult(result, preset = "") {
  const defaults = presetIntent(preset);
  const pacingProfiles = new Set(["hot", "steady", "slow"]);
  const pacingProfile = pacingProfiles.has(result?.pacing_profile)
    ? result.pacing_profile
    : defaults.pacing_profile || "steady";
  const directorsNote =
    typeof result?.directors_note === "string"
      ? result.directors_note.trim()
      : "";
  if (!directorsNote) throw new Error("Director returned no directors_note.");

  return {
    preset_key: defaults.preset_key || null,
    pacing_profile: pacingProfile,
    shot_length_band_sec: normalizeBand(
      result?.shot_length_band_sec,
      defaults.shot_length_band_sec || [2, 6],
    ),
    look_for: stringArray(result?.look_for),
    avoid: stringArray(result?.avoid),
    tone_words: stringArray(result?.tone_words),
    target_length_sec: positiveNumber(
      result?.target_length_sec,
      defaults.target_length_sec || 60,
    ),
    structure:
      typeof result?.structure === "string" ? result.structure.trim() : "",
    directors_note: directorsNote,
  };
}

async function readDirectorPrompt() {
  return (await fs.readFile(PROMPT_PATH, "utf8")).trim();
}

export async function runDirector({
  brief,
  preset = "",
  sessionId,
  inventory = [],
}) {
  const prompt = await readDirectorPrompt();
  const mappedPreset = presetIntent(preset);
  const userPayload = [
    "DIRECTOR TASK",
    `Session id: ${sessionId}`,
    `Creative brief: ${brief || "(preset only)"}`,
    `Preset: ${preset || "(none)"}`,
    `Preset mapping (use these values when supplied): ${JSON.stringify(mappedPreset)}`,
    `Footage inventory: ${JSON.stringify(
      inventory.map(({ filename, clip_id, duration_seconds, resolution, has_audio }) => ({
        filename,
        clip_id,
        duration_seconds,
        resolution,
        has_audio,
      })),
    )}`,
    "Return only JSON matching this complete output schema:",
    JSON.stringify(DIRECTOR_OUTPUT_SCHEMA),
  ].join("\n");
  const result = await generateJSON(prompt, userPayload, DIRECTOR_OUTPUT_SCHEMA);
  const intent = normalizeDirectorResult(result, preset);
  return { intent };
}