import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Router, type Request, type Response } from "express";
import multer from "multer";
import { generateJSON } from "../lib/gemini.js";

const router = Router();
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_RUNTIME_SECONDS = 30 * 60;
const LONG_CLIP_SECONDS = 5 * 60;
// An empty brief is not an error. The crew is given a house default so the
// session still produces a cut, and the director log says so out loud.
const DEFAULT_BRIEF = "cut the best 45 seconds from this footage";
// Temp session directories are swept on a timer. Nothing here is meant to
// outlive a working session.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 60 * 1000;
// Browsers send video/quicktime for .mov and occasionally an empty type or
// application/octet-stream for a file dragged off an external drive. Anything
// that names itself as a non-video type is rejected before a byte is probed.
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "application/octet-stream",
  "application/mp4",
]);
const SESSION_COOKIE = "cutroom_session";
const currentDirectory = process.cwd();
const workspaceRoot =
  path.basename(currentDirectory) === "api-server" &&
  path.basename(path.dirname(currentDirectory)) === "artifacts"
    ? path.resolve(currentDirectory, "../..")
    : currentDirectory;
const TEMP_DIR = path.join(workspaceRoot, "artifacts/api-server/tmp-sessions");
const SAMPLE_DIR = path.join(workspaceRoot, "sample_clips");
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov"]);

type ClipSource = "upload" | "sample";

interface Clip {
  name: string;
  size: number;
  source: ClipSource;
  fileName: string;
  storedPath: string;
}

interface InventoryClip {
  filename: string;
  clip_id: string;
  duration_seconds: number;
  resolution: string;
  fps: number | null;
  has_audio: boolean;
  flag?: string;
}

interface RejectedClip {
  name: string;
  reason: string;
}

interface SelectorClipState {
  clip_id: string;
  filename: string;
  state: "queued" | "uploading" | "analyzing" | "retrying" | "complete" | "error";
  attempt: number;
  message?: string;
  moments?: number;
}

interface SelectorMoment {
  clip_id: string;
  filename: string;
  start_sec: number;
  end_sec: number;
  action: string;
  shot_size: string;
  camera_motion: string;
  subject_motion: string;
  audio_event: string;
  intent_score: number;
  look_for_hits: string[];
  dead_shot: boolean;
  notes: string;
}

interface SelectorResult {
  generated_at: string;
  intent: Record<string, unknown>;
  clips: Array<{
    clip_id: string;
    filename: string;
    quality_flags: string[];
    moments: SelectorMoment[];
  }>;
  moments: SelectorMoment[];
  errors: string[];
  partial: boolean;
}

interface DirectorResult {
  intent: Record<string, unknown>;
}

interface EditorResult {
  generated_at: string;
  summary: string;
  structure_notes: string[];
  total_duration_sec: number;
  edl: Array<{
    edit_index: number;
    clip_id: string;
    filename: string;
    source_start_sec: number;
    source_end_sec: number;
    duration_sec: number;
    role: string;
    action: string;
    shot_size: string;
  }>;
  unused_strong_moments: Array<{
    clip_id: string;
    filename: string;
    start_sec: number;
    end_sec: number;
    action: string;
    reason: string;
  }>;
}

interface RoughCut {
  filename: string;
  path: string;
  shots: number;
  sizeBytes: number;
  durationSec: number;
  fps: number | null;
  width: number;
  height: number;
  videoCodec: string;
  pixelFormat: string;
  audioCodec: string;
}

interface AppliedOrder {
  op: string;
  position: number | null;
  reason: string;
  detail: string;
  before: string;
  after: string;
}

interface ReviewerResult {
  generated_at: string;
  watched_runtime_sec: number;
  verdict: "ship" | "one_pass";
  pacing_findings: string[];
  continuity_findings: string[];
  repetition_findings: string[];
  orders: Array<Record<string, unknown>>;
  reviewers_note: string;
}

interface SessionState {
  id: string;
  dir: string;
  clips: Clip[];
  brief: string;
  preset: string;
  status: "intake" | "assembling" | "completed" | "error";
  inventory: InventoryClip[];
  inventoryErrors: string[];
  totalRuntimeSeconds: number;
  crewStatusAttempted: boolean;
  directorAttempted: boolean;
  crewStatus?: string;
  crewStatusError?: string;
  directorStatus: "idle" | "running" | "complete" | "error";
  directorLog: string[];
  directorIntent?: Record<string, unknown>;
  directorsNote?: string;
  directorError?: string;
  selectorStatus: "idle" | "running" | "complete" | "error";
  selectorLog: string[];
  selectorClips: SelectorClipState[];
  moments: SelectorMoment[];
  selects?: SelectorResult;
  selectorError?: string;
  editorStatus: "idle" | "running" | "complete" | "error";
  editorLog: string[];
  editorResult?: EditorResult;
  editorError?: string;
  assemblyStatus: "idle" | "running" | "complete" | "error";
  assemblyLog: string[];
  roughCut?: RoughCut;
  assemblyError?: string;
  reviewerStatus: "idle" | "running" | "complete" | "error";
  reviewerLog: string[];
  reviewerResult?: ReviewerResult;
  reviewerError?: string;
  reviewAttempted: boolean;
  appliedOrders: AppliedOrder[];
  skippedOrders: string[];
  cutVersion: number;
  roughCutV1?: RoughCut;
  editorResultV1?: EditorResult;
  runFailure?: RunFailure;
  briefDefaulted: boolean;
  lastTouchedAt: number;
}

interface RunFailure {
  stage: string;
  message: string;
  retryable: boolean;
}

interface SessionRequest extends Request {
  cutroomSession?: SessionState;
}

const sessions = new Map<string, SessionState>();
const execFileAsync = promisify(execFile);

