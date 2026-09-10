// COVERAGE: the fifth chair. Runs after the reviewer, reads the census the other four
// agents produced, and hands the shooter a pickup list for tomorrow. Text only; the
// model never sees the footage, only the evidence the crew already wrote down. Agents
// decide, code executes: the census is computed here, deterministically, and the
// model's answer is normalized and bounded before anything is written to disk.
import fs from "node:fs/promises";
import path from "node:path";
import { generateJSON } from "../artifacts/api-server/src/lib/gemini.js";

const PROMPT_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "prompts",
  "coverage.txt",
);

export const GAP_TYPES = [
  "shot_size",
  "motion",
  "subject",
  "audio",
  "opening",
  "closing",
  "continuity",
  "b_roll",
];
export const SEVERITIES = ["must", "should", "nice"];
export const SHOT_SIZES = ["EWS", "WS", "MS", "MCU", "CU", "ECU", "INSERT"];
export const MAX_GAPS = 8;
export const MAX_PICKUPS = 12;
const MIN_PICKUP_ROLL_SEC = 3;
const MAX_PICKUP_ROLL_SEC = 120;

export const COVERAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    coverage_summary: { type: "string" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gap_type: { type: "string", enum: GAP_TYPES },
          severity: { type: "string", enum: SEVERITIES },
          what_is_missing: { type: "string" },
          why_the_cut_needs_it: { type: "string" },
          evidence: { type: "string" },
        },
        required: [
          "gap_type",
          "severity",
          "what_is_missing",
          "why_the_cut_needs_it",
          "evidence",
        ],
      },
    },
    pickups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "number" },
          serves_gap: { type: "number" },
          shot_size: { type: "string", enum: SHOT_SIZES },
          shot: { type: "string" },
          movement: { type: "string" },
          duration_sec: { type: "number" },
          camera_note: { type: "string" },
        },
        required: [
          "priority",
          "serves_gap",
          "shot_size",
          "shot",
          "movement",
          "duration_sec",
          "camera_note",
        ],
      },
    },
    next_shoot_note: { type: "string" },
  },
  required: ["coverage_summary", "gaps", "pickups", "next_shoot_note"],
};

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeShotSize(value) {
  const raw = text(value).toUpperCase().replace(/[^A-Z]/g, "");
  if (SHOT_SIZES.includes(raw)) return raw;
  // Prose sizes still leak in from models; map the common ones instead of failing.
  const prose = text(value).toLowerCase();
  if (/extreme\s*wide|establish/.test(prose)) return "EWS";
  if (/wide/.test(prose)) return "WS";
  if (/medium\s*close/.test(prose)) return "MCU";
  if (/medium/.test(prose)) return "MS";
  if (/extreme\s*close/.test(prose)) return "ECU";
  if (/close/.test(prose)) return "CU";
  if (/insert|detail|cutaway/.test(prose)) return "INSERT";
  return null;
}

function momentKey(moment) {
  return `${moment.clip_id}:${Number(moment.start_sec).toFixed(3)}:${Number(
    moment.end_sec,
  ).toFixed(3)}`;
}

// An EDL row lives INSIDE a selected moment (the editor trims within the span the
// selector found), so "used" means containment, not equality. Same tolerance the
// editor's validator uses.
function rowInsideMoment(moment, row) {
  const start = Number(row.source_start_sec ?? row.start_sec);
  const end = Number(row.source_end_sec ?? row.end_sec);
  return (
    moment.clip_id === row.clip_id &&
    start >= Number(moment.start_sec) - 0.25 &&
    end <= Number(moment.end_sec) + 0.25
  );
}

