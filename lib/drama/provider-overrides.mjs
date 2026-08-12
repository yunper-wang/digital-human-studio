// lib/drama/provider-overrides.mjs
// 项目级后端配置覆盖：LLM + ElevenLabs；密钥存本机文件，永不入 project JSON 或 API 响应
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function createProviderOverrideStore(dataRoot) {
  const root = join(dataRoot, "provider-overrides");
  mkdirSync(root, { recursive: true });
  const file = (projectId) => join(root, `${projectId}.json`);

  function get(projectId) {
    if (typeof projectId !== "string" || !projectId) return null;
    if (!existsSync(file(projectId))) return null;
    try {
      const raw = JSON.parse(readFileSync(file(projectId), "utf8"));
      if (!raw || typeof raw !== "object") return null;
      return { projectId, ...raw };
    } catch { return null; } // 损坏文件自愈
  }

  function save(projectId, override) {
    if (typeof projectId !== "string" || !projectId) throw Object.assign(new Error("projectId 必填"), { code: "PROVIDER_OVERRIDE_INVALID" });
    const out = { projectId };
    if (override?.llm) {
      const baseUrl = String(override.llm.baseUrl || "").trim();
      const model = String(override.llm.model || "").trim();
      const apiKey = String(override.llm.apiKey || "").trim();
      if (!baseUrl || !model || !apiKey) throw Object.assign(new Error("LLM 覆盖需 baseUrl/model/apiKey 齐全（PROVIDER_OVERRIDE_INVALID）"), { code: "PROVIDER_OVERRIDE_INVALID" });
      out.llm = { baseUrl, model, apiKey };
    }
    if (override?.voice) {
      const elevenKey = String(override.voice.elevenKey || "").trim();
      if (!elevenKey) throw Object.assign(new Error("配音覆盖需 elevenKey（PROVIDER_OVERRIDE_INVALID）"), { code: "PROVIDER_OVERRIDE_INVALID" });
      out.voice = { elevenKey };
    }
    writeFileSync(file(projectId), JSON.stringify(out, null, 2));
    return out;
  }

  function remove(projectId) {
    if (existsSync(file(projectId))) { rmSync(file(projectId)); }
    return true;
  }

  return { get, save, remove };
}
