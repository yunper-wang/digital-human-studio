// lib/drama/subtitle.mjs
// SRT 软字幕：从分镜 dialogue 派生 + 序列化（校对即编辑 dialogue，故无需解析回读）

export function formatSrtTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// 由分镜派生字幕：仅取有台词镜，时间轴按 durationSec 顺序累计
export function deriveSubtitles(shots = []) {
  const entries = [];
  let cursor = 0;
  for (const shot of shots) {
    const dur = Number(shot?.durationSec) || 0;
    const text = String(shot?.dialogue || "").trim();
    if (text) entries.push({ shotId: shot.id, start: cursor, end: cursor + dur, text });
    cursor += dur;
  }
  return entries;
}

export function entriesToSrt(entries = []) {
  if (!entries.length) return "";
  return entries
    .map((e, i) => `${i + 1}\n${formatSrtTime(e.start)} --> ${formatSrtTime(e.end)}\n${String(e.text || "").trim()}`)
    .join("\n\n") + "\n";
}

// 整片 SRT：直接由分镜派生（校对后的 dialogue 即最新台词）
export function filmSrt(shots = []) {
  return entriesToSrt(deriveSubtitles(shots));
}
