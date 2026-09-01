import fs from "node:fs/promises";
import path from "node:path";
import { generateJSON } from "../artifacts/api-server/src/lib/gemini.js";

const PROMPT_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "prompts",
  "editor.txt",
);
const VALIDATION_ATTEMPTS = 2;
const DURATION_TOLERANCE = 0.08;

export const EDITOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    structure_notes: { type: "array", items: { type: "string" } },
    edl: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clip_id: { type: "string" },
          filename: { type: "string" },
          source_start_sec: { type: "number" },
          source_end_sec: { type: "number" },
          duration_sec: { type: "number" },
          role: { type: "string" },
        },
        required: [
          "clip_id",
          "filename",
          "source_start_sec",
          "source_end_sec",
          "duration_sec",
          "role",
        ],
      },
    },
    unused_strong_moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clip_id: { type: "string" },
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          action: { type: "string" },
          reason: { type: "string" },
        },
        required: ["clip_id", "start_sec", "end_sec", "action", "reason"],
      },
    },
  },
  required: ["summary", "structure_notes", "edl", "unused_strong_moments"],
};

async function readEditorPrompt() {
  return (await fs.readFile(PROMPT_PATH, "utf8")).trim();
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function momentKey(moment) {
  return `${moment.clip_id}:${Number(moment.start_sec).toFixed(3)}:${Number(
    moment.end_sec,
  ).toFixed(3)}`;
}

function matchingMoment(row, moments) {
  const clipId = typeof row?.clip_id === "string" ? row.clip_id : "";
  const start = numberValue(
    row?.source_start_sec ?? row?.start_sec ?? row?.in_sec,
  );
  const end = numberValue(row?.source_end_sec ?? row?.end_sec ?? row?.out_sec);
  if (!clipId || start === null || end === null) return null;
  return (
    moments.find(
      (moment) =>
        moment.clip_id === clipId &&
        start >= Number(moment.start_sec) - DURATION_TOLERANCE &&
        end <= Number(moment.end_sec) + DURATION_TOLERANCE,
    ) || null
  );
}

export function validateEditorResult(result, moments, inventory) {
  const errors = [];
  if (!result || typeof result !== "object") {
    return { ok: false, errors: ["Editor returned no object."] };
  }
  if (typeof result.summary !== "string" || !result.summary.trim()) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(result.structure_notes)) {
    errors.push("structure_notes must be an array");
  }
  if (!Array.isArray(result.edl)) {
    errors.push("edl must be an array");
  }
  if (errors.length > 0) return { ok: false, errors };

  const knownClipIds = new Set(inventory.map((clip) => clip.clip_id));
  const normalizedRows = [];
  let totalDuration = 0;
  result.edl.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      errors.push(`edl row ${index + 1} is not an object`);
      return;
    }
    const clipId = typeof row.clip_id === "string" ? row.clip_id : "";
    if (!knownClipIds.has(clipId)) {
      errors.push(`edl row ${index + 1} references an unknown clip_id`);
      return;
    }
    const sourceMoment = matchingMoment(row, moments);
    if (!sourceMoment) {
      errors.push(`edl row ${index + 1} is outside a selected source moment`);
      return;
    }
    const start = numberValue(
      row.source_start_sec ?? row.start_sec ?? row.in_sec,
    );
    const end = numberValue(row.source_end_sec ?? row.end_sec ?? row.out_sec);
    if (start === null || end === null || end <= start) {
      errors.push(`edl row ${index + 1} has invalid source bounds`);
      return;
    }
    const computedDuration = Number((end - start).toFixed(3));
    const declaredDuration = numberValue(row.duration_sec ?? row.duration_seconds);
    if (
      declaredDuration !== null &&
      Math.abs(declaredDuration - computedDuration) > DURATION_TOLERANCE
    ) {
      errors.push(`edl row ${index + 1} has an incorrect duration`);
      return;
    }
    const clip = inventory.find((item) => item.clip_id === clipId);
    const filename = clip?.filename || sourceMoment.filename;
    normalizedRows.push({
      edit_index: index + 1,
      clip_id: clipId,
      filename,
      source_start_sec: Number(start.toFixed(3)),
      source_end_sec: Number(end.toFixed(3)),
      duration_sec: computedDuration,
      role: typeof row.role === "string" ? row.role.trim() : "",
      action: sourceMoment.action,
      shot_size: sourceMoment.shot_size,
    });
    totalDuration += computedDuration;
  });
  if (normalizedRows.length === 0) errors.push("edl must contain at least one valid row");

  const selectedKeys = new Set(normalizedRows.map((row) => {
    const source = moments.find(
      (moment) =>
        moment.clip_id === row.clip_id &&
        Math.abs(moment.start_sec - row.source_start_sec) <= DURATION_TOLERANCE &&
        Math.abs(moment.end_sec - row.source_end_sec) <= DURATION_TOLERANCE,
    );
    return source ? momentKey(source) : "";
  }));
  const unused = moments
    .filter((moment) => Number(moment.intent_score) >= 0.7)
    .filter((moment) => !selectedKeys.has(momentKey(moment)))
    .map((moment) => ({
      clip_id: moment.clip_id,
      filename: moment.filename,
      start_sec: moment.start_sec,
      end_sec: moment.end_sec,
      action: moment.action,
      reason: "strong moment left out of the current structure",
    }));

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      generated_at: new Date().toISOString(),
      summary: result.summary.trim(),
      structure_notes: result.structure_notes
        .filter((note) => typeof note === "string")
        .map((note) => note.trim())
        .filter(Boolean),
      total_duration_sec: Number(totalDuration.toFixed(3)),
      edl: normalizedRows,
      unused_strong_moments: unused,
    },
  };
}

export async function runEditor({
  intent,
  selects,
  inventory,
  sessionId,
}) {
  const prompt = await readEditorPrompt();
  const moments = Array.isArray(selects?.moments)
    ? selects.moments.filter(
        (moment) =>
          moment &&
          typeof moment.clip_id === "string" &&
          Number.isFinite(Number(moment.start_sec)) &&
          Number.isFinite(Number(moment.end_sec)) &&
          Number(moment.end_sec) > Number(moment.start_sec),
      )
    : [];
  const input = {
    session_id: sessionId,
    intent,
    target_length_sec: intent?.target_length_sec,
    moments,
  };
  let validationErrors = [];
  for (let attempt = 1; attempt <= VALIDATION_ATTEMPTS; attempt += 1) {
    const userPayload = [
      "EDITOR TASK",
      `Attempt: ${attempt}/${VALIDATION_ATTEMPTS}`,
      `Filtered selects from selects.json: ${JSON.stringify(input)}`,
      validationErrors.length
        ? `Previous validation errors. Correct every one: ${JSON.stringify(validationErrors)}`
        : "This is the first request.",
      "Use only the supplied moments. Return an ordered EDL, not invented footage.",
      "Return only JSON matching this complete output schema:",
      JSON.stringify(EDITOR_OUTPUT_SCHEMA),
    ].join("\n");
    const result = await generateJSON(prompt, userPayload, EDITOR_OUTPUT_SCHEMA);
    const validated = validateEditorResult(result, moments, inventory);
    if (validated.ok) return validated.value;
    validationErrors = validated.errors;
  }
  throw new Error(
    `Editor returned invalid EDL twice: ${validationErrors.join("; ")}`,
  );
}