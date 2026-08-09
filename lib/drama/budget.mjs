// lib/drama/budget.mjs
// 剧集级预算单：首帧走本机 ComfyUI 记 ¥0；视频与配音为预估价，单价可用环境变量校准
export function getDramaPricing(env = process.env) {
  return {
    currency: "CNY",
    seedancePerShot: Number(env.DRAMA_PRICE_SEEDANCE_PER_SHOT ?? 6),
    h3PerSecond: Number(env.DRAMA_PRICE_H3_PER_SECOND ?? 0.5),
    ttsPerThousandChars: Number(env.DRAMA_PRICE_TTS_PER_KCHAR ?? 2),
    framePerShot: 0
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

export function estimateBudget(project, pricing = getDramaPricing()) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const dialogueShots = shots.filter((s) => s.shotType === "dialogue");
  const cinematicShots = shots.filter((s) => s.shotType !== "dialogue");
  const ttsChars = dialogueShots.reduce((sum, s) => sum + String(s.dialogue || "").replace(/\s/g, "").length, 0);
  const cinematicSeconds = cinematicShots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
  const lines = [
    {
      id: "frames",
      label: `首帧生成（本机 ComfyUI ×${shots.length} 镜）`,
      count: shots.length,
      unitPrice: pricing.framePerShot,
      subtotal: 0,
      kind: "local"
    },
    {
      id: "seedance",
      label: `口播镜视频（Seedance ×${dialogueShots.length} 镜，预估）`,
      count: dialogueShots.length,
      unitPrice: pricing.seedancePerShot,
      subtotal: round(dialogueShots.length * pricing.seedancePerShot),
      kind: "paid"
    },
    {
      id: "h3",
      label: `剧情镜视频（MiniMax H3 约 ${cinematicSeconds} 秒，预估）`,
      count: cinematicSeconds,
      unitPrice: pricing.h3PerSecond,
      subtotal: round(cinematicSeconds * pricing.h3PerSecond),
      kind: "paid"
    },
    {
      id: "tts",
      label: `台词配音（约 ${ttsChars} 字，预估）`,
      count: ttsChars,
      unitPrice: pricing.ttsPerThousandChars,
      subtotal: round((ttsChars / 1000) * pricing.ttsPerThousandChars),
      kind: "paid"
    }
  ];
  return {
    currency: pricing.currency,
    estimated: true,
    totalShots: shots.length,
    totalPaid: round(lines.filter((line) => line.kind === "paid").reduce((sum, line) => sum + line.subtotal, 0)),
    lines,
    generatedAt: new Date().toISOString()
  };
}