function createSession(): SessionState {
  const id = crypto.randomUUID();
  const session: SessionState = {
    id,
    dir: path.join(TEMP_DIR, id),
    clips: [],
    brief: "",
    preset: "",
    status: "intake",
    inventory: [],
    inventoryErrors: [],
    totalRuntimeSeconds: 0,
    crewStatusAttempted: false,
    directorAttempted: false,
    directorStatus: "idle",
    directorLog: [],
    selectorStatus: "idle",
    selectorLog: [],
    selectorClips: [],
    moments: [],
    editorStatus: "idle",
    editorLog: [],
    assemblyStatus: "idle",
    assemblyLog: [],
    reviewerStatus: "idle",
    reviewerLog: [],
    reviewAttempted: false,
    appliedOrders: [],
    skippedOrders: [],
    cutVersion: 1,
    briefDefaulted: false,
    lastTouchedAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

function getSession(req: SessionRequest, res: Response): SessionState {
  if (req.cutroomSession) return req.cutroomSession;

  const rawCookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === SESSION_COOKIE)?.[1];
  const cookieId =
    rawCookie ??
    (typeof req.cookies?.[SESSION_COOKIE] === "string"
      ? req.cookies[SESSION_COOKIE]
      : undefined);
  const bodyId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
  const queryId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const requestedId = cookieId ?? bodyId ?? queryId;
  const session = requestedId ? sessions.get(requestedId) : undefined;
  const active = session ?? createSession();

  req.cutroomSession = active;
  res.cookie(SESSION_COOKIE, active.id, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24,
  });
  return active;
}

function isVideoFile(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function safeName(filename: string): string {
  return path.basename(filename).replace(/[^\w.\- ]/g, "_").slice(0, 160);
}

function serializeSession(session: SessionState) {
  return {
    id: session.id,
    sessionId: session.id,
    clips: session.clips.map(({ name, size, source }) => ({
      name,
      size,
      source,
    })),
    clipCount: session.clips.length,
    totalBytes: session.clips.reduce((sum, clip) => sum + clip.size, 0),
    brief: session.brief,
    preset: session.preset,
    status: session.status,
    inventory: session.inventory,
    inventoryErrors: session.inventoryErrors,
    totalRuntimeSeconds: session.totalRuntimeSeconds,
    crewStatus: session.crewStatus,
    crewStatusError: session.crewStatusError,
    directorStatus: session.directorStatus,
    directorLog: session.directorLog,
    directorIntent: session.directorIntent,
    directorsNote: session.directorsNote,
    directorError: session.directorError,
    selectorStatus: session.selectorStatus,
    selectorLog: session.selectorLog,
    selectorClips: session.selectorClips,
    moments: session.moments,
    selects: session.selects,
    selectorError: session.selectorError,
    editorStatus: session.editorStatus,
    editorLog: session.editorLog,
    editorResult: session.editorResult,
    editorError: session.editorError,
    assemblyStatus: session.assemblyStatus,
    assemblyLog: session.assemblyLog,
    assemblyError: session.assemblyError,
    reviewerStatus: session.reviewerStatus,
    reviewerLog: session.reviewerLog,
    reviewerResult: session.reviewerResult,
    reviewerError: session.reviewerError,
    appliedOrders: session.appliedOrders,
    skippedOrders: session.skippedOrders,
    cutVersion: session.cutVersion,
    runFailure: session.runFailure,
    canRetry: Boolean(session.runFailure?.retryable) && session.clips.length > 0,
    briefDefaulted: session.briefDefaulted,
    hasRoughCutV1: Boolean(session.roughCutV1),
    roughCutV1: session.roughCutV1
      ? {
          filename: session.roughCutV1.filename,
          shots: session.roughCutV1.shots,
          sizeBytes: session.roughCutV1.sizeBytes,
          durationSec: session.roughCutV1.durationSec,
        }
      : undefined,
    roughCut: session.roughCut
      ? {
          filename: session.roughCut.filename,
          shots: session.roughCut.shots,
          sizeBytes: session.roughCut.sizeBytes,
          durationSec: session.roughCut.durationSec,
          fps: session.roughCut.fps,
          width: session.roughCut.width,
          height: session.roughCut.height,
          videoCodec: session.roughCut.videoCodec,
          pixelFormat: session.roughCut.pixelFormat,
          audioCodec: session.roughCut.audioCodec,
        }
      : undefined,
  };
}

function errorResponse(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string | number;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string | number };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex").slice(0, 4);
}

function parseFps(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null;
}

async function probeClip(clip: Clip): Promise<InventoryClip> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
      "-of",
      "json",
      clip.storedPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const output = JSON.parse(stdout) as ProbeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const durationCandidates = [
    output.format?.duration,
    ...streams.map((stream) => stream.duration),
  ]
    .map(Number)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const duration = durationCandidates[0];

  if (!Number.isFinite(duration)) {
    throw new Error("no readable duration");
  }

  const clipHash = await hashFile(clip.storedPath);
  return {
    filename: clip.name,
    clip_id: `clip_${clipHash}`,
    duration_seconds: Number(duration.toFixed(3)),
    resolution:
      video?.width && video?.height ? `${video.width}x${video.height}` : "unknown",
    fps: parseFps(video?.r_frame_rate),
    has_audio: streams.some((stream) => stream.codec_type === "audio"),
    ...(duration > LONG_CLIP_SECONDS
      ? { flag: "long clip - selector will sample it" }
      : {}),
  };
}

async function buildInventory(clips: Clip[]) {
  const accepted: Array<{ clip: Clip; inventory: InventoryClip }> = [];
  const rejected: Array<{ clip: Clip; error: RejectedClip }> = [];

  for (const clip of clips) {
    try {
      accepted.push({ clip, inventory: await probeClip(clip) });
    } catch {
      rejected.push({
        clip,
        error: {
          name: clip.name,
          reason: "unreadable or corrupt video",
        },
      });
    }
  }

  return {
    accepted,
    rejected,
    totalRuntimeSeconds: accepted.reduce(
      (sum, item) => sum + item.inventory.duration_seconds,
      0,
    ),
  };
}