// The census is pure code. It is what the model reasons over, and it is also written to
// coverage.json so a human can check every gap against the same numbers.
export function buildCoverageCensus({
  intent = {},
  inventory = [],
  moments = [],
  editorResult = null,
  reviewerResult = null,
}) {
  const edl = Array.isArray(editorResult?.edl) ? editorResult.edl : [];
  const live = moments.filter((moment) => !moment.dead_shot);
  const dead = moments.filter((moment) => Boolean(moment.dead_shot));
  const usedKeys = new Set(
    edl
      .map((row) => live.find((moment) => rowInsideMoment(moment, row)))
      .filter(Boolean)
      .map(momentKey),
  );

  const shotSizeCensus = {};
  for (const size of SHOT_SIZES) {
    shotSizeCensus[size] = { found: 0, in_cut: 0, benched: 0 };
  }
  for (const moment of live) {
    const size = normalizeShotSize(moment.shot_size) || "MS";
    shotSizeCensus[size].found += 1;
    if (usedKeys.has(momentKey(moment))) shotSizeCensus[size].in_cut += 1;
    else shotSizeCensus[size].benched += 1;
  }
  const missingSizes = SHOT_SIZES.filter((size) => shotSizeCensus[size].found === 0);

  const lookFor = Array.isArray(intent.look_for) ? intent.look_for : [];
  const hitCounts = lookFor.map((item) => ({
    look_for: item,
    hits: live.filter((moment) =>
      (Array.isArray(moment.look_for_hits) ? moment.look_for_hits : []).some(
        (hit) => text(hit).toLowerCase() === text(item).toLowerCase(),
      ),
    ).length,
  }));

  const staticMoments = live.filter(
    (moment) =>
      /static|locked|none|still/i.test(text(moment.camera_motion)) &&
      /static|none|still|minimal/i.test(text(moment.subject_motion)),
  );
  const clipsWithoutAudio = inventory.filter((clip) => !clip.has_audio);
  const rawRuntime = inventory.reduce(
    (sum, clip) => sum + (number(clip.duration_seconds) || 0),
    0,
  );
  const cutRuntime = number(editorResult?.total_duration_sec) || 0;
  const targetRuntime = number(intent.target_length_sec) || 0;
  const band = Array.isArray(intent.shot_length_band_sec)
    ? intent.shot_length_band_sec.map(Number)
    : [];
  const longestShot = edl.reduce(
    (max, row) => Math.max(max, number(row.duration_sec) || 0),
    0,
  );
  const shotsPastBand =
    band.length === 2
      ? edl.filter((row) => (number(row.duration_sec) || 0) > band[1]).length
      : 0;

  const opening = edl[0]
    ? {
        shot_size: edl[0].shot_size,
        action: edl[0].action,
        duration_sec: edl[0].duration_sec,
      }
    : null;
  const closing = edl.length
    ? {
        shot_size: edl[edl.length - 1].shot_size,
        action: edl[edl.length - 1].action,
        duration_sec: edl[edl.length - 1].duration_sec,
      }
    : null;

  return {
    clips: inventory.length,
    raw_runtime_sec: Number(rawRuntime.toFixed(3)),
    target_runtime_sec: targetRuntime,
    cut_runtime_sec: cutRuntime,
    runtime_shortfall_sec:
      targetRuntime > 0 ? Number(Math.max(0, targetRuntime - cutRuntime).toFixed(3)) : 0,
    moments_found: moments.length,
    moments_live: live.length,
    moments_dead: dead.length,
    moments_in_cut: usedKeys.size,
    moments_benched: live.length - usedKeys.size,
    shot_size_census: shotSizeCensus,
    missing_shot_sizes: missingSizes,
    look_for_hits: hitCounts,
    look_for_never_seen: hitCounts.filter((item) => item.hits === 0).map((item) => item.look_for),
    static_moments: staticMoments.length,
    clips_without_audio: clipsWithoutAudio.map((clip) => clip.filename),
    pacing_band_sec: band,
    longest_shot_in_cut_sec: longestShot,
    shots_past_pacing_band: shotsPastBand,
    opening,
    closing,
    reviewer_verdict: reviewerResult?.verdict || null,
    reviewer_findings: {
      pacing: Array.isArray(reviewerResult?.pacing_findings) ? reviewerResult.pacing_findings : [],
      continuity: Array.isArray(reviewerResult?.continuity_findings)
        ? reviewerResult.continuity_findings
        : [],
      repetition: Array.isArray(reviewerResult?.repetition_findings)
        ? reviewerResult.repetition_findings
        : [],
    },
    benched_strong_moments: (editorResult?.unused_strong_moments || []).map((moment) => ({
      filename: moment.filename,
      start_sec: moment.start_sec,
      end_sec: moment.end_sec,
      action: moment.action,
    })),
    dead_shots: dead.map((moment) => ({
      filename: moment.filename,
      start_sec: moment.start_sec,
      end_sec: moment.end_sec,
      notes: moment.notes,
    })),
  };
}

