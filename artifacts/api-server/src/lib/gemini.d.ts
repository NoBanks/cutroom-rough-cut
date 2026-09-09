export interface GeminiFilePart {
  name?: string;
  uri?: string;
  mimeType?: string;
  fileData?: {
    fileUri?: string;
    mimeType?: string;
  };
}

export type GeminiJSON = Record<string, unknown>;

export function generateJSON(
  systemPrompt: string,
  userContent: unknown,
  schemaHint?: unknown,
): Promise<GeminiJSON>;

export function uploadVideo(filePath: string): Promise<GeminiFilePart>;

export function generateJSONWithVideo(
  systemPrompt: string,
  filePart: GeminiFilePart,
  schemaHint?: unknown,
  userPayload?: string,
): Promise<GeminiJSON>;

export interface GeminiStageInfo {
  attempt: number;
  maxAttempts: number;
  key: string;
  model: string;
  reusedUpload: boolean;
  previous?: { key: string; shape: string };
}

export interface AnalyzeVideoOptions {
  maxAttempts?: number;
  preferKeyIndex?: number;
}

export function analyzeVideo(
  filePath: string,
  systemPrompt: string,
  schemaHint?: unknown,
  userPayload?: string,
  onStage?: (stage: "attempt" | "analyzing", info: GeminiStageInfo) => void,
  options?: AnalyzeVideoOptions,
): Promise<GeminiJSON>;

export function preuploadVideo(
  filePath: string,
  keyIndex?: number,
): Promise<number | undefined>;

export function pickKeyIndex(): number | undefined;

export function getGeminiModels(): { primary: string; fallback: string };

export function getGeminiKeyPoolSize(): number;

export function getGeminiKeyPoolStatus(): {
  size: number;
  available: number;
  cooling: number;
  benched: number;
  source: "GEMINI_API_KEYS" | "GEMINI_API_KEY" | "none";
  cachedUploads: number;
};

export function getGeminiHealthCached(): {
  status: "ok" | "error" | "unprobed";
  ageSec: number | null;
};

export function getGeminiHealth(): Promise<"ok" | "error">;
