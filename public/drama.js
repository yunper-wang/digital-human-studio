const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  project: null,
  projects: [],
  avatars: [],
  voices: [],
  pollTimer: null,
  view: "script",          // script | assets | story | generate
  selectedShotId: null,
  ffmpegAvailable: null,   // null=未探测
  showSubs: true           // 预览字幕开关
};

const RUNNING_STATUSES = ["analyzing", "directing", "prompting", "reviewing"];
const STAGE_ORDER = ["analyze", "direct", "prompt", "review"];
const STATUS_LABEL = {
  draft: "草稿", analyzing: "剧本分析中", directing: "导演分镜中", prompting: "提示词生成中",
  reviewing: "审核中", awaiting_gate_a: "待确认预算", review_blocked: "审核未通过",
  failed: "流水线失败", frames: "首帧生成中", awaiting_gate_b: "待确认首帧", frames_confirmed: "首帧已确认",
  videos: "视频生成中", clips_ready: "全部视频已确认",
};

const VIEWS = ["script", "assets", "story", "generate"];
const STEPPER = [
  { key: "script", no: "01", label: "剧本" },
  { key: "assets", no: "03", label: "视觉资产" },
  { key: "story", no: "04", label: "分镜" },
  { key: "generate", no: "05", label: "镜头生成" }
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.message || `请求失败 (${response.status})`);
    error.code = payload.errorCode;
    throw error;
  }
  return payload;
}

function toast(titleText, detail = "", type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const strong = document.createElement("b");
  const span = document.createElement("span");
  strong.textContent = titleText;
  span.textContent = detail;
  node.append(strong, span);
  $("#toastWrap").append(node);
  setTimeout(() => node.remove(), 3600);
}