export function normalizeCoverageResult(result, census = {}) {
  const summary = text(result?.coverage_summary);
  if (!summary) throw new Error("Coverage returned no coverage_summary.");
  const note = text(result?.next_shoot_note);
  if (!note) throw new Error("Coverage returned no next_shoot_note.");

  const rawGaps = Array.isArray(result?.gaps) ? result.gaps : [];
  const skipped = [];
  const gaps = [];
  rawGaps.forEach((gap, index) => {
    const gapType = text(gap?.gap_type).toLowerCase();
    const severity = text(gap?.severity).toLowerCase();
    const missing = text(gap?.what_is_missing);
    if (!GAP_TYPES.includes(gapType)) {
      skipped.push(`gap ${index + 1}: unknown gap_type "${text(gap?.gap_type) || "?"}"`);
      return;
    }
    if (!missing) {
      skipped.push(`gap ${index + 1}: no what_is_missing`);
      return;
    }
    if (gaps.length >= MAX_GAPS) {
      skipped.push(`gap ${index + 1}: over the ${MAX_GAPS} gap cap`);
      return;
    }
    gaps.push({
      gap_index: gaps.length + 1,
      gap_type: gapType,
      severity: SEVERITIES.includes(severity) ? severity : "should",
      what_is_missing: missing,
      why_the_cut_needs_it: text(gap?.why_the_cut_needs_it),
      evidence: text(gap?.evidence),
    });
  });

  const band = Array.isArray(census.pacing_band_sec) ? census.pacing_band_sec : [];
  const minRoll =
    band.length === 2 && Number.isFinite(band[1])
      ? Math.max(MIN_PICKUP_ROLL_SEC, band[1] * 3)
      : MIN_PICKUP_ROLL_SEC;

  const rawPickups = Array.isArray(result?.pickups) ? result.pickups : [];
  const pickups = [];
  rawPickups.forEach((pickup, index) => {
    const shot = text(pickup?.shot);
    const shotSize = normalizeShotSize(pickup?.shot_size);
    if (!shot) {
      skipped.push(`pickup ${index + 1}: no shot description`);
      return;
    }
    if (!shotSize) {
      skipped.push(`pickup ${index + 1}: unknown shot_size "${text(pickup?.shot_size) || "?"}"`);
      return;
    }
    const serves = number(pickup?.serves_gap);
    const servesGap =
      serves !== null && serves >= 1 && serves <= gaps.length ? Math.round(serves) : null;
    if (gaps.length > 0 && servesGap === null) {
      skipped.push(`pickup ${index + 1}: serves_gap ${serves ?? "?"} does not name a gap`);
      return;
    }
    const roll = number(pickup?.duration_sec);
    const duration = Math.min(
      MAX_PICKUP_ROLL_SEC,
      Math.max(minRoll, roll !== null && roll > 0 ? roll : minRoll),
    );
    pickups.push({
      priority: number(pickup?.priority) ?? index + 1,
      serves_gap: servesGap,
      shot_size: shotSize,
      shot,
      movement: text(pickup?.movement),
      duration_sec: Number(duration.toFixed(1)),
      camera_note: text(pickup?.camera_note),
    });
  });
  pickups.sort((a, b) => a.priority - b.priority);
  const bounded = pickups.slice(0, MAX_PICKUPS).map((pickup, index) => ({
    ...pickup,
    priority: index + 1,
  }));
  if (pickups.length > MAX_PICKUPS) {
    skipped.push(`${pickups.length - MAX_PICKUPS} pickups over the ${MAX_PICKUPS} cap`);
  }
  if (gaps.length > 0 && bounded.length === 0) {
    throw new Error("Coverage named gaps but no pickup survived validation.");
  }

  return {
    generated_at: new Date().toISOString(),
    coverage_summary: summary,
    gaps,
    pickups: bounded,
    next_shoot_note: note,
    skipped,
    total_roll_sec: Number(
      bounded.reduce((sum, pickup) => sum + pickup.duration_sec, 0).toFixed(1),
    ),
  };
}

function pad(value, width) {
  return String(value).padEnd(width);
}

