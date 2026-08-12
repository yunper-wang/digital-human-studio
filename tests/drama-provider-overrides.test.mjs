// tests/drama-provider-overrides.test.mjs
// M9 项目级后端覆盖存储：密钥本机文件存，损坏自愈，写入校验
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderOverrideStore } from "../lib/drama/provider-overrides.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-po-"));
  return { store: createProviderOverrideStore(dataRoot), dataRoot };
}

test("get 不存在返回 null；save→get→remove", () => {
  const { store, dataRoot } = setup();
  assert.equal(store.get("drama-1"), null);
  store.save("drama-1", { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
  const ov = store.get("drama-1");
  assert.deepEqual(ov, { projectId: "drama-1", llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
  store.save("drama-1", { voice: { elevenKey: "sk-e" } });
  assert.equal(store.get("drama-1").voice.elevenKey, "sk-e");
  assert.equal(store.remove("drama-1"), true);
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("损坏文件 get 返回 null（自愈）", () => {
  const { store, dataRoot } = setup();
  store.save("drama-1", { llm: { baseUrl: "x", model: "y", apiKey: "z" } });
  const f = join(dataRoot, "provider-overrides", "drama-1.json");
  writeFileSync(f, "{{{");
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("save 校验：llm 必须三字段齐全；voice 必须有 elevenKey", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.save("drama-1", { llm: { baseUrl: "", model: "y", apiKey: "z" } }), /PROVIDER_OVERRIDE_INVALID/);
  assert.throws(() => store.save("drama-1", { voice: { elevenKey: "" } }), /PROVIDER_OVERRIDE_INVALID/);
  rmSync(dataRoot, { recursive: true, force: true });
});