async function writeInventory(
  session: SessionState,
  inventory: InventoryClip[],
  rejected: RejectedClip[],
) {
  await fs.writeFile(
    path.join(session.dir, "inventory.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total_duration_seconds: Number(
          inventory.reduce((sum, clip) => sum + clip.duration_seconds, 0).toFixed(3),
        ),
        clips: inventory,
        rejected_files: rejected,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeSelects(session: SessionState, result: SelectorResult) {
  await fs.writeFile(
    path.join(session.dir, "selects.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );
}

async function writeDirector(session: SessionState, result: DirectorResult) {
  await fs.writeFile(
    path.join(session.dir, "director.json"),
    JSON.stringify(
      { generated_at: new Date().toISOString(), ...result },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeEditorFiles(session: SessionState, result: EditorResult) {
  await fs.writeFile(
    path.join(session.dir, "edl.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );
  const header = [
    "edit_index",
    "clip_id",
    "filename",
    "source_start_sec",
    "source_end_sec",
    "duration_sec",
    "role",
    "action",
    "shot_size",
  ];
  const csvValue = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = result.edl.map((row) =>
    [
      row.edit_index,
      row.clip_id,
      row.filename,
      row.source_start_sec,
      row.source_end_sec,
      row.duration_sec,
      row.role,
      row.action,
      row.shot_size,
    ]
      .map(csvValue)
      .join(","),
  );
  await fs.writeFile(
    path.join(session.dir, "edl.csv"),
    [header.join(","), ...rows, ""].join("\n"),
    "utf8",
  );
}

async function clearGeneratedFiles(session: SessionState) {
  await Promise.all(
    [
      "director.json",
      "selects.json",
      "edl.json",
      "edl.csv",
      "roughcut.mp4",
      "roughcut_v1.mp4",
      "review.json",
    ].map(
      (file) => fs.rm(path.join(session.dir, file), { force: true }),
    ),
  );
  await fs.rm(path.join(session.dir, "render"), {
    recursive: true,
    force: true,
  });
}

function resetSelectorState(session: SessionState) {
  session.selectorStatus = "idle";
  session.selectorLog = [];
  session.selectorClips = [];
  session.moments = [];
  session.selects = undefined;
  session.selectorError = undefined;
}

function resetCreativeState(session: SessionState) {
  session.crewStatusAttempted = false;
  session.directorAttempted = false;
  session.crewStatus = undefined;
  session.crewStatusError = undefined;
  session.directorStatus = "idle";
  session.directorLog = [];
  session.directorIntent = undefined;
  session.directorsNote = undefined;
  session.directorError = undefined;
  session.editorStatus = "idle";
  session.editorLog = [];
  session.editorResult = undefined;
  session.editorError = undefined;
  session.assemblyStatus = "idle";
  session.assemblyLog = [];
  session.roughCut = undefined;
  session.assemblyError = undefined;
  session.reviewerStatus = "idle";
  session.reviewerLog = [];
  session.reviewerResult = undefined;
  session.reviewerError = undefined;
  session.reviewAttempted = false;
  session.appliedOrders = [];
  session.skippedOrders = [];
  session.cutVersion = 1;
  session.roughCutV1 = undefined;
  session.editorResultV1 = undefined;
  session.runFailure = undefined;
  resetSelectorState(session);
}

function directorLog(session: SessionState, message: string) {
  session.directorLog.push(`[DIRECTOR] ${message}`);
  if (session.directorLog.length > 40) session.directorLog.shift();
}

function selectorLog(session: SessionState, message: string) {
  session.selectorLog.push(`[SELECTOR] ${message}`);
  if (session.selectorLog.length > 100) session.selectorLog.shift();
}

function editorLog(session: SessionState, message: string) {
  session.editorLog.push(`[EDITOR] ${message}`);
  if (session.editorLog.length > 40) session.editorLog.shift();
}

function assemblyLog(session: SessionState, message: string) {
  session.assemblyLog.push(`[ASSEMBLY] ${message}`);
  if (session.assemblyLog.length > 40) session.assemblyLog.shift();
}

function reviewerLog(session: SessionState, message: string) {
  session.reviewerLog.push(`[REVIEWER] ${message}`);
  if (session.reviewerLog.length > 40) session.reviewerLog.shift();
}

function reviewerModulePath() {
  return pathToFileURL(path.join(workspaceRoot, "agents/reviewer.js")).href;
}

function assemblyModulePath() {
  return pathToFileURL(path.join(workspaceRoot, "agents/assembly.js")).href;
}

function selectorModulePath() {
  return pathToFileURL(path.join(workspaceRoot, "agents/selector.js")).href;
}

function directorModulePath() {
  return pathToFileURL(path.join(workspaceRoot, "agents/director.js")).href;
}

function editorModulePath() {
  return pathToFileURL(path.join(workspaceRoot, "agents/editor.js")).href;
}

async function startSelector(
  session: SessionState,
  directorIntent: Record<string, unknown>,
) {
  if (session.selectorStatus === "running") return;
  session.selectorStatus = "running";
  selectorLog(session, "selector started; clips will be analyzed sequentially");
  session.selectorClips = session.inventory.map((clip) => ({
    clip_id: clip.clip_id,
    filename: clip.filename,
    state: "queued",
    attempt: 0,
  }));

  try {
    const selector = (await import(selectorModulePath())) as {
      runSelector(args: {
        clips: Clip[];
        inventory: InventoryClip[];
        sessionDir: string;
        intent: Record<string, unknown>;
        onProgress: (progress: {
          clipId?: string;
          state: SelectorClipState["state"];
          attempt: number;
          message: string;
          moments?: number;
        }) => void;
      }): Promise<SelectorResult>;
    };
    const result = await selector.runSelector({
      clips: session.clips,
      inventory: session.inventory,
      sessionDir: session.dir,
      intent: directorIntent,
      onProgress: (progress) => {
        if (progress.clipId) {
          const clip = session.selectorClips.find(
            (item) => item.clip_id === progress.clipId,
          );
          if (clip) {
            clip.state = progress.state;
            clip.attempt = progress.attempt;
            clip.message = progress.message;
            clip.moments = progress.moments;
          }
        }
        selectorLog(session, progress.message);
      },
    });
    session.selects = result;
    session.moments = result.moments;
    session.selectorStatus = result.partial ? "error" : "complete";
    session.status = result.partial ? "error" : "assembling";
    session.selectorError = result.partial
      ? "Some clips could not be analyzed."
      : undefined;
    selectorLog(
      session,
      result.partial
        ? `selector finished with ${result.errors.length} clip error(s)`
        : `selector complete; ${result.moments.length} moments in inventory`,
    );
    await writeSelects(session, result);
    if (result.partial) {
      editorLog(session, "editor skipped because the selector had clip errors");
      failRun(
        session,
        "selector",
        statusFromMessages(result.errors),
        selectorLog,
      );
      return;
    }
    // The selector drops dead shots on the floor, so zero moments means the
    // footage held nothing worth cutting. That is an answer, not a crash.
    if (result.moments.length === 0) {
      session.status = "error";
      session.runFailure = {
        stage: "selector",
        message:
          "The crew watched every clip and could not find a single usable moment. Every shot read as a dead shot: static frames, black, or nothing happening on camera. Try footage with visible action in it, or press Retry with a different brief.",
        retryable: true,
      };
      selectorLog(
        session,
        "no usable moments in this footage; every shot read as a dead shot",
      );
      editorLog(session, "editor skipped; there is nothing to cut");
      return;
    }
    await startEditor(session);
  } catch (error) {
    session.selectorStatus = "error";
    session.selectorError = "The selector could not complete.";
    selectorLog(session, "selector stopped unexpectedly");
    failRun(session, "selector", statusFromError(error), selectorLog);
    const result: SelectorResult = {
      generated_at: new Date().toISOString(),
      intent: {},
      clips: [],
      moments: [],
      errors: ["The selector could not complete."],
      partial: true,
    };
    session.selects = result;
    await writeSelects(session, result).catch(() => {});
    console.error("CUTROOM selector failed", error);
  }
}

async function startAssembly(session: SessionState) {
  if (session.assemblyStatus === "running") {
    return { started: false, busy: true } as const;
  }
  if (!session.editorResult || session.editorResult.edl.length === 0) {
    return { started: false, busy: false } as const;
  }
  session.assemblyStatus = "running";
  session.assemblyError = undefined;
  session.roughCut = undefined;
  try {
    const assembly = (await import(assemblyModulePath())) as {
      runAssembly(args: {
        edl: EditorResult["edl"];
        clips: Clip[];
        sessionDir: string;
        onLog: (message: string) => void;
      }): Promise<RoughCut>;
    };
    const roughCut = await assembly.runAssembly({
      edl: session.editorResult.edl,
      clips: session.clips,
      sessionDir: session.dir,
      onLog: (message) => assemblyLog(session, message),
    });
    session.roughCut = roughCut;
    session.assemblyStatus = "complete";
    session.status = "completed";
    if (!session.reviewAttempted) {
      await startReviewer(session);
    }
  } catch (error) {
    session.assemblyStatus = "error";
    session.status = "error";
    session.assemblyError =
      error instanceof Error
        ? error.message
        : "The rough cut could not be rendered.";
    assemblyLog(session, session.assemblyError);
    session.runFailure = {
      stage: "assembly",
      message: `Sorry about this. The render stopped before the cut was finished: ${session.assemblyError} The EDL above is still yours. Press Retry to send the same footage and brief back in.`,
      retryable: true,
    };
    console.error("CUTROOM assembly failed", error);
  }
  return { started: true, busy: false } as const;
}

async function writeReview(session: SessionState) {
  if (!session.reviewerResult) return;
  await fs.writeFile(
    path.join(session.dir, "review.json"),
    JSON.stringify(
      {
        ...session.reviewerResult,
        cut_version: session.cutVersion,
        applied_orders: session.appliedOrders,
        skipped_orders: session.skippedOrders,
      },
      null,
      2,
    ),
    "utf8",
  );
}

// There is exactly one improvement pass. reviewAttempted is set before the
// second render so the reviewer can never be re-entered from startAssembly.
async function startReviewer(session: SessionState) {
  if (session.reviewAttempted || session.reviewerStatus === "running") return;
  if (!session.roughCut || !session.editorResult) return;
  session.reviewAttempted = true;
  session.reviewerStatus = "running";
  session.reviewerError = undefined;
  reviewerLog(session, "reviewer started; watching the assembled cut");
  try {
    const reviewer = (await import(reviewerModulePath())) as {
      runReviewer(args: {
        roughCutPath: string;
        intent: Record<string, unknown>;
        editorResult: EditorResult;
        roughCut: RoughCut;
        sessionId: string;
        onLog: (message: string) => void;
      }): Promise<ReviewerResult>;
      applyOrders(args: {
        edl: EditorResult["edl"];
        orders: Array<Record<string, unknown>>;
        benched: EditorResult["unused_strong_moments"];
        inventory: InventoryClip[];
      }): {
        ok: boolean;
        errors: string[];
        applied: AppliedOrder[];
        skipped: string[];
        edl: EditorResult["edl"];
        total_duration_sec: number;
      };
    };
    const review = await reviewer.runReviewer({
      roughCutPath: session.roughCut.path,
      intent: session.directorIntent || {},
      editorResult: session.editorResult,
      roughCut: session.roughCut,
      sessionId: session.id,
      onLog: (message) => reviewerLog(session, message),
    });
    session.reviewerResult = review;
    reviewerLog(
      session,
      `verdict: ${review.verdict === "ship" ? "SHIP" : "ONE PASS"}`,
    );
    reviewerLog(session, review.reviewers_note);

    if (review.verdict === "ship") {
      session.reviewerStatus = "complete";
      session.status = "completed";
      await writeReview(session);
      return;
    }

    const outcome = reviewer.applyOrders({
      edl: session.editorResult.edl,
      orders: review.orders,
      benched: session.editorResult.unused_strong_moments,
      inventory: session.inventory,
    });
    outcome.skipped.forEach((message) => reviewerLog(session, `skipped ${message}`));
    session.skippedOrders = outcome.skipped;
    if (!outcome.ok) {
      outcome.errors.forEach((message) => reviewerLog(session, `skipped ${message}`));
      reviewerLog(
        session,
        "no order survived validation; the first cut stands as delivered",
      );
      session.reviewerStatus = "complete";
      session.status = "completed";
      await writeReview(session);
      return;
    }

    const previousCut = session.roughCut;
    const previousEditorResult = session.editorResult;
    const v1Path = path.join(session.dir, "roughcut_v1.mp4");
    await fs.copyFile(previousCut.path, v1Path);
    session.roughCutV1 = { ...previousCut, filename: "roughcut_v1.mp4", path: v1Path };
    session.editorResultV1 = previousEditorResult;
    session.appliedOrders = outcome.applied;
    session.editorResult = {
      ...previousEditorResult,
      total_duration_sec: outcome.total_duration_sec,
      edl: outcome.edl,
    };
    await writeEditorFiles(session, session.editorResult);
    reviewerLog(
      session,
      `applying ${outcome.applied.length} ${
        outcome.applied.length === 1 ? "order" : "orders"
      }; re-cutting once`,
    );
    await startAssembly(session);
    if (session.assemblyStatus === "complete") {
      session.cutVersion = 2;
      session.reviewerStatus = "complete";
      session.status = "completed";
      reviewerLog(session, "cut v2 is on the bench; v1 is still downloadable");
    } else {
      session.editorResult = previousEditorResult;
      session.roughCut = previousCut;
      session.roughCutV1 = undefined;
      session.editorResultV1 = undefined;
      session.appliedOrders = [];
      await fs.copyFile(v1Path, previousCut.path).catch(() => {});
      await fs.rm(v1Path, { force: true });
      await writeEditorFiles(session, previousEditorResult).catch(() => {});
      session.assemblyStatus = "complete";
      session.reviewerStatus = "complete";
      session.status = "completed";
      session.runFailure = undefined;
      reviewerLog(
        session,
        "the second render failed; the first cut stands as delivered",
      );
    }
    await writeReview(session);
  } catch (error) {
    session.reviewerStatus = "error";
    session.reviewerError = "The reviewer could not watch this cut.";
    reviewerLog(session, session.reviewerError);
    console.error("CUTROOM reviewer failed", error);
  }
}

async function startEditor(session: SessionState) {
  if (session.editorStatus === "running" || session.editorStatus === "complete") {
    return;
  }
  session.editorStatus = "running";
  editorLog(session, "editor started; shaping the selected moments");
  try {
    const editor = (await import(editorModulePath())) as {
      runEditor(args: {
        intent: Record<string, unknown>;
        selects: SelectorResult;
        inventory: InventoryClip[];
        sessionId: string;
      }): Promise<EditorResult>;
    };
    const result = await editor.runEditor({
      intent: session.directorIntent || {},
      selects: session.selects || {
        generated_at: new Date().toISOString(),
        intent: {},
        clips: [],
        moments: [],
        errors: [],
        partial: false,
      },
      inventory: session.inventory,
      sessionId: session.id,
    });
    session.editorResult = result;
    session.editorStatus = "complete";
    editorLog(
      session,
      `editor complete; ${result.edl.length} edits / ${result.total_duration_sec}s`,
    );
    await writeEditorFiles(session, result);
    await startAssembly(session);
    if (session.assemblyStatus === "idle") {
      session.status = "completed";
    }
  } catch (error) {
    session.editorStatus = "error";
    session.editorError =
      error instanceof Error ? error.message : "The editor could not complete.";
    editorLog(session, session.editorError);
    failRun(session, "editor", statusFromError(error), editorLog);
    console.error("CUTROOM editor failed", error);
  }
}

async function startCreativePipeline(session: SessionState) {
  if (
    session.directorAttempted ||
    session.directorStatus === "running" ||
    session.directorStatus === "complete"
  ) {
    return;
  }
  session.directorAttempted = true;
  session.directorStatus = "running";
  directorLog(session, "director started; interpreting the brief");
  try {
    const director = (await import(directorModulePath())) as {
      runDirector(args: {
        brief: string;
        preset: string;
        sessionId: string;
        inventory: InventoryClip[];
      }): Promise<DirectorResult>;
    };
    const result = await director.runDirector({
      brief: session.brief,
      preset: session.preset,
      sessionId: session.id,
      inventory: session.inventory,
    });
    session.directorIntent = result.intent;
    session.directorsNote =
      typeof result.intent.directors_note === "string"
        ? result.intent.directors_note
        : undefined;
    session.directorStatus = "complete";
    directorLog(
      session,
      session.directorsNote || "intent locked; passing the brief to the selector",
    );
    await writeDirector(session, result);
    await startSelector(session, result.intent);
  } catch (error) {
    session.directorStatus = "error";
    session.directorError = "The director could not interpret this brief.";
    directorLog(session, session.directorError);
    failRun(session, "director", statusFromError(error), directorLog);
    console.error("CUTROOM director failed", error);
  }
}

// Gemini errors reach the route layer either as an Error carrying a numeric
// status (the lib/gemini.js wrapper sets it) or, from the selector, as a
// per-clip string shaped "ApiError/429". Both shapes are read here so a quota
// wall and a 5xx wave get their own apology instead of a white screen.
function statusFromError(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; code?: unknown } | undefined;
  const value = [candidate?.status, candidate?.code]
    .map(Number)
    .find((entry) => Number.isFinite(entry) && entry >= 100 && entry <= 599);
  if (value !== undefined) return value;
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = text.match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function statusFromMessages(messages: string[]): number | undefined {
  for (const message of messages) {
    const match = message.match(/\/(4\d\d|5\d\d)\b/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function apologyFor(stage: string, status: number | undefined): string {
  const where = `The ${stage} was mid-run when it stopped.`;
  if (status === 429) {
    return `Sorry about this. ${where} Gemini turned the crew away at the door: the API key is out of quota for now. Nothing is wrong with your footage. Wait a few minutes and press Retry, or set a fresh GEMINI_API_KEY and try again.`;
  }
  if (status !== undefined && status >= 500) {
    return `Sorry about this. ${where} Gemini answered with a ${status}, which is a problem on the model's side, not with your footage. The crew waited it out and it did not clear. Press Retry to send the same footage and brief back in.`;
  }
  if (status === 403 || status === 401) {
    return `Sorry about this. ${where} Gemini refused the API key (${status}). Set a valid GEMINI_API_KEY, then press Retry.`;
  }
  return `Sorry about this. ${where} The crew could not finish and stopped rather than hand you a broken cut. Press Retry to send the same footage and brief back in.`;
}

function failRun(
  session: SessionState,
  stage: string,
  status: number | undefined,
  log: (session: SessionState, message: string) => void,
) {
  const message = apologyFor(stage, status);
  session.runFailure = { stage, message, retryable: true };
  session.status = "error";
  log(session, message);
  return message;
}

function rejectedMessages(rejected: RejectedClip[]) {
  return rejected.map((item) => `${item.name}: ${item.reason}`);
}

router.use(async (req: SessionRequest, res, next) => {
  try {
    const session = getSession(req, res);
    session.lastTouchedAt = Date.now();
    await fs.mkdir(session.dir, { recursive: true });
    await fs.mkdir(SAMPLE_DIR, { recursive: true });
    next();
  } catch (error) {
    next(error);
  }
});

const storage = multer.diskStorage({
  destination: (req: SessionRequest, _file, callback) => {
    const session = req.cutroomSession;
    if (!session) {
      callback(new Error("Session was not initialized"), "");
      return;
    }
    callback(null, session.dir);
  },
  filename: (_req, file, callback) => {
    callback(null, `${crypto.randomUUID()}-${safeName(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { files: MAX_FILES, fileSize: MAX_TOTAL_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!isVideoFile(file.originalname)) {
      callback(
        new Error(
          `${safeName(file.originalname)} is not a .mp4 or .mov file. Only .mp4 and .mov footage is accepted.`,
        ),
      );
      return;
    }
    const mimeType = (file.mimetype || "").toLowerCase().split(";")[0].trim();
    if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
      callback(
        new Error(
          `${safeName(file.originalname)} arrived as ${mimeType}, which is not video. Only .mp4 and .mov footage is accepted.`,
        ),
      );
      return;
    }
    callback(null, true);
  },
});

router.get("/session", (req: SessionRequest, res) => {
  res.json(serializeSession(getSession(req, res)));
});

router.get("/session/edl.json", sendEdlJson);

router.get("/session/edl.csv", sendEdlCsv);

// The router-level middleware resolves the session before path parameters
// exist, so download routes shaped /session/:sessionId/<file> have to look the
// session up again from the parameter.
function sessionFromRoute(req: SessionRequest, res: Response): SessionState {
  const routeId = req.params?.sessionId;
  const routed = typeof routeId === "string" ? sessions.get(routeId) : undefined;
  return routed ?? getSession(req, res);
}

async function sendRoughCut(
  req: SessionRequest,
  res: Response,
  next: (error?: unknown) => void,
) {
  try {
    const session = sessionFromRoute(req, res);
    const filePath = path.join(session.dir, "roughcut.mp4");
    await fs.access(filePath);
    res.type("video/mp4");
    res.set("Accept-Ranges", "bytes");
    return res.sendFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return errorResponse(res, 404, "The rough cut is not ready yet.");
    }
    return next(error);
  }
}

async function sendRoughCutV1(
  req: SessionRequest,
  res: Response,
  next: (error?: unknown) => void,
) {
  try {
    const session = sessionFromRoute(req, res);
    const filePath = path.join(session.dir, "roughcut_v1.mp4");
    await fs.access(filePath);
    res.type("video/mp4");
    res.set("Accept-Ranges", "bytes");
    return res.sendFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return errorResponse(res, 404, "There is no first cut to download.");
    }
    return next(error);
  }
}

async function sendEdlJson(
  req: SessionRequest,
  res: Response,
  next: (error?: unknown) => void,
) {
  try {
    const session = sessionFromRoute(req, res);
    const contents = await fs.readFile(path.join(session.dir, "edl.json"), "utf8");
    return res
      .type("application/json")
      .set("Content-Disposition", 'attachment; filename="edl.json"')
      .send(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return errorResponse(res, 404, "The EDL is not ready yet.");
    }
    return next(error);
  }
}

async function sendEdlCsv(
  req: SessionRequest,
  res: Response,
  next: (error?: unknown) => void,
) {
  try {
    const session = sessionFromRoute(req, res);
    const contents = await fs.readFile(path.join(session.dir, "edl.csv"), "utf8");
    return res
      .type("text/csv")
      .set("Content-Disposition", 'attachment; filename="edl.csv"')
      .send(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return errorResponse(res, 404, "The EDL is not ready yet.");
    }
    return next(error);
  }
}

router.get("/session/roughcut.mp4", sendRoughCut);
router.get("/session/roughcut_v1.mp4", sendRoughCutV1);
router.get("/session/:sessionId/roughcut_v1.mp4", sendRoughCutV1);
router.get("/session/:sessionId/roughcut.mp4", sendRoughCut);
router.get("/session/:sessionId/edl.json", sendEdlJson);
router.get("/session/:sessionId/edl.csv", sendEdlCsv);

router.post("/session/render", async (req: SessionRequest, res, next) => {
  try {
    const session = getSession(req, res);
    if (session.assemblyStatus === "running") {
      return errorResponse(res, 409, "The crew is mid-cut. Give it a moment.");
    }
    if (!session.editorResult || session.editorResult.edl.length === 0) {
      return errorResponse(res, 400, "There is no EDL to render yet.");
    }
    void startAssembly(session);
    return res.json(serializeSession(session));
  } catch (error) {
    return next(error);
  }
});

router.post("/session/clips", (req: SessionRequest, res, next) => {
  upload.array("clips", MAX_FILES)(req, res, async (uploadError) => {
    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === "LIMIT_FILE_SIZE") {
        return errorResponse(
          res,
          413,
          "That file is larger than the 200MB session limit.",
        );
      }
      if (uploadError.code === "LIMIT_FILE_COUNT") {
        return errorResponse(res, 400, "A session can contain up to 10 clips.");
      }
      return errorResponse(res, 400, "The footage could not be added.");
    }
    if (uploadError instanceof Error) {
      return errorResponse(res, 400, uploadError.message);
    }
    if (uploadError) return next(uploadError);

    const session = getSession(req, res);
    const files = (req.files ?? []) as Express.Multer.File[];
    const currentBytes = session.clips.reduce(
      (sum, clip) => sum + clip.size,
      0,
    );
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);

    if (session.clips.length + files.length > MAX_FILES) {
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
      return errorResponse(res, 400, "A session can contain up to 10 clips.");
    }
    if (currentBytes + incomingBytes > MAX_TOTAL_BYTES) {
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
      return errorResponse(
        res,
        413,
        "That would put the session over the 200MB total limit.",
      );
    }

    const incomingClips: Clip[] = files.map((file) => ({
      name: safeName(file.originalname),
      size: file.size,
      source: "upload" as const,
      fileName: file.filename,
      storedPath: file.path,
    }));
    const inventoryRun = await buildInventory([...session.clips, ...incomingClips]);
    const rejected = inventoryRun.rejected.map((item) => item.error);

    if (inventoryRun.accepted.length === 0) {
      await Promise.all(
        incomingClips.map((clip) => fs.rm(clip.storedPath, { force: true })),
      );
      return res.status(422).json({
        error: "None of the uploaded clips could be read. Check the video files and try again.",
        invalidFiles: rejectedMessages(rejected),
      });
    }

    if (inventoryRun.totalRuntimeSeconds > MAX_RUNTIME_SECONDS) {
      await Promise.all(
        incomingClips.map((clip) => fs.rm(clip.storedPath, { force: true })),
      );
      return res.status(422).json({
        error: "That footage would put this session over the 30-minute runtime limit. Remove a clip and try again.",
        totalRuntimeSeconds: inventoryRun.totalRuntimeSeconds,
      });
    }

    await Promise.all(
      inventoryRun.rejected.map((item) =>
        fs.rm(item.clip.storedPath, { force: true }),
      ),
    );
    session.clips = inventoryRun.accepted.map((item) => item.clip);
    session.inventory = inventoryRun.accepted.map((item) => item.inventory);
    session.inventoryErrors = rejectedMessages(rejected);
    session.totalRuntimeSeconds = inventoryRun.totalRuntimeSeconds;
    session.status = "intake";
    resetCreativeState(session);
    await clearGeneratedFiles(session);
    await writeInventory(session, session.inventory, rejected);
    return res.json(serializeSession(session));
  });
});

router.post("/session/sample", async (req: SessionRequest, res, next) => {
  try {
    const session = getSession(req, res);
    const entries = await fs.readdir(SAMPLE_DIR, { withFileTypes: true });
    const sampleFiles = entries.filter(
      (entry) => entry.isFile() && isVideoFile(entry.name),
    );

    if (sampleFiles.length === 0) {
      return errorResponse(
        res,
        404,
        "No sample footage is available yet. Add .mp4 or .mov files to sample_clips.",
      );
    }
    if (sampleFiles.length > MAX_FILES) {
      return errorResponse(
        res,
        400,
        "The sample reel contains more than 10 clips.",
      );
    }

    const stagingDir = path.join(
      TEMP_DIR,
      `${session.id}-sample-${crypto.randomUUID()}`,
    );
    await fs.mkdir(stagingDir, { recursive: true });
    const samples: Clip[] = [];
    for (const entry of sampleFiles) {
      const sourcePath = path.join(SAMPLE_DIR, entry.name);
      const stat = await fs.stat(sourcePath);
      const fileName = `${crypto.randomUUID()}-${safeName(entry.name)}`;
      const storedPath = path.join(stagingDir, fileName);
      await fs.copyFile(sourcePath, storedPath);
      samples.push({
        name: safeName(entry.name),
        size: stat.size,
        source: "sample",
        fileName,
        storedPath,
      });
    }

    const totalBytes = samples.reduce((sum, clip) => sum + clip.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      return errorResponse(
        res,
        413,
        "The sample footage is over the 200MB total limit.",
      );
    }

    const inventoryRun = await buildInventory(samples);
    const rejected = inventoryRun.rejected.map((item) => item.error);

    if (inventoryRun.accepted.length === 0) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      return res.status(422).json({
        error: "None of the sample clips could be read. Check the video files and try again.",
        invalidFiles: rejectedMessages(rejected),
      });
    }
    if (inventoryRun.totalRuntimeSeconds > MAX_RUNTIME_SECONDS) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      return res.status(422).json({
        error: "That sample footage would put this session over the 30-minute runtime limit. Remove a clip and try again.",
        totalRuntimeSeconds: inventoryRun.totalRuntimeSeconds,
      });
    }

    await fs.rm(session.dir, { recursive: true, force: true });
    await fs.mkdir(session.dir, { recursive: true });
    const acceptedClips: Clip[] = [];
    for (const item of inventoryRun.accepted) {
      const fileName = `${crypto.randomUUID()}-${item.clip.name}`;
      const storedPath = path.join(session.dir, fileName);
      await fs.copyFile(item.clip.storedPath, storedPath);
      acceptedClips.push({ ...item.clip, fileName, storedPath });
    }
    await fs.rm(stagingDir, { recursive: true, force: true });
    session.clips = acceptedClips;
    session.inventory = inventoryRun.accepted.map((item) => item.inventory);
    session.inventoryErrors = rejectedMessages(rejected);
    session.totalRuntimeSeconds = inventoryRun.totalRuntimeSeconds;
    session.status = "intake";
    resetCreativeState(session);
    await clearGeneratedFiles(session);
    await writeInventory(session, session.inventory, rejected);
    return res.json(serializeSession(session));
  } catch (error) {
    return next(error);
  }
});

router.post("/session/brief", async (req: SessionRequest, res) => {
  const session = getSession(req, res);
  if (session.clips.length === 0) {
    return errorResponse(res, 400, "Add footage before sending a brief.");
  }

  const requestedBrief =
    typeof req.body?.brief === "string" ? req.body.brief.trim() : "";
  const preset =
    typeof req.body?.preset === "string" ? req.body.preset.trim() : "";
  // An empty brief is a valid brief. The crew takes the house default and the
  // director log tells the user exactly what it is cutting to.
  const briefDefaulted = !requestedBrief && !preset;
  const brief = briefDefaulted ? DEFAULT_BRIEF : requestedBrief;
  if (
    session.directorAttempted ||
    session.selectorStatus === "running" ||
    session.selectorStatus === "complete" ||
    session.editorStatus === "running" ||
    session.editorStatus === "complete"
  ) {
    return res.json(serializeSession(session));
  }

  session.brief = brief;
  session.preset = preset;
  session.status = "assembling";
  resetCreativeState(session);
  session.briefDefaulted = briefDefaulted;
  session.lastTouchedAt = Date.now();
  await clearGeneratedFiles(session);
  if (briefDefaulted) {
    directorLog(
      session,
      `no brief was given, so the crew is working to the house default: ${DEFAULT_BRIEF}`,
    );
  }
  if (!session.crewStatusAttempted) {
    session.crewStatusAttempted = true;
    try {
      const result = await generateJSON(
        "You are the CUTROOM film crew warming up before a rough cut. Return one cinematic sentence about the crew warming up.",
        `The editor's brief is: ${brief || preset}.`,
        {
          type: "object",
          properties: { crew_status: { type: "string" } },
          required: ["crew_status"],
        },
      );
      if (
        !result ||
        typeof result.crew_status !== "string" ||
        !result.crew_status.trim()
      ) {
        throw new Error("Gemini returned no crew status.");
      }
      session.crewStatus = result.crew_status.trim();
    } catch {
      session.crewStatusError = "Gemini crew status is unavailable.";
    }
  }
  void startCreativePipeline(session);
  return res.json(serializeSession(session));
});

// Retry re-runs the creative pipeline on the footage and brief already in the
// session. It exists so a quota wall or a 5xx wave costs the user one click
// instead of a re-upload.
router.post("/session/retry", async (req: SessionRequest, res, next) => {
  try {
    const session = getSession(req, res);
    if (session.clips.length === 0) {
      return errorResponse(res, 400, "Add footage before retrying.");
    }
    if (!session.brief && !session.preset) {
      return errorResponse(res, 400, "Send a brief before retrying.");
    }
    if (
      session.directorStatus === "running" ||
      session.selectorStatus === "running" ||
      session.editorStatus === "running" ||
      session.assemblyStatus === "running"
    ) {
      return errorResponse(res, 409, "The crew is still working. Give it a moment.");
    }
    const briefDefaulted = session.briefDefaulted;
    resetCreativeState(session);
    session.briefDefaulted = briefDefaulted;
    session.status = "assembling";
    session.lastTouchedAt = Date.now();
    await clearGeneratedFiles(session);
    if (briefDefaulted) {
      directorLog(
        session,
        `no brief was given, so the crew is working to the house default: ${DEFAULT_BRIEF}`,
      );
    }
    directorLog(session, "retrying this session with the same footage and brief");
    void startCreativePipeline(session);
    return res.json(serializeSession(session));
  } catch (error) {
    return next(error);
  }
});

router.post("/session/reset", async (req: SessionRequest, res, next) => {
  try {
    const active = getSession(req, res);
    await fs.rm(active.dir, { recursive: true, force: true });
    sessions.delete(active.id);
    res.clearCookie(SESSION_COOKIE);
    req.cutroomSession = undefined;
    const fresh = getSession(req, res);
    await fs.mkdir(fresh.dir, { recursive: true });
    return res.json(serializeSession(fresh));
  } catch (error) {
    return next(error);
  }
});

export default router;

// Sessions are temporary by design. Every hour, any temp directory whose last
// write is older than the 24h TTL is removed along with its in-memory state, so
// a long-lived deployment never accumulates footage. unref keeps the timer from
// holding the process open.
async function sweepExpiredSessions(now = Date.now()) {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(TEMP_DIR);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const dir = path.join(TEMP_DIR, entry);
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) continue;
      if (now - stats.mtimeMs < SESSION_TTL_MS) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  for (const [id, session] of sessions) {
    if (now - session.lastTouchedAt >= SESSION_TTL_MS) sessions.delete(id);
  }
  return removed;
}

const sessionSweeper = setInterval(() => {
  void sweepExpiredSessions();
}, SESSION_SWEEP_MS);
sessionSweeper.unref();
void sweepExpiredSessions();

export { sweepExpiredSessions };
