import test from "node:test";
import assert from "node:assert/strict";
import { planVoiceShots, resolveShotVoice, synthesizeShotVoice } from "../lib/drama/audio.mjs";

test("planVoiceShots 只取有台词且 audioMode=voice 的对白镜", () => {
  const project = { shots: [
    { id: "s1", shotType: "dialogue", audioMode: "voice", dialogue: "说", durationSec: 3 },
    { id: "s2", shotType: "dialogue", audioMode: "none", dialogue: "静音", durationSec: 3 },
    { id: "s3", shotType: "cinematic", audioMode: "voice", dialogue: "", durationSec: 3 },
    { id: "s4", shotType: "dialogue", audioMode: "voice", dialogue: "", durationSec: 3 }
  ]};
  assert.deepEqual(planVoiceShots(project).map((s) => s.id), ["s1"]);
});

test("resolveShotVoice 优先 voicebox，其次 elevenlabs，无音色返回 null", () => {
  const voices = [
    { id: "vb1", provider: "voicebox", profileId: "prof-1", ttsReady: true },
    { id: "el1", provider: "elevenlabs" }
  ];
  const findVoice = (id) => voices.find((v) => v.id === id) || null;
  assert.deepEqual(resolveShotVoice({ voiceId: "vb1" }, findVoice), { kind: "voicebox", profileId: "prof-1" });
  assert.deepEqual(resolveShotVoice({ voiceId: "el1" }, findVoice), { kind: "elevenlabs", voiceId: "el1" });
  assert.equal(resolveShotVoice({ voiceId: "nope" }, findVoice), null);
  assert.equal(resolveShotVoice({ voiceId: null }, findVoice), null);
});

test("synthesizeShotVoice voicebox 走 generate→history→audio", async () => {
  const ab = new ArrayBuffer(600);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/generate")) return { json: async () => ({ id: "g1" }) };
    if (url.includes("/history/")) return { json: async () => ({ status: "completed" }) };
    if (url.includes("/audio/")) return { arrayBuffer: async () => ab };
    throw new Error("unexpected " + url);
  };
  const out = await synthesizeShotVoice({ voiceTarget: { kind: "voicebox", profileId: "p" }, text: "台词", language: "zh", deps: { voiceboxUrl: "http://127.0.0.1:9", fetchImpl, sleep: async () => {} } });
  assert.equal(out.provider, "voicebox");
  assert.ok(out.bytes.length >= 500);
  assert.ok(calls[0].endsWith("/generate"));
});

test("synthesizeShotVoice 缺配置时报对应错误", async () => {
  await assert.rejects(
    synthesizeShotVoice({ voiceTarget: { kind: "voicebox", profileId: "p" }, text: "x", language: "zh", deps: { fetchImpl: fetch, sleep: async () => {} } }),
    /VOICEBOX|Voicebox/
  );
  await assert.rejects(
    synthesizeShotVoice({ voiceTarget: { kind: "elevenlabs", voiceId: "v" }, text: "x", language: "zh", deps: { fetchImpl: fetch, sleep: async () => {} } }),
    /ElevenLabs|ELEVENLABS/
  );
});

test("M8：ElevenLabs 分支有 voiceCloneRef → similarity_boost 提升；voiceRefUsed=true", async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, arrayBuffer: async () => Buffer.alloc(800) };
  };
  const result = await synthesizeShotVoice({
    voiceTarget: { kind: "elevenlabs", voiceId: "v1" },
    text: "你好", language: "zh",
    deps: { elevenKey: "sk-x", fetchImpl },
    voiceCloneRef: { bytes: Buffer.alloc(100), materialId: "mat-1" }
  });
  assert.equal(result.provider, "elevenlabs");
  assert.equal(result.voiceRefUsed, true);
  assert.ok(capturedBody.voice_settings.similarity_boost >= 0.9);
});

test("M8：无 voiceCloneRef → 常规 similarity_boost=0.78；voiceRefUsed=false", async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, arrayBuffer: async () => Buffer.alloc(800) };
  };
  const result = await synthesizeShotVoice({
    voiceTarget: { kind: "elevenlabs", voiceId: "v1" },
    text: "你好", language: "zh",
    deps: { elevenKey: "sk-x", fetchImpl }
  });
  assert.equal(result.voiceRefUsed, false);
  assert.equal(capturedBody.voice_settings.similarity_boost, 0.78);
});

test("M8：Voicebox 分支忽略 voiceCloneRef；voiceRefUsed=false", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/generate")) return { ok: true, json: async () => ({ id: "job1" }) };
    if (url.includes("/history/")) return { ok: true, json: async () => ({ status: "completed" }) };
    if (url.includes("/audio/")) return { ok: true, arrayBuffer: async () => Buffer.alloc(800) };
    return { ok: false };
  };
  const result = await synthesizeShotVoice({
    voiceTarget: { kind: "voicebox", profileId: "p1" },
    text: "你好", language: "zh",
    deps: { voiceboxUrl: "http://127.0.0.1:5005", fetchImpl, sleep: async () => {} },
    voiceCloneRef: { bytes: Buffer.alloc(100), materialId: "mat-1" }
  });
  assert.equal(result.provider, "voicebox");
  assert.equal(result.voiceRefUsed, false);
});
