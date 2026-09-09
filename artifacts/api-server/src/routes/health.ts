import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Router, type IRouter } from "express";
import {
  getGeminiHealth,
  getGeminiHealthCached,
  getGeminiKeyPoolStatus,
  getGeminiModels,
} from "../lib/gemini.js";
import { TEMP_DIR, workspaceRoot } from "../lib/paths";

type GeminiModule = typeof import("../lib/gemini.js");

// The agents (director, selector, editor, reviewer) import lib/gemini.js from SOURCE at
// runtime, while this bundled server holds its own copy of the module. Key cooldowns and
// the upload cache live in the agents' instance, so the health route reads the pool from
// there; the bundled copy only serves the crew warm-up line and /healthz.
async function agentGemini(): Promise<GeminiModule> {
  try {
    const url = pathToFileURL(
      path.join(workspaceRoot, "artifacts/api-server/src/lib/gemini.js"),
    ).href;
    return (await import(url)) as GeminiModule;
  } catch {
    return {
      getGeminiHealth,
      getGeminiHealthCached,
      getGeminiKeyPoolStatus,
      getGeminiModels,
    } as GeminiModule;
  }
}

const execFileAsync = promisify(execFile);
const router: IRouter = Router();
const startedAt = Date.now();
const TOOL_CACHE_MS = 5 * 60 * 1000;

interface ToolStatus {
  present: boolean;
  version: string | null;
}

let toolCache: { checkedAt: number; ffmpeg: ToolStatus; ffprobe: ToolStatus } | undefined;

async function probeTool(name: string): Promise<ToolStatus> {
  try {
    const { stdout } = await execFileAsync(name, ["-version"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const firstLine = String(stdout).split("\n")[0] || "";
    const match = firstLine.match(/version\s+(\S+)/i);
    return { present: true, version: match ? match[1] : firstLine.trim() || null };
  } catch {
    return { present: false, version: null };
  }
}

async function tools() {
  if (toolCache && Date.now() - toolCache.checkedAt < TOOL_CACHE_MS) return toolCache;
  const [ffmpeg, ffprobe] = await Promise.all([probeTool("ffmpeg"), probeTool("ffprobe")]);
  toolCache = { checkedAt: Date.now(), ffmpeg, ffprobe };
  return toolCache;
}

async function directorySize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(full);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await fs.stat(full)).size;
        files += 1;
      } catch {
        // A file swept between readdir and stat is not an error.
      }
    }
  }
  return { bytes, files };
}

async function tempUsage() {
  let sessions = 0;
  try {
    const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true });
    sessions = entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    sessions = 0;
  }
  const { bytes, files } = await directorySize(TEMP_DIR);
  let freeBytes: number | null = null;
  try {
    const stats = await fs.statfs(path.dirname(TEMP_DIR));
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    freeBytes = null;
  }
  return {
    sessions,
    files,
    bytes,
    megabytes: Number((bytes / (1024 * 1024)).toFixed(1)),
    diskFreeMegabytes:
      freeBytes === null ? null : Number((freeBytes / (1024 * 1024)).toFixed(0)),
  };
}

// Kept as is: a live model probe, cached for 60 seconds inside the gemini module.
router.get("/healthz", async (_req, res) => {
  const gemini = await getGeminiHealth();
  res.json({ status: "ok", gemini });
});

// PRE-JUDGING PASS 2026-09-09. A cold check for a judge or for Ryan: what models the crew
// is using, how big the key pool is (counts and positions only, never a key value), whether
// ffmpeg and ffprobe are on the box, and how much temp space the sessions are holding.
// It does NOT fire a model call by itself, so polling it during judging spends no quota;
// add ?probe=1 to run one live probe (cached 60s).
router.get("/health", async (req, res) => {
  const probe = req.query.probe === "1" || req.query.probe === "true";
  const [toolStatus, temp, agents] = await Promise.all([
    tools(),
    tempUsage(),
    agentGemini(),
  ]);
  const gemini = probe
    ? { status: await agents.getGeminiHealth(), ageSec: 0 }
    : agents.getGeminiHealthCached();
  const keyPool = agents.getGeminiKeyPoolStatus();
  const problems: string[] = [];
  if (keyPool.size === 0) problems.push("no Gemini key in GEMINI_API_KEYS");
  if (!toolStatus.ffmpeg.present) problems.push("ffmpeg missing");
  if (!toolStatus.ffprobe.present) problems.push("ffprobe missing");
  if (gemini.status === "error") problems.push("last Gemini probe failed");
  res.json({
    status: problems.length === 0 ? "ok" : "degraded",
    problems,
    service: "cutroom",
    checkedAt: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    models: agents.getGeminiModels(),
    keyPool,
    gemini,
    ffmpeg: toolStatus.ffmpeg,
    ffprobe: toolStatus.ffprobe,
    temp,
    render: {
      maxHeight: Number(process.env.CUTROOM_RENDER_MAX_HEIGHT) || 1080,
      timeoutMs: Number(process.env.CUTROOM_RENDER_TIMEOUT_MS) || 600000,
      fps: 24,
    },
    reviewMaxAttempts: Number(process.env.CUTROOM_REVIEW_MAX_ATTEMPTS) || 20,
    selectorParallelUploads: process.env.CUTROOM_SELECTOR_PARALLEL_UPLOADS !== "0",
  });
});

export default router;
