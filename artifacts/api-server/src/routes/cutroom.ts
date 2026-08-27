import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Router, type Request, type Response } from "express";
import multer from "multer";

const router = Router();
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const SESSION_COOKIE = "cutroom_session";
const TEMP_DIR = path.resolve(process.cwd(), "artifacts/api-server/tmp-sessions");
const SAMPLE_DIR = path.resolve(process.cwd(), "sample_clips");
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov"]);

type ClipSource = "upload" | "sample";

interface Clip {
  name: string;
  size: number;
  source: ClipSource;
}

interface SessionState {
  id: string;
  dir: string;
  clips: Clip[];
  brief: string;
  preset: string;
  status: "intake" | "assembling";
}

interface SessionRequest extends Request {
  cutroomSession?: SessionState;
}

const sessions = new Map<string, SessionState>();

function createSession(): SessionState {
  const id = crypto.randomUUID();
  const session: SessionState = {
    id,
    dir: path.join(TEMP_DIR, id),
    clips: [],
    brief: "",
    preset: "",
    status: "intake",
  };
  sessions.set(id, session);
  return session;
}

function getSession(req: SessionRequest, res: Response): SessionState {
  if (req.cutroomSession) return req.cutroomSession;

  const cookieId =
    typeof req.cookies?.[SESSION_COOKIE] === "string"
      ? req.cookies[SESSION_COOKIE]
      : undefined;
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
    clips: session.clips,
    clipCount: session.clips.length,
    totalBytes: session.clips.reduce((sum, clip) => sum + clip.size, 0),
    brief: session.brief,
    preset: session.preset,
    status: session.status,
  };
}

function errorResponse(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
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

    session.clips.push(
      ...files.map((file) => ({
        name: safeName(file.originalname),
        size: file.size,
        source: "upload" as const,
      })),
    );
    session.status = "intake";
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

    const samples: Array<Clip & { sourcePath: string }> = [];
    for (const entry of sampleFiles) {
      const sourcePath = path.join(SAMPLE_DIR, entry.name);
      const stat = await fs.stat(sourcePath);
      samples.push({
        name: safeName(entry.name),
        size: stat.size,
        source: "sample",
        sourcePath,
      });
    }

    const totalBytes = samples.reduce((sum, clip) => sum + clip.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return errorResponse(
        res,
        413,
        "The sample footage is over the 200MB total limit.",
      );
    }

    await fs.rm(session.dir, { recursive: true, force: true });
    await fs.mkdir(session.dir, { recursive: true });
    await Promise.all(
      samples.map((clip) =>
        fs.copyFile(
          clip.sourcePath,
          path.join(session.dir, `${crypto.randomUUID()}-${clip.name}`),
        ),
      ),
    );
    session.clips = samples.map(({ sourcePath: _sourcePath, ...clip }) => clip);
    session.status = "intake";
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