function showError(message) {
  const banner = $("#errorBanner");
  if (!message) {
    banner.classList.add("hidden");
    return;
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
}

// ---------- 健康状态 ----------

async function loadHealth() {
  try {
    const { data } = await api("/api/health");
    const llm = data.providers.dramaLlm || {};
    const comfy = data.providers.comfyui || {};
    setProvider($("#llmStatus"), llm.connected ? "on" : llm.mock ? "demo" : "off", llm.connected ? "已连接" : llm.mock ? "演示编排" : "未配置");
    setProvider($("#comfyStatus"), comfy.connected ? "on" : "off", comfy.connected ? "已连接" : "未连接");
    $("#mockBanner").classList.toggle("hidden", !llm.mock);
  } catch {
    setProvider($("#llmStatus"), "off", "检查失败");
    setProvider($("#comfyStatus"), "off", "检查失败");
  }
}

function setProvider(node, mode, label) {
  node.dataset.mode = mode;
  node.title = label;
}

// ---------- 项目加载 ----------

async function loadProjects(selectId) {
  const { data } = await api("/api/drama/projects");
  state.projects = data.projects;
  const select = $("#projectSelect");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.projects.length ? "选择项目…" : "暂无项目";
  select.append(placeholder);
  for (const item of state.projects) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title}（${STATUS_LABEL[item.status] || item.status}）`;
    select.append(option);
  }
  const target = selectId || localStorage.getItem("dramaCurrentProjectId") || "";
  if (target && state.projects.some((p) => p.id === target)) {
    select.value = target;
    await loadProject(target);
  }
}

async function loadProject(id) {
  const { data } = await api(`/api/drama/projects/${id}`);
  state.project = data.project;
  localStorage.setItem("dramaCurrentProjectId", id);
  renderProject();
  schedulePoll();
}

async function createProject() {
  const title = $("#dramaTitle").value.trim() || "未命名短剧";
  const script = $("#dramaScript").value.trim();
  if (script.length < 50) {
    toast("剧本太短", "至少需要 50 个字符", "error");
    return null;
  }
  const { data } = await api("/api/drama/projects", {
    method: "POST",
    body: JSON.stringify({ title, script })
  });
  await loadProjects(data.project.id);
  return data.project;
}

// ---------- 视图切换与步骤条 ----------

function setView(name) {
  if (!VIEWS.includes(name)) return;
  state.view = name;
  $$(".vz-ic[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  $("#viewScript").classList.toggle("hidden", name !== "script");
  $("#viewAssets").classList.toggle("hidden", name !== "assets");
  $("#viewStory").classList.toggle("hidden", name !== "story");
  $("#viewGenerate").classList.toggle("hidden", name !== "generate");
  if (name === "generate" && state.project && state.ffmpegAvailable === null) {
    loadFfmpegStatus().then(() => { if (state.view === "generate") renderCompose(state.project); });
  }
  renderStepper();
}

function currentStageKey(project) {
  if (!project || !project.analysis) return "script";
  if (["analyzing", "directing", "prompting", "reviewing"].includes(project.status)) return "script";
  if (!project.gateAConfirmedAt) return "assets";
  if (!project.shots.every((s) => s.frame.status === "confirmed")) return "story";
  return "generate";
}

function renderStepper() {
  const project = state.project;
  const active = currentStageKey(project);
  const box = $("#stepper");
  box.innerHTML = "";
  for (const s of STEPPER) {
    const li = document.createElement("li");
    li.className = "vz-step" + (s.key === active ? " on" : "");
    li.innerHTML = `<span class="no">${s.no}</span>${s.label}`;
    li.addEventListener("click", () => setView(s.key));
    box.append(li);
  }
}

function renderProjHead(project) {
  const box = $("#projHead");
  box.innerHTML = "";
  const left = document.createElement("div");
  const h1 = document.createElement("h1"); h1.textContent = project ? project.title : "新建短剧";
  const p = document.createElement("p"); p.textContent = "完善剧本与角色后，再逐镜头生成视频。";
  left.append(h1, p);
  const tags = document.createElement("div"); tags.className = "tags";
  const ratio = document.createElement("span"); ratio.textContent = project ? (project.ratio === "portrait" ? "9:16" : project.ratio) : "9:16";
  const count = document.createElement("span"); count.textContent = `${project ? project.shots.length : 0} 个镜头`;
  tags.append(ratio, count);
  box.append(left, tags);
}

// ---------- 渲染 ----------

function renderProject() {
  const project = state.project;
  if (!project) return;
  showError(null);
  $("#dramaTitle").value = project.title;
  if (document.activeElement !== $("#dramaScript")) $("#dramaScript").value = project.script;
  $("#dramaCharCount").textContent = `${project.script.replace(/\s/g, "").length} 字`;
  $("#projectStatus").textContent = STATUS_LABEL[project.status] || project.status;
  renderProjHead(project);
  renderStepper();
  renderStages(project);
  renderCharacters(project);
  renderSceneAssets(project);
  renderPropAssets(project);
  renderStory(project);
  renderBudget(project);
  renderGateB(project);
  renderCompose(project);
  renderSubtitleEditor(project);
  renderBgm(project);
  $("#resumeBtn").classList.toggle("hidden", project.status !== "failed");
  $("#genAllFramesBtn").classList.toggle("hidden", !project.gateAConfirmedAt || !project.shots.some((s) => ["pending", "failed"].includes(s.frame.status)));
  if (project.status === "failed" && project.pipeline?.error) {
    showError(`流水线在「${project.pipeline.error.stage}」阶段失败：${project.pipeline.error.message}`);
  }
  if (project.status === "review_blocked" && project.review) {
    showError(`审核未通过：${project.review.issues.filter((i) => i.severity === "block").map((i) => i.message).join("；") || "请检查分镜内容"}`);
  }
}

function renderStages(project) {
  const activeStage = project.pipeline?.stage;
  const doneIndex = project.analysis ? (project.shots.length ? (project.shots[0]?.fluxPrompt ? (project.review ? 4 : 3) : 2) : 1) : 0;
  for (const item of $$("#stageList li")) {
    const stage = item.dataset.stage;
    const index = STAGE_ORDER.indexOf(stage);
    item.classList.toggle("active", stage === activeStage);
    item.classList.toggle("done", index < doneIndex && stage !== activeStage);
    item.querySelector("em").textContent = stage === activeStage ? "进行中" : index < doneIndex ? "完成" : "";
  }
}

function renderCharacters(project) {
  const box = $("#characterList");
  box.innerHTML = "";
  const characters = project.analysis?.characters || [];
  if (!characters.length) {
    box.innerHTML = '<p class="muted">解析后生成</p>';
    return;
  }
  for (const character of characters) {
    const card = document.createElement("div");
    card.className = "character-item";
    const name = document.createElement("b");
    name.textContent = `${character.name} · ${character.role}`;
    const personality = document.createElement("span");
    personality.textContent = character.personality || "—";
    const appearance = document.createElement("small");
    appearance.textContent = character.appearance;

    const avatarRow = document.createElement("label");
    avatarRow.className = "bind-row";
    avatarRow.append(document.createTextNode("形象"));
    const avatarSelect = document.createElement("select");
    const emptyAvatar = document.createElement("option");
    emptyAvatar.value = "";
    emptyAvatar.textContent = "未绑定";
    avatarSelect.append(emptyAvatar);
    for (const avatar of state.avatars) {
      const option = document.createElement("option");
      option.value = avatar.id;
      option.textContent = avatar.name;
      avatarSelect.append(option);
    }
    avatarSelect.value = character.avatarId || "";
    avatarSelect.addEventListener("change", () => saveCharacter(project, character.id, { avatarId: avatarSelect.value || null }));
    avatarRow.append(avatarSelect);

    const voiceRow = document.createElement("label");
    voiceRow.className = "bind-row";
    voiceRow.append(document.createTextNode("音色"));
    const voiceSelect = document.createElement("select");
    const emptyVoice = document.createElement("option");
    emptyVoice.value = "";
    emptyVoice.textContent = "未绑定";
    voiceSelect.append(emptyVoice);
    for (const voice of state.voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name;
      voiceSelect.append(option);
    }
    voiceSelect.value = character.voiceId || "";
    voiceSelect.addEventListener("change", () => saveCharacter(project, character.id, { voiceId: voiceSelect.value || null }));
    voiceRow.append(voiceSelect);

    card.append(name, personality, appearance, avatarRow, voiceRow);
    box.append(card);
  }
}

function renderSceneAssets(project) {
  const box = $("#sceneList");
  if (!box) return;
  box.innerHTML = "";
  const scenes = project?.analysis?.scenes || [];
  if (!scenes.length) { box.innerHTML = '<p class="muted">解析后生成</p>'; return; }
  for (const s of scenes) {
    const item = document.createElement("div");
    item.className = "vz-char";
    const name = document.createElement("b"); name.textContent = `${s.name} · ${s.location || ""}`;
    const mood = document.createElement("div"); mood.className = "muted"; mood.textContent = s.mood || "";
    const app = document.createElement("div"); app.className = "muted mono"; app.style.fontSize = "10px"; app.textContent = s.appearance || "（无外观锁）";
    item.append(name, mood, app);
    box.append(item);
  }
}

function renderPropAssets(project) {
  const box = $("#propList");
  if (!box) return;
  box.innerHTML = "";
  const props = project?.analysis?.props || [];
  if (!props.length) { box.innerHTML = '<p class="muted">解析后生成</p>'; return; }
  for (const p of props) {
    const item = document.createElement("div");
    item.className = "vz-char";
    const name = document.createElement("b"); name.textContent = `${p.name}${p.sceneName ? ` · ${p.sceneName}` : ""}`;
    const app = document.createElement("div"); app.className = "muted mono"; app.style.fontSize = "10px"; app.textContent = p.appearance || "（无外观锁）";
    item.append(name, app);
    box.append(item);
  }
}

async function saveCharacter(project, charId, patch) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/characters/${charId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    state.project = data.project;
    renderProject();
    toast("角色绑定已更新");
  } catch (error) {
    toast("绑定失败", error.message, "error");
    renderProject(); // 回退选择框显示
  }
}

function frameUrl(project, shot) {
  return shot.frame.file ? `/drama-files/${project.id}/${shot.frame.file}` : null;
}

function selectShot(shotId) {
  state.selectedShotId = shotId;
  renderStory(state.project);
}

function currentShot(project) {
  if (!project || !project.shots.length) return null;
  return project.shots.find((s) => s.id === state.selectedShotId) || project.shots[0];
}

function renderStory(project) {
  renderStrip(project);
  const shot = currentShot(project);
  renderPreview(project, shot);
  renderInspector(project, shot);
}

function renderStrip(project) {
  const box = $("#strip");
  box.innerHTML = "";
  $("#stripMeta").textContent = `${project.shots.length} 镜 · 点击选镜`;
  if (!project.shots.length) { box.innerHTML = '<p class="muted">运行流水线后展示分镜</p>'; return; }
  for (const shot of project.shots) {
    const th = document.createElement("button");
    th.className = "vz-th" + (shot.id === (currentShot(project)?.id) ? " sel" : "") + (shot.frame.status === "failed" ? " failed" : "");
    const url = frameUrl(project, shot);
    if (url) { const img = document.createElement("img"); img.src = url; img.alt = `镜${shot.index}`; th.append(img); }
    const num = document.createElement("span"); num.className = "num"; num.textContent = shot.index; th.append(num);
    const bdg = document.createElement("span"); bdg.className = `bdg ${shot.shotType}`; bdg.textContent = shot.shotType === "dialogue" ? "词" : "画"; th.append(bdg);
    if (shot.shotType === "dialogue") {
      const audio = shot.clip?.audio || {};
      const vtxt = audio.status === "ready" ? "🎙" : audio.status === "generating" ? "…" : shot.audioMode === "none" ? "🔇" : "";
      if (vtxt) { const vb = document.createElement("span"); vb.className = "vz-voice"; vb.textContent = vtxt; th.append(vb); }
    }
    const dur = document.createElement("span"); dur.className = "dur"; dur.textContent = `${shot.durationSec}s`; th.append(dur);
    if (shot.frame.status === "confirmed") { const ok = document.createElement("span"); ok.className = "ok"; ok.textContent = "✓"; th.append(ok); }
    th.addEventListener("click", () => selectShot(shot.id));
    box.append(th);
  }
}

function renderPreview(project, shot) {
  const stage = $("#preview");
  const meta = $("#previewMeta");
  if (!shot) { stage.innerHTML = '<div class="frm"><span class="empty">运行流水线后展示分镜</span></div>'; meta.textContent = "未选镜"; return; }
  meta.textContent = `镜 ${shot.index} / ${project.shots.length} · ${shot.shotType === "dialogue" ? "口播镜" : "剧情镜"} · ${shot.durationSec}s`;
  stage.innerHTML = "";
  const tag = document.createElement("span"); tag.className = "stagetag"; tag.textContent = `镜 ${shot.index}`; stage.append(tag);
  const subsBtn = document.createElement("button"); subsBtn.className = "vz-subs-toggle" + (state.showSubs === false ? "" : " on"); subsBtn.textContent = "字幕"; subsBtn.title = "字幕开关"; stage.append(subsBtn);
  subsBtn.addEventListener("click", () => { state.showSubs = state.showSubs === false; renderPreview(project, shot); });
  const frm = document.createElement("div"); frm.className = "frm";
  const clip = shot.clip || { status: "pending" };
  if (clip.file) {
    const v = document.createElement("video"); v.controls = true; v.preload = "metadata"; v.src = `/drama-files/${project.id}/${clip.file}`; frm.append(v);
  } else if (frameUrl(project, shot)) {
    const img = document.createElement("img"); img.src = frameUrl(project, shot); img.alt = `镜${shot.index}首帧`; frm.append(img);
  } else {
    const s = document.createElement("span"); s.className = "empty"; s.textContent = frameStatusText(shot) || "待生成首帧"; frm.append(s);
  }
  if (String(shot.dialogue || "").trim()) {
    const cap = document.createElement("div"); cap.className = "cap" + (state.showSubs === false ? " hidden" : ""); cap.textContent = shot.dialogue; frm.append(cap);
  }
  stage.append(frm);
}

function renderInspector(project, shot) {
  const box = $("#inspector");
  box.innerHTML = "";
  if (!shot) { box.innerHTML = '<p class="muted">选中一个分镜以编辑</p>'; return; }
  const tabs = document.createElement("div"); tabs.className = "vz-tabs";
  const tabShot = document.createElement("button"); tabShot.className = "on"; tabShot.textContent = "分镜";
  tabs.append(tabShot); box.append(tabs);

  const editable = isEditable(project);
  const mkField = (label, node) => { const f = document.createElement("div"); f.className = "vz-field"; const l = document.createElement("label"); l.textContent = label; f.append(l, node); return f; };

  const dialogue = document.createElement("textarea"); dialogue.value = shot.dialogue; dialogue.placeholder = "台词（口播镜必填）"; dialogue.disabled = !editable;
  dialogue.addEventListener("change", () => saveShot(project, shot.id, { dialogue: dialogue.value }));
  box.append(mkField(`台词（镜 ${shot.index}）`, dialogue));

  const prompt = document.createElement("textarea"); prompt.value = shot.fluxPrompt; prompt.disabled = !editable; prompt.style.minHeight = "70px";
  prompt.addEventListener("change", () => saveShot(project, shot.id, { fluxPrompt: prompt.value }));
  box.append(mkField("Flux 首帧提示词", prompt));

  const cam = document.createElement("select"); ["close-up","medium","wide","over-shoulder","low-angle"].forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; cam.append(o); });
  cam.value = shot.camera; cam.disabled = !editable;
  cam.addEventListener("change", () => saveShot(project, shot.id, { camera: cam.value }));
  const dur = document.createElement("input"); dur.type = "number"; dur.min = "2"; dur.max = "15"; dur.value = shot.durationSec; dur.disabled = !editable;
  dur.addEventListener("change", () => saveShot(project, shot.id, { durationSec: Number(dur.value) }));
  const row = document.createElement("div"); row.className = "vz-rowline"; row.append(cam, dur);
  box.append(mkField("运镜 · 时长(s)", row));

  const seg = document.createElement("div"); seg.className = "vz-seg";
  [["voice","配音"],["none","静音"]].forEach(([val,label]) => { const b = document.createElement("button"); b.textContent = label; b.className = shot.audioMode === val ? "on" : ""; b.disabled = !editable; b.addEventListener("click", () => saveShot(project, shot.id, { audioMode: val })); seg.append(b); });
  box.append(mkField("音频模式", seg));

  const cont = document.createElement("input"); cont.type = "text"; cont.value = shot.continuity || ""; cont.placeholder = "如：与镜 2 同场景"; cont.maxLength = 120; cont.disabled = !editable;
  cont.addEventListener("change", () => saveShot(project, shot.id, { continuity: cont.value }));
  box.append(mkField("连续性 / 衔接", cont));

  const frameRow = document.createElement("div"); frameRow.className = "vz-rowline";
  if (frameUrl(project, shot)) { const t = document.createElement("img"); t.className = "vz-minithumb"; t.src = frameUrl(project, shot); frameRow.append(t); }
  const genBtn = document.createElement("button"); genBtn.className = "vz-btn"; genBtn.textContent = ["ready","confirmed"].includes(shot.frame.status) ? "↻ 换抽" : "生成首帧";
  genBtn.disabled = !project.gateAConfirmedAt || shot.frame.status === "generating";
  genBtn.addEventListener("click", () => generateFrame(project, shot.id)); frameRow.append(genBtn);
  if (shot.frame.status === "ready") { const c = document.createElement("button"); c.className = "vz-btn vz-btn-primary"; c.textContent = "确认首帧"; c.addEventListener("click", () => confirmFrame(project, shot.id)); frameRow.append(c); }
  box.append(mkField("首帧", frameRow));

  const reason = videoBlockReason(project, shot);
  const clip = shot.clip || { status: "pending" };
  const vBtn = document.createElement("button"); vBtn.className = "vz-apply";
  vBtn.textContent = ["ready","confirmed"].includes(clip.status) ? "重新生成视频" : "生成视频";
  vBtn.disabled = !canGenerateVideo(project, shot) || clip.status === "generating"; vBtn.title = reason;
  vBtn.addEventListener("click", () => generateVideo(project, shot)); box.append(vBtn);
  if (clip.status === "ready") { const c = document.createElement("button"); c.className = "vz-btn vz-btn-primary"; c.style.marginTop = "8px"; c.style.width = "100%"; c.textContent = "确认视频"; c.addEventListener("click", () => confirmVideo(project, shot.id)); box.append(c); }
  if (reason) { const h = document.createElement("div"); h.className = "vz-hint"; h.textContent = reason; box.append(h); }
}

function isEditable(project) {
  return ["awaiting_gate_a", "review_blocked", "frames", "awaiting_gate_b"].includes(project.status);
}

function frameStatusText(shot) {
  return {
    pending: "待生成首帧",
    generating: "首帧生成中…",
    ready: "",
    confirmed: "",
    failed: "生成失败，可重试"
  }[shot.frame.status] || shot.frame.status;
}

function boundCharacter(project, shot) {
  return project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]) || null;
}

function videoBlockReason(project, shot) {
  if (!project.gateAConfirmedAt) return "请先确认预算闸门";
  if (shot.shotType === "dialogue") {
    const character = boundCharacter(project, shot);
    if (!character?.avatarId || !character?.voiceId) return "请先在角色卡绑定形象与音色";
    if (!String(shot.dialogue || "").trim()) return "口播镜需要台词";
    return "";
  }
  if (shot.frame.status !== "confirmed") return "剧情镜需要先确认首帧";
  return "";
}

function canGenerateVideo(project, shot) {
  return !videoBlockReason(project, shot);
}

async function generateVideo(project, shot) {
  const clip = shot.clip || { status: "pending" };
  const regen = ["ready", "confirmed"].includes(clip.status);
  if (regen && !window.confirm("重新生成视频将产生额外费用，继续？")) return;
  try {
    await api(`/api/drama/projects/${project.id}/shots/${shot.id}/video`, {
      method: "POST",
      body: JSON.stringify(regen ? { confirmCost: true } : {})
    });
    schedulePoll(true);
  } catch (error) {
    toast("视频生成失败", error.message, "error");
  }
}

async function confirmVideo(project, shotId) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}/video-confirm`, { method: "POST", body: "{}" });
    state.project = data.project;
    renderProject();
  } catch (error) {
    toast("确认失败", error.message, "error");
  }
}

