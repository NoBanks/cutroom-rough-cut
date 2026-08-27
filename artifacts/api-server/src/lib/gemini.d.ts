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

export function getGeminiHealth(): Promise<"ok" | "error">;