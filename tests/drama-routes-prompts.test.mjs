// tests/drama-routes-prompts.test.mjs
// M7 提示词模板端点 + 项目切模板校验
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createPromptStore, BUILTIN_TEMPLATE_ID } from "../lib/drama/prompts.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rp-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, promptStore: createPromptStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { ctx, project, dataRoot };
}

test("模板：列表含内置→建→改→复制→删", async () => {
  const { ctx, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.body.data.templates.length, 1);
  assert.equal(res.body.data.templates[0].builtin, true);

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "悬疑风", stages: { review: "自定义审核" } }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 201);
  const tid = res.body.data.template.id;

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ stages: { review: "自定义审核 v2" } }) }, res, new URL(`http://x/api/drama/prompt-templates/${tid}`), ctx);
  assert.equal(res.body.data.template.stages.review, "自定义审核 v2");

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/prompt-templates/${tid}/duplicate`), ctx);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.template.name, "悬疑风 副本");

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/prompt-templates/${tid}`), ctx);
  assert.equal(res.body.data.removed, tid);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("内置模板 PATCH/DELETE → 403；空名/四段全空 → 422", async () => {
  const { ctx, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ name: "x" }) }, res, new URL(`http://x/api/drama/prompt-templates/${BUILTIN_TEMPLATE_ID}`), ctx);
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/prompt-templates/${BUILTIN_TEMPLATE_ID}`), ctx);
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "", stages: { review: "x" } }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "x", stages: {} }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 422);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("项目切模板：合法 → 200 写入；不存在 → 422；置 null 回默认", async () => {
  const { ctx, project, dataRoot } = setup();
  const tpl = ctx.promptStore.create({ name: "t", stages: { review: "x" } });
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: tpl.id }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.promptTemplateId, tpl.id);
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: "ptpl-00000000-0000-0000-0000-000000000000" }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: null }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.promptTemplateId, null);
  rmSync(dataRoot, { recursive: true, force: true });
});
