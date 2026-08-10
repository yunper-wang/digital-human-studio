const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  project: null,
  projects: [],
  avatars: [],
  voices: [],
  pollTimer: null
};

const RUNNING_STATUSES = ["analyzing", "directing", "prompting", "reviewing"];
const STAGE_ORDER = ["analyze", "direct", "prompt", "review"];
const STATUS_LABEL = {
  draft: "草稿", analyzing: "剧本分析中", directing: "导演分镜中", prompting: "提示词生成中",
  reviewing: "审核中", awaiting_gate_a: "待确认预算", review_blocked: "审核未通过",
  failed: "流水线失败", frames: "首帧生成中", awaiting_gate_b: "待确认首帧", frames_confirmed: "首帧已确认",
  videos: "视频生成中", clips_ready: "全部视频已确认",
};

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
  node.querySelector("small").textContent = label;
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

// ---------- 渲染 ----------

function renderProject() {
  const project = state.project;
  if (!project) return;
  showError(null);
  $("#dramaTitle").value = project.title;
  if (document.activeElement !== $("#dramaScript")) $("#dramaScript").value = project.script;
  $("#dramaCharCount").textContent = `${project.script.replace(/\s/g, "").length} 字`;
  $("#projectStatus").textContent = STATUS_LABEL[project.status] || project.status;
  $("#shotCountBadge").textContent = project.shots.length || "—";
  renderStages(project);
  renderCharacters(project);
  if (!$("#shotList").contains(document.activeElement)) renderShots(project);
  renderBudget(project);
  renderGateB(project);
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

function renderShots(project) {
  const box = $("#shotList");
  box.innerHTML = "";
  if (!project.shots.length) {
    box.innerHTML = '<p class="muted">运行流水线后展示分镜</p>';
    return;
  }
  for (const shot of project.shots) {
    box.append(buildShotCard(project, shot));
  }
}

function buildShotCard(project, shot) {
  const card = document.createElement("article");
  card.className = "shot-card";
  card.dataset.shotId = shot.id;

  const head = document.createElement("div");
  head.className = "shot-head";
  const title = document.createElement("b");
  title.textContent = `镜 ${shot.index} · ${shot.sceneName}`;
  const badge = document.createElement("span");
  badge.className = `badge ${shot.shotType}`;
  badge.textContent = shot.shotType === "dialogue" ? "口播镜" : "剧情镜";
  const meta = document.createElement("small");
  meta.textContent = `${shot.camera} · ${shot.durationSec}s · ${shot.emotion}`;
  head.append(title, badge, meta);

  const dialogue = document.createElement("textarea");
  dialogue.className = "shot-dialogue";
  dialogue.value = shot.dialogue;
  dialogue.placeholder = "台词（口播镜必填）";
  dialogue.disabled = !isEditable(project);
  dialogue.addEventListener("change", () => saveShot(project, shot.id, { dialogue: dialogue.value }));

  const action = document.createElement("textarea");
  action.className = "shot-action";
  action.value = shot.action;
  action.placeholder = "画面描述";
  action.disabled = !isEditable(project);
  action.addEventListener("change", () => saveShot(project, shot.id, { action: action.value }));

  const prompt = document.createElement("textarea");
  prompt.className = "shot-prompt";
  prompt.value = shot.fluxPrompt;
  prompt.placeholder = "Flux 首帧提示词";
  prompt.disabled = !isEditable(project);
  prompt.addEventListener("change", () => saveShot(project, shot.id, { fluxPrompt: prompt.value }));

  const frameBox = document.createElement("div");
  frameBox.className = "shot-frame";
  const url = frameUrl(project, shot);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `镜 ${shot.index} 首帧`;
    frameBox.append(img);
  } else {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = frameStatusText(shot);
    frameBox.append(empty);
  }

  const actions = document.createElement("div");
  actions.className = "shot-actions";
  const genBtn = document.createElement("button");
  genBtn.className = "mini-btn";
  genBtn.textContent = shot.frame.status === "ready" || shot.frame.status === "confirmed" ? "换抽" : "生成首帧";
  genBtn.disabled = !project.gateAConfirmedAt || shot.frame.status === "generating";
  genBtn.addEventListener("click", () => generateFrame(project, shot.id));
  actions.append(genBtn);
  if (shot.frame.status === "ready") {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "mini-btn primary-mini";
    confirmBtn.textContent = "确认首帧";
    confirmBtn.addEventListener("click", () => confirmFrame(project, shot.id));
    actions.append(confirmBtn);
  }
  if (shot.frame.status === "confirmed") {
    const tag = document.createElement("span");
    tag.className = "badge confirmed";
    tag.textContent = "已确认";
    actions.append(tag);
  }
  if (shot.frame.status === "failed") {
    const error = document.createElement("small");
    error.className = "error-text";
    error.textContent = shot.frame.error?.message || "生成失败";
    actions.append(error);
  }

  const clipBox = document.createElement("div");
  clipBox.className = "shot-clip";
  const clip = shot.clip || { status: "pending" };
  if (clip.file) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = `/drama-files/${project.id}/${clip.file}`;
    clipBox.append(video);
  }
  const clipActions = document.createElement("div");
  clipActions.className = "shot-actions";
  const videoBtn = document.createElement("button");
  videoBtn.className = "mini-btn";
  videoBtn.textContent = ["ready", "confirmed"].includes(clip.status) ? "重新生成视频" : "生成视频";
  videoBtn.disabled = !canGenerateVideo(project, shot) || clip.status === "generating";
  videoBtn.title = videoBlockReason(project, shot);
  videoBtn.addEventListener("click", () => generateVideo(project, shot));
  clipActions.append(videoBtn);
  if (clip.status === "generating") {
    const busy = document.createElement("small");
    busy.className = "muted";
    busy.textContent = "视频生成中…";
    clipActions.append(busy);
  }
  if (clip.status === "ready") {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "mini-btn primary-mini";
    confirmBtn.textContent = "确认视频";
    confirmBtn.addEventListener("click", () => confirmVideo(project, shot.id));
    clipActions.append(confirmBtn);
  }
  if (clip.status === "confirmed") {
    const tag = document.createElement("span");
    tag.className = "badge confirmed";
    tag.textContent = "视频已确认";
    clipActions.append(tag);
  }
  if (clip.status === "failed") {
    const error = document.createElement("small");
    error.className = "error-text";
    error.textContent = clip.error?.message || "视频生成失败";
    clipActions.append(error);
  }
  clipBox.append(clipActions);

  card.append(head, dialogue, action, prompt, frameBox, actions, clipBox);
  return card;
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
    $("#doneBanner").textContent = "全部视频已确认，M3 流程完成。时间线合成导出属于 M4。";
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
  localStorage.removeItem("dramaCurrentProjectId");
  $("#projectSelect").value = "";
  $("#dramaTitle").value = "";
  $("#dramaScript").value = "";
  $("#dramaCharCount").textContent = "0 字";
  $("#projectStatus").textContent = "未开始";
  $("#shotList").innerHTML = '<p class="muted">运行流水线后展示分镜</p>';
  $("#characterList").innerHTML = '<p class="muted">解析后生成</p>';
  $("#budgetLines").innerHTML = '<p class="muted">流水线完成后生成</p>';
  $("#budgetTotal").textContent = "—";
  $("#shotCountBadge").textContent = "—";
  $("#clipProgress").style.width = "0%";
  $("#clipText").textContent = "0 / 0";
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
$$("[data-anchor]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

async function loadCatalogs() {
  try {
    const [avatars, voices] = await Promise.all([api("/api/avatars"), api("/api/voices")]);
    state.avatars = avatars.data.avatars || [];
    state.voices = (voices.data.voices || []).filter((v) => v.local || v.custom); // 口播镜只支持本地/自定义音色
  } catch { /* 目录加载失败不阻塞页面 */ }
}

loadHealth();
loadCatalogs();
loadProjects().catch(() => toast("项目列表加载失败", "请检查本地服务", "error"));