function renderBudget(project) {
  const box = $("#budgetLines");
  box.innerHTML = "";
  if (!project.budget) {
    box.innerHTML = '<p class="muted">流水线完成后生成</p>';
    $("#budgetTotal").textContent = "—";
    $("#gateABtn").classList.add("hidden");
    return;
  }
  for (const line of project.budget.lines) {
    const row = document.createElement("div");
    row.className = "budget-row";
    const label = document.createElement("span");
    label.textContent = line.label;
    const value = document.createElement("b");
    value.textContent = line.kind === "local" ? "¥0（本机）" : `¥${line.subtotal}`;
    row.append(label, value);
    box.append(row);
  }
  $("#budgetTotal").textContent = `¥${project.budget.totalPaid}`;
  $("#gateABtn").classList.toggle("hidden", project.status !== "awaiting_gate_a");
}

function renderGateB(project) {
  const total = project.shots.length;
  const confirmed = project.shots.filter((s) => s.frame.status === "confirmed").length;
  $("#gateBProgress").style.width = total ? `${(confirmed / total) * 100}%` : "0%";
  $("#gateBText").textContent = `${confirmed} / ${total}`;
  $("#doneBanner").classList.toggle("hidden", !(total > 0 && ["frames_confirmed", "clips_ready"].includes(project.status)));
  const clipTotal = project.shots.length;
  const clipConfirmed = project.shots.filter((s) => s.clip?.status === "confirmed").length;
  $("#clipProgress").style.width = clipTotal ? `${(clipConfirmed / clipTotal) * 100}%` : "0%";
  $("#clipText").textContent = `${clipConfirmed} / ${clipTotal}`;
  if (project.status === "clips_ready") {
    $("#doneBanner").textContent = "全部视频已确认。可前往「镜头生成」视图合成成片。";
  } else if (project.status === "frames_confirmed") {
    // 换绑/重抽首帧可从 clips_ready 回到 frames_confirmed，需恢复对应文案
    $("#doneBanner").textContent = "首帧全部确认。现在可以逐镜生成视频（口播镜需先绑定角色形象与音色）。";
  }
}

