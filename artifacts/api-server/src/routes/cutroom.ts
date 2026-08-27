import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Router, type Request, type Response } from "express";
import multer from "multer";

const router = Router();
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_RUNTIME_SECONDS = 30 * 60;
const LONG_CLIP_SECONDS = 5 * 60;
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

interface SessionState {
  id: string;
  dir: string;
  clips: Clip[];
  brief: string;
  preset: string;
  status: "intake" | "assembling";
  inventory: InventoryClip[];
  inventoryErrors: string[];
  totalRuntimeSeconds: number;
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

function rejectedMessages(rejected: RejectedClip[]) {
  return rejected.map((item) => `${item.name}: ${item.reason}`);
}

router.use(async (req: SessionRequest, res, next) => {
  try {
    const session = getSession(req, res);
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
      callback(new Error("Only .mp4 and .mov files are accepted."));
      return;
    }
    callback(null, true);
  },
});

router.get("/session", (req: SessionRequest, res) => {
  res.json(serializeSession(getSession(req, res)));
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
    await writeInventory(session, session.inventory, rejected);
    return res.json(serializeSession(session));
  } catch (error) {
    return next(error);
  }
});

router.post("/session/brief", (req: SessionRequest, res) => {
  const session = getSession(req, res);
  if (session.clips.length === 0) {
    return errorResponse(res, 400, "Add footage before sending a brief.");
  }

  const brief = typeof req.body?.brief === "string" ? req.body.brief.trim() : "";
  const preset =
    typeof req.body?.preset === "string" ? req.body.preset.trim() : "";
  if (!brief && !preset) {
    return errorResponse(
      res,
      400,
      "Tell the crew what you want, or choose a preset.",
    );
  }

  session.brief = brief;
  session.preset = preset;
  session.status = "assembling";
  return res.json(serializeSession(session));
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