// A call sheet the shooter can print or read off a phone. Plain text on purpose: no
// markdown, no markup, nothing that needs an app to open.
export function renderPickupSheet(coverage, { brief = "", sessionId = "" } = {}) {
  const lines = [];
  lines.push("CUTROOM PICKUP LIST");
  if (brief) lines.push(`Brief: ${brief}`);
  if (sessionId) lines.push(`Session: ${sessionId}`);
  lines.push(`Generated: ${coverage.generated_at}`);
  lines.push("");
  lines.push(coverage.coverage_summary);
  lines.push("");
  if (coverage.gaps.length === 0) {
    lines.push("GAPS: none. The footage covers the cut.");
  } else {
    lines.push(`GAPS (${coverage.gaps.length})`);
    for (const gap of coverage.gaps) {
      lines.push(
        `${gap.gap_index}. [${gap.severity.toUpperCase()}] ${gap.gap_type}: ${gap.what_is_missing}`,
      );
      if (gap.why_the_cut_needs_it) lines.push(`   why: ${gap.why_the_cut_needs_it}`);
      if (gap.evidence) lines.push(`   evidence: ${gap.evidence}`);
    }
  }
  lines.push("");
  if (coverage.pickups.length === 0) {
    lines.push("PICKUPS: none needed.");
  } else {
    lines.push(
      `PICKUPS (${coverage.pickups.length}, roll about ${Math.ceil(coverage.total_roll_sec)}s total)`,
    );
    for (const pickup of coverage.pickups) {
      const gapLabel = pickup.serves_gap ? ` for gap ${pickup.serves_gap}` : "";
      lines.push(
        `${pad(`${pickup.priority}.`, 4)}${pad(pickup.shot_size, 7)} roll ${pickup.duration_sec}s${gapLabel}`,
      );
      lines.push(`    ${pickup.shot}`);
      if (pickup.movement) lines.push(`    movement: ${pickup.movement}`);
      if (pickup.camera_note) lines.push(`    camera: ${pickup.camera_note}`);
    }
  }
  lines.push("");
  lines.push("FIRST HOUR");
  lines.push(coverage.next_shoot_note);
  if (coverage.skipped.length) {
    lines.push("");
    lines.push("Left out by validation:");
    for (const item of coverage.skipped) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function readCoveragePrompt() {
  return (await fs.readFile(PROMPT_PATH, "utf8")).trim();
}

export async function runCoverage({
  intent = {},
  inventory = [],
  moments = [],
  editorResult = null,
  reviewerResult = null,
  brief = "",
  sessionId = "",
  onLog = () => {},
  generate = generateJSON,
}) {
  const census = buildCoverageCensus({
    intent,
    inventory,
    moments,
    editorResult,
    reviewerResult,
  });
  onLog(
    `census: ${census.moments_live} live moments, ${census.moments_in_cut} in the cut, ${census.moments_benched} benched, ${census.moments_dead} dead; sizes missing: ${
      census.missing_shot_sizes.length ? census.missing_shot_sizes.join(" ") : "none"
    }; never seen: ${
      census.look_for_never_seen.length ? census.look_for_never_seen.length : 0
    } of ${census.look_for_hits.length} look_for items`,
  );
  const prompt = await readCoveragePrompt();
  const userPayload = [
    "COVERAGE TASK",
    `Session id: ${sessionId}`,
    `Creative brief: ${brief || "(preset only)"}`,
    `Director intent: ${JSON.stringify(intent)}`,
    `Census (computed by code, treat as fact): ${JSON.stringify(census)}`,
    `Cut as delivered (EDL rows): ${JSON.stringify(
      (editorResult?.edl || []).map((row) => ({
        edit_index: row.edit_index,
        filename: row.filename,
        shot_size: row.shot_size,
        duration_sec: row.duration_sec,
        role: row.role,
        action: row.action,
      })),
    )}`,
    "Return only JSON matching this complete output schema:",
    JSON.stringify(COVERAGE_OUTPUT_SCHEMA),
  ].join("\n");
  const result = await generate(prompt, userPayload, COVERAGE_OUTPUT_SCHEMA);
  const coverage = normalizeCoverageResult(result, census);
  return { coverage: { ...coverage, census } };
}
