import { GoogleGenAI } from "@google/genai";
import path from "node:path";

const PRIMARY_MODEL = "gemini-3-flash-preview";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
const HEALTH_CACHE_MS = 60_000;
const FILE_POLL_MS = 2_000;
const FILE_POLL_ATTEMPTS = 30;

let healthCache = { checkedAt: 0, status: "error" };
let healthInFlight;
const FILE_CLIENT = Symbol("gemini-file-client");
let cachedClient;
let cachedApiKey;

function client() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini is not configured.");
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({ apiKey });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

function isTransientError(error) {
  const status = Number(error?.status ?? error?.code);
  return status === 429 || (status >= 500 && status <= 599);
}

function cleanError(source) {
  const error = new Error("Gemini request failed.");
  const status = Number(source?.status ?? source?.code);
  if (Number.isFinite(status)) error.status = status;
  return error;
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

async function requestJSON(
  model,
  systemPrompt,
  contents,
  schemaHint,
  ai = client(),
) {
  const response = await ai.models.generateContent({
    model,
    contents,
    config: jsonConfig(systemPrompt, schemaHint),
  });
  return parseJSON(response.text);
}

export async function generateJSON(systemPrompt, userContent, schemaHint) {
  try {
    return await requestJSON(PRIMARY_MODEL, systemPrompt, userContent, schemaHint);
  } catch (firstError) {
    if (!isTransientError(firstError)) throw cleanError();
    try {
      return await requestJSON(
        PRIMARY_MODEL,
        systemPrompt,
        userContent,
        schemaHint,
      );
    } catch {
      try {
        return await requestJSON(
          FALLBACK_MODEL,
          systemPrompt,
          userContent,
          schemaHint,
        );
      } catch {
        throw cleanError();
      }
    }
    throw cleanError();
  }
}

export async function uploadVideo(filePath) {
  try {
    const ai = client();
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = extension === ".mov" ? "video/quicktime" : "video/mp4";
    let file = await ai.files.upload({
      file: filePath,
      config: { mimeType },
    });
    for (let attempt = 0; attempt < FILE_POLL_ATTEMPTS; attempt += 1) {
      if (file.state === "ACTIVE") return file;
      if (file.state === "FAILED" || !file.name) {
        throw new Error("Gemini video processing failed.");
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_POLL_MS));
      file = await ai.files.get({ name: file.name });
    }
    throw new Error("Gemini video processing timed out.");
  } catch {
    throw new Error("Gemini video upload failed.");
  }
}

function fileData(filePart) {
  const uri = filePart?.uri ?? filePart?.fileData?.fileUri;
  const mimeType = filePart?.mimeType ?? filePart?.fileData?.mimeType;
  if (!uri || !mimeType) throw new Error("Gemini video file is not ready.");
  return { fileUri: uri, mimeType };
}

export async function generateJSONWithVideo(
  systemPrompt,
  filePart,
  schemaHint,
) {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "Analyze the uploaded video and return the requested JSON." },
        { fileData: fileData(filePart) },
      ],
    },
  ];
  return generateJSON(systemPrompt, contents, schemaHint);
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