// ---------- 动作 ----------

async function saveShot(project, shotId, patch) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    state.project = data.project;
    renderProject();
    if (data.project.status === "awaiting_gate_a" && project.gateAConfirmedAt) {
      toast("预算已变更", "台词或时长变化使费用确认失效，请重新确认", "error");
    }
  } catch (error) {
    toast("保存失败", error.message, "error");
  }
}

async function runPipeline() {
  try {
    showError(null);
    let project = state.project;
    const scriptDirty = !project || $("#dramaScript").value.trim() !== project.script;
    if (!project) {
      project = await createProject();
      if (!project) return;
    } else if (scriptDirty) {
      const { data } = await api(`/api/drama/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: $("#dramaTitle").value.trim(), script: $("#dramaScript").value.trim() })
      });
      project = data.project;
      state.project = project;
    }
    const fromStage = project.status === "failed" ? project.pipeline?.error?.stage : undefined;
    await api(`/api/drama/projects/${project.id}/pipeline`, {
      method: "POST",
      body: JSON.stringify(fromStage ? { fromStage } : {})
    });
    schedulePoll(true);
  } catch (error) {
    toast("流水线启动失败", error.message, "error");
  }
}

async function generateFrame(project, shotId) {
  try {
    await api(`/api/drama/projects/${project.id}/shots/${shotId}/frame`, { method: "POST", body: "{}" });
    schedulePoll(true);
  } catch (error) {
    toast("首帧生成失败", error.message, "error");
  }
}

async function generateAllFrames() {
  const project = state.project;
  if (!project) return;
  for (const shot of project.shots) {
    if (["pending", "failed"].includes(shot.frame.status)) {
      await generateFrame(project, shot.id); // 串行：本机 GPU 一次一镜
    }
  }
}

async function confirmFrame(project, shotId) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}/confirm`, { method: "POST", body: "{}" });
    state.project = data.project;
    renderProject();
  } catch (error) {
    toast("确认失败", error.message, "error");
  }
}

function openGateAModal() {
  const project = state.project;
  if (!project?.budget) return;
  const box = $("#modalBudgetLines");
  box.innerHTML = "";
  for (const line of project.budget.lines) {
    const row = document.createElement("div");
    row.className = "budget-row";
    const label = document.createElement("span");
    label.textContent = line.label;
    const value = document.createElement("b");
    value.textContent = line.kind === "local" ? "¥0（本机）" : `¥${line.subtotal}`;
    row.append(label, value);
    box.append(row);
  }
  $("#modalBudgetTotal").textContent = `¥${project.budget.totalPaid}`;
  $("#gateAModal").classList.add("open");
  $("#gateAModal").setAttribute("aria-hidden", "false");
}

function closeGateAModal() {
  $("#gateAModal").classList.remove("open");
  $("#gateAModal").setAttribute("aria-hidden", "true");
}

async function confirmGateA() {
  const project = state.project;
  if (!project) return;
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/gate-a`, {
      method: "POST",
      body: JSON.stringify({ confirmCost: true })
    });
    state.project = data.project;
    closeGateAModal();
    renderProject();
    toast("预算已确认", "现在可以逐镜生成首帧（本机算力，¥0）");
  } catch (error) {
    closeGateAModal();
    toast("确认失败", error.message, "error");
  }
}

// ---------- 轮询 ----------

function schedulePoll(immediate = false) {
  clearTimeout(state.pollTimer);
  const project = state.project;
  if (!project) return;
  const expectedId = project.id;
  const busy = RUNNING_STATUSES.includes(project.status)
    || project.shots.some((s) => s.frame.status === "generating" || s.clip?.status === "generating");
  if (immediate || busy) {
    state.pollTimer = setTimeout(async () => {
      try {
        const { data } = await api(`/api/drama/projects/${expectedId}`);
        if (state.project?.id !== expectedId) return; // 用户已切换项目，丢弃过期响应
        state.project = data.project;
        renderProject();
      } catch { /* 下一次轮询再试 */ }
      schedulePoll();
    }, immediate ? 0 : 800);
  }
}

// ---------- 事件绑定 ----------

$$(".vz-ic[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#runPipelineBtn").addEventListener("click", runPipeline);
$("#resumeBtn").addEventListener("click", runPipeline);
$("#gateABtn").addEventListener("click", openGateAModal);
$("#gateAConfirm").addEventListener("click", confirmGateA);
$("#gateACancel").addEventListener("click", closeGateAModal);
$("#genAllFramesBtn").addEventListener("click", generateAllFrames);
$("#projectSelect").addEventListener("change", (event) => {
  if (event.target.value) loadProject(event.target.value);
});
$("#newProjectBtn").addEventListener("click", () => {
  state.project = null;
  state.selectedShotId = null;
  localStorage.removeItem("dramaCurrentProjectId");
  $("#projectSelect").value = "";
  $("#dramaTitle").value = "";
  $("#dramaScript").value = "";
  $("#dramaCharCount").textContent = "0 字";
  $("#projectStatus").textContent = "未开始";
  $("#characterList").innerHTML = '<p class="muted">解析后生成</p>';
  $("#budgetLines").innerHTML = '<p class="muted">流水线完成后生成</p>';
  $("#budgetTotal").textContent = "—";
  $("#clipProgress").style.width = "0%";
  $("#clipText").textContent = "0 / 0";
  renderProjHead(null);
  renderStepper();
  renderStory({ shots: [] });
  setView("script");
  showError(null);
});
$("#demoBtn").addEventListener("click", async () => {
  const { data } = await api("/api/drama/demo");
  $("#dramaScript").value = data.script;
  $("#dramaTitle").value = "雨夜便利店";
  $("#dramaCharCount").textContent = `${data.script.replace(/\s/g, "").length} 字`;
});
$("#dramaScript").addEventListener("input", () => {
  $("#dramaCharCount").textContent = `${$("#dramaScript").value.replace(/\s/g, "").length} 字`;
});

async function loadCatalogs() {
  try {
    const [avatars, voices] = await Promise.all([api("/api/avatars"), api("/api/voices")]);
    state.avatars = avatars.data.avatars || [];
    state.voices = (voices.data.voices || []).filter((v) => v.local || v.custom); // 口播镜只支持本地/自定义音色
  } catch { /* 目录加载失败不阻塞页面 */ }
}

renderProjHead(null);
renderStepper();
loadHealth();
loadCatalogs();
loadProjects().catch(() => toast("项目列表加载失败", "请检查本地服务", "error"));

// ---------- M5 合成导出 ----------
async function loadFfmpegStatus() {
  if (!state.project) { state.ffmpegAvailable = null; return null; }
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/compose/ffmpeg`);
    state.ffmpegAvailable = Boolean(data.available);
  } catch { state.ffmpegAvailable = false; }
  return state.ffmpegAvailable;
}

