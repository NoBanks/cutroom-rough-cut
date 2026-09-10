// Offline proof that a Gemini call which never answers still returns inside the
// per-call budget, rests the key like a 5xx, and rotates. No network, no real key:
// the pool is two throwaway strings and the client is a stub handed in through the
// test seam. Run with `pnpm run test` from artifacts/api-server.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.CUTROOM_GEMINI_CALL_TIMEOUT_MS = "200";
process.env.CUTROOM_GEMINI_UPLOAD_TIMEOUT_MS = "300";
process.env.GEMINI_API_KEYS = "stub-key-one,stub-key-two";

const gemini = await import("../src/lib/gemini.js");

const SAMPLE_CLIP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../sample_clips/clip_0.mp4",
);
const NEVER = () => new Promise(() => {});
const ANSWER = { text: JSON.stringify({ ok: true }) };

function captureWarnings(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  return run().finally(() => {
    console.warn = original;
  }).then((result) => ({ result, lines }));
}

function stubPool(behaviour) {
  const seen = [];
  gemini._setClientFactoryForTests((key) => ({
    models: {
      generateContent: (params) => {
        seen.push({ key, call: "generate", params });
        return behaviour.generate(key, params);
      },
    },
    files: {
      upload: (params) => {
        seen.push({ key, call: "upload", params });
        return behaviour.upload(key, params);
      },
      get: (params) => {
        seen.push({ key, call: "get", params });
        return behaviour.get(key, params);
      },
    },
  }));
  return seen;
}

test("a generateContent that never resolves returns inside the budget and rotates", async () => {
  const seen = stubPool({
    generate: (key) => (key === "stub-key-one" ? NEVER() : Promise.resolve(ANSWER)),
  });
  const started = Date.now();
  const { result, lines } = await captureWarnings(() =>
    gemini.generateJSON("system", "user", undefined),
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: true });
  assert.ok(elapsed < 1000, `returned in ${elapsed}ms, budget 200ms`);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /timed out after 0\.2s on key 1\/2/);
  assert.ok(!lines.some((line) => line.includes("stub-key")), "a key value leaked into a log line");
  const hung = seen.find((entry) => entry.key === "stub-key-one");
  assert.equal(hung.params.config.httpOptions.timeout, 200, "SDK httpOptions.timeout not passed");
  assert.ok(hung.params.config.abortSignal instanceof AbortSignal, "SDK abortSignal not passed");
  assert.equal(hung.params.config.abortSignal.aborted, true, "signal not aborted at the deadline");
  assert.equal(hung.params.config.systemInstruction, "system", "existing config was dropped");
});

test("every key hanging on both models fails inside keys x passes x budget", async () => {
  stubPool({ generate: () => NEVER() });
  const started = Date.now();
  const { result, lines } = await captureWarnings(() =>
    gemini.generateJSON("system", "user", undefined).then(
      () => undefined,
      (error) => error,
    ),
  );
  const elapsed = Date.now() - started;
  assert.ok(result instanceof Error, "expected a rejection");
  assert.equal(result.name, "GeminiTimeoutError");
  assert.equal(result.message, "Gemini request failed.");
  assert.ok(elapsed < 2500, `failed in ${elapsed}ms; 2 keys x 2 models x 200ms = 800ms expected`);
  assert.ok(elapsed >= 800, `failed in ${elapsed}ms, faster than four full budgets`);
  assert.equal(lines.length, 4, lines.join("\n"));
  for (const line of lines) assert.match(line, /timed out after 0\.2s on key [12]\/2/);
});

test("an upload that never resolves times out on its own budget and the next key finishes", async () => {
  process.env.GEMINI_API_KEYS = "stub-key-three,stub-key-four,stub-key-five";
  const activeFile = { name: "files/stub", state: "ACTIVE", uri: "https://example.invalid/files/stub", mimeType: "video/mp4" };
  const seen = stubPool({
    upload: (key) => (key === "stub-key-three" ? NEVER() : Promise.resolve(activeFile)),
    get: () => Promise.resolve(activeFile),
    generate: () => Promise.resolve(ANSWER),
  });
  const stages = [];
  const started = Date.now();
  const { result } = await captureWarnings(() =>
    gemini.analyzeVideo(SAMPLE_CLIP, "system", undefined, "go", (stage, info) => {
      if (stage === "attempt") stages.push(info);
    }, { preferKeyIndex: 0 }),
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: true });
  assert.ok(elapsed < 1500, `returned in ${elapsed}ms, upload budget 300ms`);
  assert.equal(stages.length, 2);
  assert.equal(stages[1].previous.key, "key 1/3");
  assert.equal(stages[1].previous.shape, "timed out after 0.3s");
  const hung = seen.find((entry) => entry.call === "upload" && entry.key === "stub-key-three");
  // No httpOptions on uploads: the SDK's fetchUploadUrl would replace its resumable
  // upload headers with ours and 404 (seen live 2026-09-09). The race is the guard.
  assert.equal(hung.params.config.httpOptions, undefined);
  assert.equal(hung.params.config.mimeType, "video/mp4");
  assert.equal(hung.params.config.abortSignal.aborted, true);
});
