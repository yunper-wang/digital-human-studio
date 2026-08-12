// tests/drama-routes-suggestions.test.mjs
// M12 智能建议端点：GET 脱敏、POST regenerate
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rsug-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, suggestionStore: createSuggestionStore(dataRoot),
    llmDeps: { config: { mock: true } }, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("GET suggestions 未生成返回 null", async () => {
  const { ctx, project, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.suggestions, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("GET suggestions 已生成返回建议；regenerate 触发 202", async () => {
  const { ctx, project, dataRoot } = setup();
  ctx.suggestionStore.save(project.id, { projectId: project.id, generatedAt: "2026-08-16T00:00:00.000Z", suggestions: [{ category: "structure", severity: "warn", target: null, message: "高潮缺失" }] });
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.suggestions.suggestions[0].message, "高潮缺失");
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions/regenerate`), ctx);
  assert.equal(res.statusCode, 202);
  rmSync(dataRoot, { recursive: true, force: true });
});
