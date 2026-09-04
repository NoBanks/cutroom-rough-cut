import { GoogleGenAI } from "@google/genai";
import path from "node:path";

// Model choice lives here and only here. Override without a code edit via env.
// PRIMARY is the fastest current flash; FALLBACK is a lite variant on purpose, so that
// if the flagship's daily ceiling is reached the app degrades to a slower model that
// still works instead of dying.
const PRIMARY_MODEL = process.env.CUTROOM_MODEL_PRIMARY || "gemini-3.8-flash";
const FALLBACK_MODEL = process.env.CUTROOM_MODEL_FALLBACK || "gemini-3.5-flash-lite";

const HEALTH_CACHE_MS = 60_000;
const FILE_POLL_MS = 2_000;
const FILE_POLL_ATTEMPTS = 30;
const MAX_KEYS_PER_REQUEST = 12;
const RATE_COOLDOWN_MS = 60_000;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let healthCache = { checkedAt: 0, status: "error" };
let healthInFlight;
const FILE_CLIENT = Symbol("gemini-file-client");

const clients = new Map();
let poolSource = "";
let poolKeys = [];
const cooldownUntil = new Map();
let cursor = 0;

// OPSEC: keys are referenced by 1-based position only. A key VALUE is never logged,
// returned, or put in an error message. Ryan livestreams. Do not weaken this.
function keyLabel(index) {
  return `key ${index + 1}/${poolKeys.length}`;
}