function renderCompose(project) {
  const banner = $("#ffmpegBanner");
  if (banner) banner.classList.toggle("hidden", state.ffmpegAvailable !== false);
  const status = $("#composeStatus");
  const compose = project?.compose || { status: "idle" };
  const notReady = (project?.shots || []).filter((s) => s.clip?.status !== "confirmed");
  const btn = $("#composeBtn");
  if (btn) btn.disabled = !project || state.ffmpegAvailable === false || compose.status === "running" || notReady.length > 0;
  if (!project) status.textContent = "尚未合成";
  else if (compose.status === "running") status.textContent = "正在合成…";
  else if (compose.status === "succeeded") status.textContent = "已合成，可预览导出";
  else if (compose.status === "failed") status.textContent = `合成失败：${compose.error?.message || "未知错误"}（可重试）`;
  else status.textContent = notReady.length ? `还有 ${notReady.length} 个分镜视频未确认` : "就绪，可合成";

  const preview = $("#composePreview");
  const mp4 = $("#exportMp4"); const srt = $("#exportSrt");
  if (preview) preview.innerHTML = "";
  if (compose.status === "succeeded" && compose.file) {
    const v = document.createElement("video");
    v.controls = true;
    v.src = `/drama-files/${project.id}/compose/${compose.file}`;
    if (preview) preview.appendChild(v);
    if (mp4) { mp4.href = v.src; mp4.classList.remove("hidden"); }
    if (srt) {
      if (compose.srtFile) { srt.href = `/drama-files/${project.id}/compose/${compose.srtFile}`; srt.classList.remove("hidden"); }
      else srt.classList.add("hidden");
    }
  } else {
    if (mp4) mp4.classList.add("hidden");
    if (srt) srt.classList.add("hidden");
  }
}

