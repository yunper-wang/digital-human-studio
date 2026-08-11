// lib/drama/llm.mjs
// OpenAI 兼容端点客户端；未配置时返回确定性 mock，保证零费用演示与测试
export function getDramaLlmConfig(env = process.env) {
  const baseUrl = String(env.DRAMA_LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = String(env.DRAMA_LLM_API_KEY || "");
  const model = String(env.DRAMA_LLM_MODEL || "");
  const mock = env.DRAMA_LLM_MOCK === "1" || !baseUrl || !model;
  return {
    baseUrl,
    apiKey,
    model,
    mock,
    timeoutMs: Number(env.DRAMA_LLM_TIMEOUT_MS) || 120_000,
    maxRetries: Number.isInteger(Number(env.DRAMA_LLM_MAX_RETRIES)) ? Number(env.DRAMA_LLM_MAX_RETRIES) : 2
  };
}

export async function dramaLlmStatus(config = getDramaLlmConfig(), fetchImpl = fetch) {
  if (config.mock) {
    return { configured: false, connected: false, state: "mock", mock: true, model: config.model || null };
  }
  try {
    const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const response = await fetchImpl(`${config.baseUrl}/models`, { headers, signal: AbortSignal.timeout(4000) });
    return { configured: true, connected: response.ok, state: response.ok ? "connected" : `http_${response.status}`, mock: false, model: config.model };
  } catch {
    return { configured: true, connected: false, state: "unreachable", mock: false, model: config.model };
  }
}

export function extractJson(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw Object.assign(new Error("DRAMA_LLM_INVALID_JSON: 输出中找不到 JSON 对象"), { code: "DRAMA_LLM_INVALID_JSON" });
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw Object.assign(new Error(`DRAMA_LLM_INVALID_JSON: ${error.message}`), { code: "DRAMA_LLM_INVALID_JSON" });
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callDramaLlm(stage, { system, user }, deps = {}) {
  const config = deps.config || getDramaLlmConfig();
  if (config.mock) return mockStageResponse(stage, user);
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || defaultSleep;
  let lastError = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt) await sleep(500 * attempt);
    try {
      const headers = { "Content-Type": "application/json" };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.model,
          temperature: 0.4,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = Object.assign(new Error(`编排模型返回 ${response.status}`), { code: `DRAMA_LLM_HTTP_${response.status}`, retryable });
        if (retryable) continue;
        throw lastError;
      }
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (!text) throw Object.assign(new Error("编排模型返回为空"), { code: "DRAMA_LLM_EMPTY", retryable: true });
      return text;
    } catch (error) {
      if (error.code && !String(error.code).startsWith("DRAMA_LLM_UNREACHABLE")) {
        if (!error.retryable) throw error;
        lastError = error;
        continue;
      }
      lastError = Object.assign(new Error(`编排模型不可达：${error.message}`), { code: "DRAMA_LLM_UNREACHABLE", retryable: true });
    }
  }
  throw lastError;
}

// ---------------- 确定性 mock：从用户 payload 中提取剧本并启发式生成 ----------------

function mockPayload(user) {
  try {
    const start = String(user).indexOf("{");
    const end = String(user).lastIndexOf("}");
    return JSON.parse(String(user).slice(start, end + 1));
  } catch {
    return {};
  }
}

function mockSentences(script) {
  return String(script || "").split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
}

function mockAnalysis(payload) {
  const sentences = mockSentences(payload.script);
  return {
    synopsis: sentences[0] ? `${sentences[0]}（演示梗概）` : "演示短剧梗概",
    genre: "都市情感",
    characters: [
      { id: "char-1", name: "林晚", role: "主角", personality: "外柔内刚，刚经历挫折", appearance: "young Chinese woman, shoulder-length black hair, tired gentle eyes, beige coat" },
      { id: "char-2", name: "陈默", role: "主角", personality: "沉默寡言，体贴", appearance: "young Chinese man, short black hair, dark gray jacket, calm expression" }
    ],
    scenes: [
      { id: "scene-1", name: "便利店门口", location: "城市街角便利店", mood: "雨夜冷色，灯光温暖", appearance: "convenience store entrance at night, warm glowing signage, wet pavement reflections, glass door" },
      { id: "scene-2", name: "雨夜街道", location: "通往地铁站的路口", mood: "雨幕朦胧", appearance: "rainy city street at night, blurred neon, umbrella silhouettes, mist" }
    ],
    props: [
      { id: "prop-1", name: "雨伞", sceneName: "便利店门口", appearance: "black folding umbrella, slightly worn, metal ribs" },
      { id: "prop-2", name: "挂失回执", sceneName: "便利店门口", appearance: "small white paper receipt with printed text" }
    ]
  };
}

function mockDirection(payload) {
  const sentences = mockSentences(payload.script);
  const picked = sentences.length ? sentences : ["演示画面一", "演示画面二", "演示画面三"];
  const cameras = ["medium", "close-up", "wide"];
  const shots = picked.slice(0, 6).map((sentence, i) => {
    const isDialogue = /[「『"]/.test(sentence) || i % 2 === 1;
    return {
      id: `shot-${i + 1}`,
      sceneName: i < picked.length / 2 ? "便利店门口" : "雨夜街道",
      characterIds: isDialogue ? ["char-1", "char-2"] : ["char-1"],
      shotType: isDialogue ? "dialogue" : "cinematic",
      camera: cameras[i % cameras.length],
      dialogue: isDialogue ? sentence.replace(/[「『"]|[」』"]/g, "") : "",
      action: sentence,
      durationSec: 4 + (i % 3),
      emotion: ["失落", "意外", "温暖"][i % 3]
    };
  });
  return { shots };
}

function mockPrompts(payload) {
  const characters = new Map((payload.analysis?.characters || []).map((c) => [c.id, c]));
  const scenesByName = new Map((payload.analysis?.scenes || []).map((s) => [s.name, s]));
  const props = payload.analysis?.props || [];
  const shots = (payload.shots || []).map((shot) => {
    const appearances = (shot.characterIds || [])
      .map((id) => characters.get(id)?.appearance)
      .filter(Boolean)
      .join("; ");
    const sceneAppearance = scenesByName.get(shot.sceneName)?.appearance || "";
    const propAppearances = props.filter((p) => p.sceneName === shot.sceneName).map((p) => p.appearance).filter(Boolean).join("; ");
    return {
      ...shot,
      fluxPrompt: [
        "cinematic film still", `${shot.camera || "medium"} shot`,
        appearances || "single character",
        sceneAppearance,
        propAppearances,
        shot.action || shot.dialogue || "quiet moment",
        `mood: ${shot.emotion || "calm"}`,
        "rainy night city lighting, photorealistic, 85mm lens"
      ].filter(Boolean).join(", "),
      negativePrompt: "low quality, watermark, text, deformed face, extra fingers",
      motionPrompt: "subtle camera push-in, natural micro motion, rain falling"
    };
  });
  return { shots };
}

function mockReview() {
  return { pass: true, issues: [{ shotId: null, severity: "warn", message: "演示编排模式：未接入真实审核模型，仅做结构校验" }] };
}

function mockStageResponse(stage, user) {
  const payload = mockPayload(user);
  if (stage === "analyze") return JSON.stringify(mockAnalysis(payload));
  if (stage === "direct") return JSON.stringify(mockDirection(payload));
  if (stage === "prompt") return JSON.stringify(mockPrompts(payload));
  if (stage === "review") return JSON.stringify(mockReview(payload));
  return JSON.stringify({});
}