function parseKeyPool(raw) {
  const seen = new Set();
  const keys = [];
  for (const piece of String(raw || "").split(/[\s,]+/)) {
    const key = piece.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function pool() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
  if (raw !== poolSource) {
    poolSource = raw;
    poolKeys = parseKeyPool(raw);
    cooldownUntil.clear();
  }
  if (poolKeys.length === 0) {
    throw new Error("Gemini is not configured.");
  }
  return poolKeys;
}

function clientForIndex(index) {
  const key = poolKeys[index];
  let existing = clients.get(key);
  if (!existing) {
    existing = new GoogleGenAI({ apiKey: key });
    clients.set(key, existing);
  }
  return existing;
}

function isCooling(index, now) {
  return (cooldownUntil.get(index) || 0) > now;
}

// Round robin. The cursor advances on every pick so load spreads over the whole pool
// instead of hammering position 1.
function nextKeyIndex(skip) {
  const keys = pool();
  const now = Date.now();
  for (let step = 0; step < keys.length; step += 1) {
    const index = (cursor + step) % keys.length;
    if (skip.has(index) || isCooling(index, now)) continue;
    cursor = (index + 1) % keys.length;
    return index;
  }
  // Every key is either already tried for this request or cooling. Fall back to the
  // untried key whose cooldown expires soonest.
  let best;
  let bestAt = Infinity;
  for (let index = 0; index < keys.length; index += 1) {
    if (skip.has(index)) continue;
    const at = cooldownUntil.get(index) || 0;
    if (at < bestAt) {
      bestAt = at;
      best = index;
    }
  }
  if (best === undefined) return undefined;
  cursor = (best + 1) % keys.length;
  return best;
}

function errorStatus(error) {
  return [
    error?.status,
    error?.code,
    error?.response?.status,
    error?.response?.statusCode,
    error?.cause?.status,
  ]
    .map(Number)
    .find(Number.isFinite);
}

function errorText(error) {
  const parts = [error?.message, error?.status, error?.name];
  try {
    if (error?.details) parts.push(JSON.stringify(error.details));
    if (error?.response?.data) parts.push(JSON.stringify(error.response.data));
  } catch {
    // A detail blob that will not stringify tells us nothing; the message still does.
  }
  return parts.filter(Boolean).join(" ");
}

function isTransientError(error) {
  const status = errorStatus(error);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return /RESOURCE_EXHAUSTED|quota/i.test(errorText(error));
}

// A per-day quota will not clear inside a 60 second cooldown, so a key that hit one is
// benched for the rest of the day instead of being retried every minute.
function isDailyQuota(error) {
  return /PerDay|per day|perDay|GenerateRequestsPerDay|requests per day/i.test(
    errorText(error),
  );
}

// A dead or revoked key in the pool must not take the whole app down. It is benched and
// the request rotates on, exactly like a rate limited key.
function isRejectedKey(error) {
  const status = errorStatus(error);
  if (status !== 400 && status !== 401 && status !== 403) return false;
  return /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|CONSUMER_INVALID/i.test(
    errorText(error),
  );
}

// Errors that belong to ONE key. Anything else is a real problem with the request and
// is thrown straight up rather than replayed against twelve keys.
function isKeyError(error) {
  return isTransientError(error) || isRejectedKey(error);
}

function markCooling(index, error) {
  let shape = "rate limited";
  let ms = RATE_COOLDOWN_MS;
  if (isRejectedKey(error)) {
    shape = "rejected";
    ms = DAILY_COOLDOWN_MS;
  } else if (isDailyQuota(error)) {
    shape = "daily quota";
    ms = DAILY_COOLDOWN_MS;
  }
  cooldownUntil.set(index, Date.now() + ms);
  console.warn(`[gemini] ${keyLabel(index)} ${shape}, rotating to the next key.`);
}

function cleanError(source) {
  const error = new Error("Gemini request failed.");
  const status = errorStatus(source);
  if (status !== undefined) error.status = status;
  if (typeof source?.name === "string" && source.name.trim()) {
    error.name = source.name.trim();
  }
  return error;
}

// Runs `attempt(client, index)` and rotates to a DIFFERENT key on any transient error.
// A key is never retried inside the same request.
async function withKeyRotation(attempt) {
  const keys = pool();
  const budget = Math.min(keys.length, MAX_KEYS_PER_REQUEST);
  const skip = new Set();
  let lastError;
  for (let tries = 0; tries < budget; tries += 1) {
    const index = nextKeyIndex(skip);
    if (index === undefined) break;
    skip.add(index);
    try {
      return await attempt(clientForIndex(index), index);
    } catch (error) {
      lastError = error;
      if (!isKeyError(error)) throw error;
      markCooling(index, error);
    }
  }
  throw lastError || new Error("Gemini request failed.");
}

function jsonConfig(systemPrompt, schemaHint) {
  return {
    systemInstruction: systemPrompt,
    responseMimeType: "application/json",
    ...(schemaHint ? { responseJsonSchema: schemaHint } : {}),
  };
}

function parseJSON(text) {
  if (!text) throw new Error("Gemini returned an empty response.");
  const normalized = text.replace(/^```json\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }
}

async function requestJSON(model, systemPrompt, contents, schemaHint, ai) {
  const run = async (client) => {
    const response = await client.models.generateContent({
      model,
      contents,
      config: jsonConfig(systemPrompt, schemaHint),
    });
    return parseJSON(response.text);
  };
  if (ai) return run(ai);
  return withKeyRotation((client) => run(client));
}

export async function generateJSON(systemPrompt, userContent, schemaHint) {
  try {
    // Key rotation is the first line of defence: every key in the pool gets a turn on
    // the primary model before the model fallback is considered.
    return await requestJSON(PRIMARY_MODEL, systemPrompt, userContent, schemaHint);
  } catch (firstError) {
    if (!isKeyError(firstError)) throw cleanError(firstError);
    try {
      return await requestJSON(
        FALLBACK_MODEL,
        systemPrompt,
        userContent,
        schemaHint,
      );
    } catch (secondError) {
      throw cleanError(secondError);
    }
  }
}

async function uploadWithClient(ai, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === ".mov" ? "video/quicktime" : "video/mp4";
  let file = await ai.files.upload({ file: filePath, config: { mimeType } });
  for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt += 1) {
    if (file.state === "ACTIVE") {
      Object.defineProperty(file, FILE_CLIENT, { value: ai, enumerable: false });
      return file;
    }
    if (file.state === "FAILED" || !file.name) {
      throw new Error("Gemini video processing failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_POLL_MS));
    file = await ai.files.get({ name: file.name });
  }
  throw new Error("Gemini video processing timed out.");
}

function wrapUploadError(error) {
  const wrapped = new Error("Gemini video upload failed.");
  const status = errorStatus(error);
  if (status !== undefined) wrapped.status = status;
  if (typeof error?.name === "string" && error.name.trim()) {
    wrapped.name = error.name.trim();
  }
  return wrapped;
}

export async function uploadVideo(filePath) {
  try {
    return await withKeyRotation((client) => uploadWithClient(client, filePath));
  } catch (error) {
    throw wrapUploadError(error);
  }
}

function fileData(filePart) {
  const uri = filePart?.uri ?? filePart?.fileData?.fileUri;
  const mimeType = filePart?.mimeType ?? filePart?.fileData?.mimeType;
  if (!uri || !mimeType) throw new Error("Gemini video file is not ready.");
  return { fileUri: uri, mimeType };
}

function videoContents(userPayload, filePart) {
  return [
    {
      role: "user",
      parts: [{ text: userPayload }, { fileData: fileData(filePart) }],
    },
  ];
}

export async function generateJSONWithVideo(
  systemPrompt,
  filePart,
  schemaHint,
  userPayload = "Analyze the uploaded video and return the requested JSON.",
) {
  const contents = videoContents(userPayload, filePart);
  const uploadClient = filePart?.[FILE_CLIENT];
  // A file lives in the Files store of the key that uploaded it, so this call is pinned to
  // that client. It must never rotate: another key would be refused access to the file and
  // would be benched for a fault that is not its own. Rotation for video lives in
  // analyzeVideo, which re-uploads.
  if (!uploadClient) {
    throw new Error("Gemini video file is not bound to the key that uploaded it.");
  }
  return requestJSON(PRIMARY_MODEL, systemPrompt, contents, schemaHint, uploadClient);
}

// A file lives in ONE key's Files store, so the upload and the analysis must run on the
// same client. Rotating the key therefore means re-uploading, which is why the pair is
// wrapped together here rather than rotated independently.
export async function analyzeVideo(
  filePath,
  systemPrompt,
  schemaHint,
  userPayload = "Analyze the uploaded video and return the requested JSON.",
  onStage = () => {},
) {
  const stage = typeof onStage === "function" ? onStage : () => {};
  const attemptWith = async (client, model) => {
    stage("uploading");
    const file = await uploadWithClient(client, filePath);
    stage("analyzing");
    const response = await client.models.generateContent({
      model,
      contents: videoContents(userPayload, file),
      config: jsonConfig(systemPrompt, schemaHint),
    });
    return parseJSON(response.text);
  };
  try {
    return await withKeyRotation((client) => attemptWith(client, PRIMARY_MODEL));
  } catch (firstError) {
    if (!isKeyError(firstError)) throw cleanError(firstError);
    try {
      return await withKeyRotation((client) => attemptWith(client, FALLBACK_MODEL));
    } catch (secondError) {
      throw cleanError(secondError);
    }
  }
}

export function getGeminiModels() {
  return { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL };
}

export function getGeminiKeyPoolSize() {
  try {
    return pool().length;
  } catch {
    return 0;
  }
}

export async function getGeminiHealth() {
  const now = Date.now();
  if (now - healthCache.checkedAt < HEALTH_CACHE_MS) {
    return healthCache.status;
  }
  if (healthInFlight) return healthInFlight;

  healthInFlight = (async () => {
    try {
      await requestJSON(
        PRIMARY_MODEL,
        "Return exactly the JSON object {\"ok\":true}.",
        "Health check",
        {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      );
      healthCache = { checkedAt: Date.now(), status: "ok" };
    } catch {
      healthCache = { checkedAt: Date.now(), status: "error" };
    } finally {
      healthInFlight = undefined;
    }
    return healthCache.status;
  })();

  return healthInFlight;
}