function renderSubtitleEditor(project) {
  const box = $("#subtitleList");
  if (!box) return;
  box.innerHTML = "";
  const talkShots = (project?.shots || []).filter((s) => String(s.dialogue || "").trim());
  if (!talkShots.length) { box.innerHTML = `<p class="muted">暂无台词分镜</p>`; return; }
  let cursor = 0;
  for (const shot of project.shots) {
    const dur = Number(shot.durationSec) || 0;
    if (String(shot.dialogue || "").trim()) {
      const row = document.createElement("div");
      row.className = "vz-sub-row";
      const tm = document.createElement("span"); tm.className = "tm"; tm.textContent = `镜${shot.index} · ${cursor}s–${cursor + dur}s`;
      const input = document.createElement("input"); input.value = shot.dialogue; input.maxLength = 600;
      input.addEventListener("change", () => saveShot(state.project, shot.id, { dialogue: input.value }));
      row.append(tm, input);
      box.appendChild(row);
    }
    cursor += dur;
  }
}

function renderBgm(project) {
  const name = $("#bgmName"); const vol = $("#bgmVolume"); const volVal = $("#bgmVolumeVal");
  if (!name) return;
  const bgm = project?.bgm || null;
  name.textContent = bgm ? bgm.name : "未设置";
  const pct = Math.round((bgm?.volume ?? 0.3) * 100);
  if (vol) vol.value = pct;
  if (volVal) volVal.textContent = `${pct}%`;
}

