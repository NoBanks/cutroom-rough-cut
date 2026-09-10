import path from "node:path";

// The api-server runs either from the workspace root (Replit deployment: node
// artifacts/api-server/dist/index.mjs) or from artifacts/api-server (pnpm --filter dev).
// Both resolve to the same workspace root here so agents, sample clips and the
// temporary session directory are found either way.
const currentDirectory = process.cwd();
export const workspaceRoot =
  path.basename(currentDirectory) === "api-server" &&
  path.basename(path.dirname(currentDirectory)) === "artifacts"
    ? path.resolve(currentDirectory, "../..")
    : currentDirectory;
export const TEMP_DIR = path.join(workspaceRoot, "artifacts/api-server/tmp-sessions");
export const SAMPLE_DIR = path.join(workspaceRoot, "sample_clips");
