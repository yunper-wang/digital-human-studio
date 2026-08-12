// tests/drama-routes-provider-overrides.test.mjs
// M9 项目级后端覆盖端点：GET 脱敏、PATCH 写入+clear、密钥永不入响应
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createProviderOverrideStore } from "../lib/drama/provider-overrides.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpo-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, providerOverrideStore: createProviderOverrideStore(dataRoot),
    llmDeps: { config: { mock: true } }, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("GET provider-overrides 未配置返回 null 字段；配置后脱敏（apiKey 永不出）", async () => {
  const { ctx, project, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.overrides, { llm: null, voice: null });

  ctx.providerOverrideStore.save(project.id, { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-SECRET" }, voice: { elevenKey: "sk-ELEVEN" } });
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.body.data.overrides.llm.configured, true);
  assert.equal(res.body.data.overrides.llm.baseUrl, "https://api.x.com/v1");
  assert.equal(res.body.data.overrides.llm.model, "gpt-4o");
  assert.equal(res.body.data.overrides.voice.configured, true);
  // 脱敏：响应体不含密钥
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("sk-SECRET") && !raw.includes("sk-ELEVEN") && !raw.includes("apiKey") && !raw.includes("elevenKey"));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("PATCH 写 override；clear 清除；空值 → 422", async () => {
  const { ctx, project, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.overrides.llm.configured, true);
  assert.equal(ctx.providerOverrideStore.get(project.id).llm.apiKey, "sk-x"); // 文件里有

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ clear: ["llm"] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.overrides.llm, null);

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ llm: { baseUrl: "", model: "y", apiKey: "z" } }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 422);
  rmSync(dataRoot, { recursive: true, force: true });
});
