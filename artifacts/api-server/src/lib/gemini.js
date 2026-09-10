import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
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
// A 5xx is the MODEL saying it is busy ("This model is currently experiencing high
// demand"), not the key. Measured 2026-09-09: twelve keys in a row answered 503 on the
// primary and the fallback model answered on its first try. So a busy key is only rested
// briefly, and after MAX_MODEL_BUSY consecutive 5xx answers in one pass the request moves
// to the fallback model instead of paying twelve uploads to learn the same thing.
const BUSY_COOLDOWN_MS = 15_000;
const MAX_MODEL_BUSY = 3;
// Files API objects auto-delete 48 hours after upload (official docs). A cached upload is
// trusted for 40 hours and re-verified with files.get before every reuse, so a file that
// vanished early costs one cheap GET and a fresh upload, never a failed analysis.
const UPLOAD_CACHE_TTL_MS = 40 * 60 * 60 * 1000;
// PER-CALL TIMEOUT 2026-09-09: one 503 hung a generateContent call for about 200s in the
// pre-judging run because nothing bounded a single SDK call. Every generate, upload and
// files.get now runs under a wall-clock budget. Two layers, on purpose:
//   1. The SDK's own options (@google/genai 2.19.0, verified in dist/genai.d.ts):
//      config.httpOptions.timeout (ms, per attempt, also sent as X-Server-Timeout) and
//      config.abortSignal, so the socket is actually torn down.
//   2. A local Promise.race against the same budget, because files.upload threads
//      neither option into the chunk transfer (see uploadFileWithTimeout) and because a
//      stub or a stuck socket that ignores the signal must still return on time.
// A timeout is classified like a 5xx: the key rests BUSY_COOLDOWN_MS and the call rotates.
const CALL_TIMEOUT_MS = positiveMs(process.env.CUTROOM_GEMINI_CALL_TIMEOUT_MS, 60_000);
const UPLOAD_TIMEOUT_MS = positiveMs(process.env.CUTROOM_GEMINI_UPLOAD_TIMEOUT_MS, 120_000);

function positiveMs(raw, fallback) {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function secondsLabel(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function timeoutError(ms, what) {
  const error = new Error(`Gemini ${what} timed out after ${secondsLabel(ms)}.`);
  error.name = "GeminiTimeoutError";
  error.timedOut = true;
  error.timeoutMs = ms;
  return error;
}

function isTimeout(error) {
  return error?.timedOut === true;
}

// Runs run(signal, httpOptions) and settles within `ms` no matter what run does. On the
// deadline the race rejects FIRST (so the caller sees the timeout, not the SDK's abort
// error) and then the signal is aborted so the SDK drops the socket.
async function withCallTimeout(ms, what, run) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError(ms, what));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal, { timeout: ms }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let healthCache = { checkedAt: 0, status: "error" };
let healthInFlight;
const FILE_CLIENT = Symbol("gemini-file-client");

const clients = new Map();
let poolSource = "";
let poolKeys = [];
const cooldownUntil = new Map();
let cursor = 0;
// PRE-JUDGING PASS 2026-09-09: a file lives in the Files store of the key that uploaded
// it, so the cache is keyed by key POSITION plus the file's path, size and mtime. A key
// that is rotated back to (selector retry loop, model fallback pass, a second review
// attempt) reuses its upload instead of pushing the whole video up again. Only a change
// of key forces a re-upload. Cleared whenever the pool itself changes.
const uploadCache = new Map();

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
    uploadCache.clear();
  }
  if (poolKeys.length === 0) {
    throw new Error("Gemini is not configured.");
  }
  return poolKeys;
}

const defaultClientFactory = (key) => new GoogleGenAI({ apiKey: key });
let clientFactory = defaultClientFactory;

// Test seam only: lets the offline timeout test hand in a stub client that never answers.
// Production never calls this. Clears the client cache so the stub is used at once.
export function _setClientFactoryForTests(factory) {
  clientFactory = typeof factory === "function" ? factory : defaultClientFactory;
  clients.clear();
}

