// tests/drama-routes-providers.test.mjs
// M7 模型管理只读聚合端点：五区块形状 + 状态枚举 + 脱敏 + 单区块故障隔离
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function baseCtx(overrides = {}) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => "", update: () => null, list: () => [], save: () => {} },
    llmDeps: { config: { mock: true } },
    comfyConfig: {},
    seedanceStatus: () => ({ configured: false, connected: false, state: "runtime_missing" }),
    audioDeps: {},
    detectFfmpeg: () => ({ available: false, path: null, version: null }),
    pricing: {}, findAvatar: () => null, findVoice: () => null, seedanceConfig: {},
    ...overrides
  };
}

test("providers 聚合：五区块形状 + 状态枚举合法 + 脱敏", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpv-"));
  const ctx = baseCtx({
    llmDeps: { config: { mock: false, baseUrl: "https://api.example.com/v1", model: "m-x", apiKey: "sk-SECRET" } },
    comfyConfig: { baseUrl: "http://127.0.0.1:8188" },
    seedanceStatus: () => ({ configured: true, connected: true, state: "connected" }),
    audioDeps: { voiceboxUrl: "http://127.0.0.1:5005", elevenKey: "sk-ELEVEN" },
    detectFfmpeg: () => ({ available: true, version: "7.1" })
  });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/providers"), ctx);
  assert.equal(res.statusCode, 200);
  const providers = res.body.data.providers;
  assert.deepEqual(providers.map((p) => p.id), ["llm", "comfyui", "seedance", "voice", "ffmpeg"]);
  for (const p of providers) {
    assert.ok(["ready", "degraded", "missing"].includes(p.status), `${p.id} status 合法`);
    assert.ok(["required", "recommended", "optional"].includes(p.required), `${p.id} required 合法`);
    assert.ok(typeof p.summary === "string" && typeof p.hint === "string");
  }
  assert.equal(providers[0].status, "ready");   // 已配置 LLM
  assert.equal(providers[0].summary.includes("api.example.com"), true);
  assert.equal(providers[2].status, "ready");   // seedance connected
  assert.equal(providers[3].status, "ready");   // voicebox 已检测
  assert.equal(providers[4].status, "ready");   // ffmpeg 可用
  // 脱敏：响应体不得含密钥明文或密钥字段
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("sk-SECRET") && !raw.includes("sk-ELEVEN") && !raw.includes("apiKey"));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("单区块探测抛错不拖垮整页；mock LLM → degraded", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpv-"));
  const ctx = baseCtx({
    seedanceStatus: () => { throw new Error("boom"); }
  });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/providers"), ctx);
  assert.equal(res.statusCode, 200);
  const providers = res.body.data.providers;
  assert.equal(providers.length, 5);
  assert.equal(providers[0].status, "degraded"); // mock LLM
  const seedance = providers.find((p) => p.id === "seedance");
  assert.equal(seedance.status, "missing");
  assert.equal(seedance.summary, "状态探测失败");
  rmSync(dataRoot, { recursive: true, force: true });
});