async function startCompose() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/compose`, { method: "POST", body: "{}" });
    toast("已开始合成", "正在拼接分镜、混音与封装字幕");
    schedulePoll();
  } catch (error) { showError(error.message || error); }
}

async function generateVoice(shotId) {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/shots/${shotId}/voice`, { method: "POST", body: "{}" });
    toast("已开始生成配音", "完成后可在合成时使用");
    schedulePoll();
  } catch (error) { showError(error.message || error); }
}

async function generateAllVoices() {
  const project = state.project;
  if (!project) return;
  const targets = project.shots.filter((s) => s.shotType === "dialogue" && s.audioMode === "voice" && String(s.dialogue || "").trim() && s.clip?.audio?.status !== "ready");
  for (const s of targets) {
    await api(`/api/drama/projects/${project.id}/shots/${s.id}/voice`, { method: "POST", body: "{}" }).catch(() => {});
  }
  if (targets.length) { toast("已排队生成配音", `${targets.length} 个对白镜`); schedulePoll(); }
}

async function uploadBgm(file) {
  if (!state.project || !file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/bgm`, {
      method: "POST",
      body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ""), audioData: dataUrl, volume: Number($("#bgmVolume").value) / 100 })
    });
    state.project = data.project;
    renderBgm(state.project);
    toast("背景音乐已设置", "合成时将混入并闪避到台词下");
  } catch (error) { showError(error.message || error); }
}

// M5 事件绑定
if ($("#composeBtn")) $("#composeBtn").addEventListener("click", startCompose);
if ($("#bgmPick")) $("#bgmPick").addEventListener("click", () => $("#bgmFile").click());
if ($("#bgmFile")) $("#bgmFile").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) uploadBgm(f); e.target.value = ""; });
if ($("#bgmVolume")) $("#bgmVolume").addEventListener("change", (e) => { const el = $("#bgmVolumeVal"); if (el) el.textContent = `${e.target.value}%`; if (state.project?.bgm) toast("音量将在下次合成时生效", "重新合成以应用"); });
