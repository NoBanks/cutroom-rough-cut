// Offline proof of the COVERAGE agent. No network, no key: the model is a stub handed in
// through runCoverage's `generate` seam, and the evidence is a real production session
// (2026-09-07, verdict SHIP) captured from the deployed app. Run with `pnpm run test`
// from artifacts/api-server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GEMINI_API_KEYS = "stub-key-one";

const here = path.dirname(fileURLToPath(import.meta.url));
const session = JSON.parse(
  await fs.readFile(path.join(here, "fixtures/session_2026-09-07_ship.json"), "utf8"),
);
const coverage = await import("../../../agents/coverage.js");

const evidence = {
  intent: session.directorIntent,
  inventory: session.inventory,
  moments: session.moments,
  editorResult: session.editorResult,
  reviewerResult: session.reviewerResult,
  brief: session.brief,
  sessionId: session.id,
};

const MODEL_ANSWER = {
  coverage_summary: "Three clips, one subject, no true close-up and no insert coverage.",
  gaps: [
    {
      gap_type: "shot_size",
      severity: "must",
      what_is_missing: "A clean CU of hands on the frame edge",
      why_the_cut_needs_it: "The director asked for hands close up and the census shows zero CU.",
      evidence: "shot_size_census.CU.found = 0; look_for hands touching the frames close up: 0 hits",
    },
    {
      gap_type: "closing",
      severity: "should",
      what_is_missing: "An ending with motion that leaves the frame",
      why_the_cut_needs_it: "The cut ends on a settle.",
      evidence: "closing.shot_size",
    },
    {
      gap_type: "wishlist",
      severity: "must",
      what_is_missing: "A drone shot",
      why_the_cut_needs_it: "",
      evidence: "",
    },
  ],
  pickups: [
    {
      priority: 2,
      serves_gap: 2,
      shot_size: "MS",
      shot: "Subject lifts the framed print off the desk and walks it out of frame left",
      movement: "subject exits frame",
      duration_sec: 4,
      camera_note: "handheld, chest height",
    },
    {
      priority: 1,
      serves_gap: 1,
      shot_size: "close-up",
      shot: "Fingertips tracing the frame edge, print in soft focus behind",
      movement: "hands only",
      duration_sec: 20,
      camera_note: "locked off, low, side light",
    },
    {
      priority: 3,
      serves_gap: 9,
      shot_size: "CU",
      shot: "Orphan pickup that names a gap that does not exist",
      movement: "",
      duration_sec: 10,
      camera_note: "",
    },
  ],
  next_shoot_note: "Start on the hands. Get the close coverage before the light moves.",
};

test("the census is computed from the crew's evidence, not the model", () => {
  const census = coverage.buildCoverageCensus(evidence);
  assert.equal(census.clips, 3);
  assert.equal(census.moments_found, 8);
  assert.equal(census.moments_in_cut, session.editorResult.edl.length);
  assert.equal(census.moments_benched, census.moments_live - census.moments_in_cut);
  assert.equal(census.target_runtime_sec, 30);
  assert.equal(census.cut_runtime_sec, session.editorResult.total_duration_sec);
  assert.ok(census.runtime_shortfall_sec > 0, "the SHIP cut was under target");
  assert.deepEqual(census.clips_without_audio, ["clip_2.mp4"]);
  assert.equal(census.reviewer_verdict, "ship");
  assert.equal(census.look_for_hits.length, session.directorIntent.look_for.length);
  const total = Object.values(census.shot_size_census).reduce((sum, row) => sum + row.found, 0);
  assert.equal(total, census.moments_live);
});

test("the model's answer is normalized and bounded before it is trusted", async () => {
  const calls = [];
  const { coverage: result } = await coverage.runCoverage({
    ...evidence,
    onLog: (line) => calls.push(line),
    generate: async (systemPrompt, userPayload, schema) => {
      calls.push({ systemPrompt, userPayload, schema });
      return MODEL_ANSWER;
    },
  });
  const modelCall = calls.find((entry) => typeof entry === "object");
  assert.match(modelCall.systemPrompt, /COVERAGE, the fifth chair/);
  assert.match(modelCall.userPayload, /Census \(computed by code/);
  assert.equal(modelCall.schema, coverage.COVERAGE_OUTPUT_SCHEMA);
  assert.ok(calls.some((entry) => typeof entry === "string" && entry.startsWith("census:")));

  assert.equal(result.gaps.length, 2, "the wishlist gap_type is dropped");
  assert.deepEqual(result.gaps.map((gap) => gap.gap_index), [1, 2]);
  assert.equal(result.pickups.length, 2, "the orphan pickup is dropped");
  assert.deepEqual(result.pickups.map((pickup) => pickup.priority), [1, 2]);
  assert.equal(result.pickups[0].shot_size, "CU", "prose shot size mapped to the enum");
  assert.equal(result.pickups[0].serves_gap, 1);
  assert.equal(result.pickups[1].duration_sec, 15, "roll time raised to 3x the pacing band");
  assert.equal(result.pickups[0].duration_sec, 20);
  assert.equal(result.total_roll_sec, 35);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.census, "the census rides along in coverage.json");
});

test("an empty answer is a failure, never a blank sheet", () => {
  assert.throws(
    () => coverage.normalizeCoverageResult({ gaps: [], pickups: [] }),
    /coverage_summary/,
  );
  assert.throws(
    () =>
      coverage.normalizeCoverageResult({
        coverage_summary: "x",
        next_shoot_note: "y",
        gaps: [MODEL_ANSWER.gaps[0]],
        pickups: [],
      }),
    /no pickup survived/,
  );
});

test("zero gaps is an honest answer when the census is complete", () => {
  const result = coverage.normalizeCoverageResult({
    coverage_summary: "Every size and every look_for item is on the bench.",
    next_shoot_note: "Nothing to shoot. Finish the cut.",
    gaps: [],
    pickups: [],
  });
  assert.equal(result.gaps.length, 0);
  assert.equal(result.pickups.length, 0);
  const sheet = coverage.renderPickupSheet(result);
  assert.match(sheet, /GAPS: none/);
  assert.match(sheet, /PICKUPS: none needed/);
});

test("the pickup sheet is plain text a shooter can read on a phone", () => {
  const result = coverage.normalizeCoverageResult(MODEL_ANSWER, { pacing_band_sec: [2, 5] });
  const sheet = coverage.renderPickupSheet(result, { brief: "a promo", sessionId: "abc" });
  assert.match(sheet, /^CUTROOM PICKUP LIST\n/);
  assert.match(sheet, /GAPS \(2\)/);
  assert.match(sheet, /1\. \[MUST\] shot_size: A clean CU/);
  assert.match(sheet, /PICKUPS \(2, roll about 35s total\)/);
  assert.match(sheet, /1\.  CU {6}roll 20s for gap 1/);
  assert.match(sheet, /FIRST HOUR\nStart on the hands/);
  assert.match(sheet, /Left out by validation:/);
  assert.doesNotMatch(sheet, /[*#`|]/, "no markdown markers");
});
