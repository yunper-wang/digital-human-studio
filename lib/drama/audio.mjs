// lib/drama/audio.mjs
// 对白镜 TTS 配音：Voicebox 本地（免费）优先，ElevenLabs（付费）备选；无 TTS 静默回退（不阻塞合成）

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 需要配音的对白镜：dialogue + audioMode=voice + 有台词 + 时长≥2s
export function planVoiceShots(project) {
  return (project?.shots || []).filter((s) =>
    s.shotType === "dialogue" && s.audioMode === "voice" && String(s.dialogue || "").trim() && (Number(s.durationSec) || 0) >= 2);
}

// 解析对白镜可用的 TTS：优先本地 Voicebox（profileId），其次 ElevenLabs（voice id）
export function resolveShotVoice(character, findVoice) {
  if (!character?.voiceId || typeof findVoice !== "function") return null;
  const voice = findVoice(character.voiceId);
  if (!voice) return null;
  if (voice.provider === "voicebox" && voice.profileId && voice.ttsReady !== false) {
    return { kind: "voicebox", profileId: voice.profileId };
  }
  if (voice.id) return { kind: "elevenlabs", voiceId: voice.id };
  return null;
}

async function synthesizeWithElevenlabs({ apiKey, voiceId, text, fetchImpl }) {
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.55, similarity_boost: 0.78, style: 0.18, speed: 1 } })
  });
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs 返回 ${res.status}`), { code: `ELEVENLABS_${res.status}` });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 500) throw Object.assign(new Error("配音音频为空"), { code: "VOICE_EMPTY" });
  return bytes;
}

async function synthesizeWithVoicebox({ serviceUrl, profileId, text, language, fetchImpl, sleep }) {
  const gen = await fetchImpl(`${serviceUrl}/generate`, {
    method: "POST", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, profile_id: profileId, language: language === "en" ? "en" : "zh", model_size: "1.7B" })
  });
  const created = await gen.json().catch(() => ({}));
  const id = created?.id;
  if (!id) throw Object.assign(new Error("Voicebox 未返回配音任务 id"), { code: "VOICEBOX_NO_ID" });
  let done = false;
  for (let attempt = 0; attempt < 120 && !done; attempt += 1) {
    const st = await (await fetchImpl(`${serviceUrl}/history/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) })).json().catch(() => ({}));
    if (["completed", "succeeded"].includes(st.status)) { done = true; break; }
    if (["failed", "cancelled", "canceled"].includes(st.status)) throw Object.assign(new Error(st.error || "Voicebox 配音失败"), { code: "VOICEBOX_FAILED" });
    await sleep(1500);
  }
  if (!done) throw Object.assign(new Error("Voicebox 配音超时"), { code: "VOICEBOX_TIMEOUT" });
  const audio = await fetchImpl(`${serviceUrl}/audio/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length < 500) throw Object.assign(new Error("配音音频为空"), { code: "VOICE_EMPTY" });
  return bytes;
}

// 统一入口：按 voiceTarget.kind 路由到对应 TTS
export async function synthesizeShotVoice({ voiceTarget, text, language = "zh", deps = {} }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || defaultSleep;
  if (voiceTarget?.kind === "voicebox") {
    if (!deps.voiceboxUrl) throw Object.assign(new Error("未连接本地 Voicebox 服务"), { code: "VOICEBOX_UNAVAILABLE" });
    const bytes = await synthesizeWithVoicebox({ serviceUrl: deps.voiceboxUrl, profileId: voiceTarget.profileId, text, language, fetchImpl, sleep });
    return { bytes, provider: "voicebox" };
  }
  if (voiceTarget?.kind === "elevenlabs") {
    if (!deps.elevenKey) throw Object.assign(new Error("未配置 ElevenLabs Key"), { code: "ELEVENLABS_KEY_MISSING" });
    const bytes = await synthesizeWithElevenlabs({ apiKey: deps.elevenKey, voiceId: voiceTarget.voiceId, text, fetchImpl });
    return { bytes, provider: "elevenlabs" };
  }
  throw Object.assign(new Error("该对白镜角色未绑定可用音色"), { code: "VOICE_UNAVAILABLE" });
}