function clientForIndex(index) {
  const key = poolKeys[index];
  let existing = clients.get(key);
  if (!existing) {
    existing = clientFactory(key);
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
  if (isTimeout(error)) return true;
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

// A timeout counts as busy: the model did not answer inside the budget, which is the
// same signal as a 503, so it rests the key briefly and counts toward the fallback.
function isModelBusy(error) {
  if (isTimeout(error)) return true;
  const status = errorStatus(error);
  return status >= 500 && status <= 599;
}

function markCooling(index, error) {
  let shape = cooldownShape(error);
  let ms = RATE_COOLDOWN_MS;
  if (isRejectedKey(error) || isDailyQuota(error)) {
    ms = DAILY_COOLDOWN_MS;
  } else if (isModelBusy(error)) {
    ms = BUSY_COOLDOWN_MS;
  }
  cooldownUntil.set(index, Date.now() + ms);
  if (isTimeout(error)) {
    // One honest line: how long we waited and which position gave up. No key value.
    console.warn(
      `[gemini] timed out after ${secondsLabel(error.timeoutMs)} on ${keyLabel(index)}, rotating to the next key.`,
    );
    return;
  }
  const why = quotaHint(error);
  console.warn(
    `[gemini] ${keyLabel(index)} ${shape}${why ? ` (${why})` : ""}, rotating to the next key.`,
  );
}

// The quota id and retry delay Google puts in a 429 body, e.g.
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" and "34s". Neither contains a key
// value; both say WHICH ceiling was hit, which is the one thing the position label
// cannot. Only these two fields are ever taken from the error text.
function quotaHint(error) {
  const text = errorText(error);
  const quota = text.match(/quotaId\\?":\\?"([A-Za-z0-9_.-]+)/);
  const delay = text.match(/retryDelay\\?":\\?"([0-9.]+s)/);
  return [quota ? quota[1] : "", delay ? `retry ${delay[1]}` : ""]
    .filter(Boolean)
    .join(", ");
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

function cooldownShape(error) {
  if (isTimeout(error)) return `timed out after ${secondsLabel(error.timeoutMs)}`;
  if (isRejectedKey(error)) return "rejected";
  if (isDailyQuota(error)) return "daily quota";
  if (isModelBusy(error)) return `busy (${errorStatus(error)})`;
  return "rate limited";
}

// Runs `attempt(client, index, info)` and rotates to a DIFFERENT key on any transient
// error. A key is never retried inside the same request.
// options.preferKeyIndex: try this key first when it is not cooling (the selector uses
//   it so an analysis lands on the key that already holds the upload).
// options.budget: a shared attempt counter ({ used, max }) so a caller can cap the total
//   number of attempts across the primary and fallback passes; when the cap is reached
//   the thrown error carries attemptsExhausted = true and attempts = the count.
// options.onRotate(index, shape): called before rotating past a failed key.
async function withKeyRotation(attempt, options = {}) {
  const keys = pool();
  const perPass = Math.min(keys.length, MAX_KEYS_PER_REQUEST);
  const budget = options.budget;
  const skip = new Set();
  let lastError;
  let busyInARow = 0;
  let preferred =
    Number.isInteger(options.preferKeyIndex) &&
    options.preferKeyIndex >= 0 &&
    options.preferKeyIndex < keys.length
      ? options.preferKeyIndex
      : undefined;
  for (let tries = 0; tries < perPass; tries += 1) {
    if (budget && budget.used >= budget.max) {
      const error = lastError || new Error("Gemini request failed.");
      error.attemptsExhausted = true;
      error.attempts = budget.used;
      throw error;
    }
    let index;
    if (preferred !== undefined && !skip.has(preferred) && !isCooling(preferred, Date.now())) {
      index = preferred;
    } else {
      index = nextKeyIndex(skip);
    }
    preferred = undefined;
    if (index === undefined) break;
    skip.add(index);
    if (budget) budget.used += 1;
    try {
      return await attempt(clientForIndex(index), index, {
        attempt: budget ? budget.used : tries + 1,
        maxAttempts: budget ? budget.max : perPass,
      });
    } catch (error) {
      lastError = error;
      if (!isKeyError(error)) throw error;
      if (typeof options.onRotate === "function") {
        options.onRotate(index, cooldownShape(error));
      }
      markCooling(index, error);
      busyInARow = isModelBusy(error) ? busyInARow + 1 : 0;
      if (busyInARow >= MAX_MODEL_BUSY) {
        // The model, not the pool, is the problem. Hand the request to the caller so
        // it can try the fallback model; the keys are still fine.
        error.modelBusy = true;
        break;
      }
    }
  }
  if (lastError && budget && budget.used >= budget.max) {
    lastError.attemptsExhausted = true;
    lastError.attempts = budget.used;
  }
  throw lastError || new Error("Gemini request failed.");
}

// The three SDK calls this module makes, each under its budget. The SDK options go in
// `config` (GenerateContentConfig / UploadFileConfig / GetFileConfig all carry
// httpOptions + abortSignal in 2.19.0); the race around them is the guarantee.
function generateWithTimeout(client, params) {
  return withCallTimeout(CALL_TIMEOUT_MS, "generateContent", (abortSignal, httpOptions) =>
    client.models.generateContent({
      ...params,
      config: { ...(params.config || {}), abortSignal, httpOptions },
    }),
  );
}

function getFileWithTimeout(client, name) {
  return withCallTimeout(CALL_TIMEOUT_MS, "files.get", (abortSignal, httpOptions) =>
    client.files.get({ name, config: { abortSignal, httpOptions } }),
  );
}

// files.upload gets NO httpOptions on purpose. In 2.19.0 fetchUploadUrl replaces its
// whole default httpOptions (apiVersion '' plus the X-Goog-Upload-* resumable headers)
// with whatever config.httpOptions holds, so passing { timeout } turned every upload into
// a 404 on the local run of 2026-09-09. The abort signal is not threaded into the chunk
// transfer either, so for uploads the race in withCallTimeout is the whole guard.
function uploadFileWithTimeout(client, filePath, mimeType) {
  return withCallTimeout(UPLOAD_TIMEOUT_MS, "files.upload", (abortSignal) =>
    client.files.upload({ file: filePath, config: { mimeType, abortSignal } }),
  );
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
    const response = await generateWithTimeout(client, {
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

async function uploadCacheKey(index, filePath) {
  const stat = await fs.stat(filePath);
  return `${index}\u0000${path.resolve(filePath)}\u0000${stat.size}\u0000${Math.round(stat.mtimeMs)}`;
}

// Returns the cached ACTIVE file for this key and path, or undefined. The entry is
// verified with files.get so a file the store dropped early is never handed to a model.
async function cachedUpload(ai, index, cacheKey) {
  const entry = uploadCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() - entry.at > UPLOAD_CACHE_TTL_MS || !entry.file?.name) {
    uploadCache.delete(cacheKey);
    return undefined;
  }
  try {
    const fresh = await getFileWithTimeout(ai, entry.file.name);
    if (fresh?.state === "ACTIVE" && fresh.uri) {
      Object.defineProperty(fresh, FILE_CLIENT, { value: ai, enumerable: false });
      return fresh;
    }
  } catch {
    // Not found, expired, or a transient blip: fall through to a fresh upload.
  }
  uploadCache.delete(cacheKey);
  return undefined;
}

// Uploads filePath under the client at pool position `index`, reusing a cached upload
// when this key already holds the file. The result carries a non-enumerable `reused`
// flag so callers can say which happened without a second code path.
async function uploadWithClient(ai, filePath, index) {
  const cacheKey =
    Number.isInteger(index) ? await uploadCacheKey(index, filePath) : undefined;
  if (cacheKey) {
    const cached = await cachedUpload(ai, index, cacheKey);
    if (cached) {
      Object.defineProperty(cached, "reused", { value: true, enumerable: false });
      return cached;
    }
  }
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === ".mov" ? "video/quicktime" : "video/mp4";
  let file = await uploadFileWithTimeout(ai, filePath, mimeType);
  for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt += 1) {
    if (file.state === "ACTIVE") {
      Object.defineProperty(file, FILE_CLIENT, { value: ai, enumerable: false });
      Object.defineProperty(file, "reused", { value: false, enumerable: false });
      if (cacheKey) uploadCache.set(cacheKey, { file, at: Date.now() });
      return file;
    }
    if (file.state === "FAILED" || !file.name) {
      throw new Error("Gemini video processing failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_POLL_MS));
    file = await getFileWithTimeout(ai, file.name);
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
    return await withKeyRotation((client, index) =>
      uploadWithClient(client, filePath, index),
    );
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
//
// onStage(stage, info) fires exactly once per attempt with stage "attempt" before the
//   upload starts, and once with stage "analyzing" after the file is ACTIVE. info is
//   { attempt, maxAttempts, key: "key N/M", model, reusedUpload, previous }, where
//   reusedUpload says this key already holds the file (no upload needed) and previous
//   describes the key that just failed ({ key, shape }), undefined on the first attempt.
//   One "attempt" event per attempt is what lets a caller log one line per attempt.
// options.maxAttempts caps the TOTAL attempts across the primary and fallback passes.
//   Default: up to MAX_KEYS_PER_REQUEST per model, the pre-existing behaviour.
// options.preferKeyIndex asks for a specific key first (see withKeyRotation).
export async function analyzeVideo(
  filePath,
  systemPrompt,
  schemaHint,
  userPayload = "Analyze the uploaded video and return the requested JSON.",
  onStage = () => {},
  options = {},
) {
  const stage = typeof onStage === "function" ? onStage : () => {};
  const keys = pool();
  const perPass = Math.min(keys.length, MAX_KEYS_PER_REQUEST);
  const max =
    Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
      ? options.maxAttempts
      : perPass * 2;
  const budget = { used: 0, max };
  let previous;
  const onRotate = (index, shape) => {
    previous = { key: keyLabel(index), shape };
  };
  const attemptWith = async (client, index, info, model) => {
    const base = {
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      key: keyLabel(index),
      model,
      reusedUpload: uploadCache.has(await uploadCacheKey(index, filePath)),
      previous,
    };
    previous = undefined;
    stage("attempt", base);
    const file = await uploadWithClient(client, filePath, index);
    stage("analyzing", { ...base, reusedUpload: Boolean(file.reused) });
    const response = await generateWithTimeout(client, {
      model,
      contents: videoContents(userPayload, file),
      config: jsonConfig(systemPrompt, schemaHint),
    });
    return parseJSON(response.text);
  };
  const rotation = {
    budget,
    onRotate,
    preferKeyIndex: options.preferKeyIndex,
  };
  try {
    return await withKeyRotation(
      (client, index, info) => attemptWith(client, index, info, PRIMARY_MODEL),
      rotation,
    );
  } catch (firstError) {
    if (!isKeyError(firstError)) throw cleanError(firstError);
    if (firstError.attemptsExhausted) throw exhaustedError(firstError, budget);
    try {
      return await withKeyRotation(
        (client, index, info) => attemptWith(client, index, info, FALLBACK_MODEL),
        rotation,
      );
    } catch (secondError) {
      if (secondError?.attemptsExhausted) throw exhaustedError(secondError, budget);
      throw cleanError(secondError);
    }
  }
}

function exhaustedError(source, budget) {
  const error = cleanError(source);
  error.attemptsExhausted = true;
  error.attempts = budget.used;
  error.lastShape = cooldownShape(source);
  return error;
}

// Uploads a video under ONE key ahead of its analysis so the analysis can reuse it via
// the cache. Returns { index, ok, shape }: ok false with the shape of the failure when the
// key was rate limited or rejected; never throws for a key error, because the analysis
// path will upload again anyway.
export async function preuploadVideo(filePath, keyIndex) {
  const keys = pool();
  let index = keyIndex;
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    index = nextKeyIndex(new Set());
  }
  if (index === undefined) return { index: undefined, ok: false, shape: "no key free" };
  try {
    const file = await uploadWithClient(clientForIndex(index), filePath, index);
    return { index, ok: true, reused: Boolean(file.reused) };
  } catch (error) {
    if (!isKeyError(error)) throw wrapUploadError(error);
    const shape = cooldownShape(error);
    markCooling(index, error);
    return { index, ok: false, shape };
  }
}

// Picks the key the selector should upload a batch on: the next round-robin key that is
// not cooling. Position only; the value never leaves this module.
export function pickKeyIndex() {
  return nextKeyIndex(new Set());
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

// Shape of the pool for the health route. Counts and positions only, never a value.
export function getGeminiKeyPoolStatus() {
  let size = 0;
  try {
    size = pool().length;
  } catch {
    size = 0;
  }
  const now = Date.now();
  let cooling = 0;
  let benched = 0;
  for (const [, until] of cooldownUntil) {
    if (until <= now) continue;
    if (until - now > RATE_COOLDOWN_MS) benched += 1;
    else cooling += 1;
  }
  const source = process.env.GEMINI_API_KEYS
    ? "GEMINI_API_KEYS"
    : process.env.GEMINI_API_KEY
      ? "GEMINI_API_KEY"
      : "none";
  return {
    size,
    available: Math.max(0, size - cooling - benched),
    cooling,
    benched,
    source,
    cachedUploads: uploadCache.size,
  };
}

// The last live probe without firing a new one, so a health poll during judging never
// spends model quota by itself.
export function getGeminiHealthCached() {
  if (!healthCache.checkedAt) return { status: "unprobed", ageSec: null };
  return {
    status: healthCache.status,
    ageSec: Math.round((Date.now() - healthCache.checkedAt) / 1000),
  };
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
