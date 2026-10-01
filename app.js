const storageKey = "wxyy-2-thin-section-index";
const BATCH_FORMAT = "thin-section-batch";
const GUARDED_FIELDS = ["photo", "polarization", "conclusion"];
const PLAIN_FIELDS = ["location", "magnification", "minerals", "texture", "comment"];
const FIELD_LABELS = { photo: "显微照片", code: "样本编号", polarization: "偏光类型", conclusion: "鉴定结论" };
const HISTORY_LIMIT = 300;

/* ---------------- 状态载入与迁移 ---------------- */

function freshState() {
  return {
    version: 2,
    station: "实验室",
    samples: [],
    conflicts: [],
    batches: [],
    compare: [],
    releases: [],
    history: []
  };
}

function migrate(raw) {
  const state = { ...freshState(), ...(raw && typeof raw === "object" ? raw : {}) };
  state.version = 2;
  state.station = state.station || "实验室";
  state.samples = (Array.isArray(state.samples) ? state.samples : []).map((old) => ({
    id: old.id || crypto.randomUUID(),
    code: old.code || "",
    photo: old.photo || "",
    location: old.location || "",
    magnification: old.magnification || "",
    polarization: old.polarization || "单偏光",
    minerals: old.minerals || "",
    texture: old.texture || "",
    conclusion: old.conclusion || "",
    comment: old.comment || "",
    confirmed: Boolean(old.confirmed),
    rev: old.rev || 1,
    createdAt: old.createdAt || new Date().toISOString(),
    updatedAt: old.updatedAt || old.createdAt || new Date().toISOString(),
    base: old.base || null
  }));
  state.conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
  state.batches = Array.isArray(state.batches) ? state.batches : [];
  state.releases = Array.isArray(state.releases) ? state.releases : [];
  state.history = Array.isArray(state.history) ? state.history : [];
  state.compare = Array.isArray(state.compare) ? state.compare : [];
  return state;
}

let state;
try {
  state = migrate(JSON.parse(localStorage.getItem(storageKey) || "null"));
} catch {
  state = freshState();
}

function save() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

/* ---------------- 小工具 ---------------- */

const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const conflictOnly = document.querySelector("#conflictOnly");
const conflictList = document.querySelector("#conflictList");
const conflictCount = document.querySelector("#conflictCount");
const releaseList = document.querySelector("#releaseList");
const historyList = document.querySelector("#historyList");
const overview = document.querySelector("#overview");
const noticeEl = document.querySelector("#notice");
const stationInput = document.querySelector("#stationInput");
const batchFile = document.querySelector("#batchFile");
const submitBtn = document.querySelector("#submitBtn");
const cancelEditBtn = document.querySelector("#cancelEditBtn");
const formTitle = document.querySelector("#formTitle");
const editHint = document.querySelector("#editHint");

let pendingPhoto = "";
let editingId = null;
let noticeTimer = null;

const nowISO = () => new Date().toISOString();
const findSample = (id) => state.samples.find((s) => s.id === id);
const hasConflict = (sampleId) => state.conflicts.some((c) => c.sampleId === sampleId);
const validReleaseOf = (sampleId) => state.releases.find((r) => r.sampleId === sampleId && r.valid);
const guardedSnapshot = (s) => ({ photo: s.photo || "", polarization: s.polarization || "", conclusion: s.conclusion || "" });

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
}

function log(text) {
  state.history.unshift({ at: nowISO(), text });
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
}

function notice(msg, kind = "ok") {
  noticeEl.textContent = msg;
  noticeEl.className = `notice show ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.className = "notice"; }, 9000);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
}

function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------------- 级联失效与字段写入 ---------------- */

// 样本编号或偏光一旦变化：相关对比立即移除、有效放行立即作废
function invalidateDependents(sample, origin) {
  if (state.compare.includes(sample.id)) {
    state.compare = state.compare.filter((id) => id !== sample.id);
    log(`「${sample.code}」的样本编号或偏光发生变化（${origin}），已退出并排对比`);
  }
  state.releases.forEach((rel) => {
    if (rel.sampleId === sample.id && rel.valid) {
      rel.valid = false;
      rel.invalidatedAt = nowISO();
      log(`放行失效：「${rel.code} · ${rel.polarization}」因样本编号或偏光变化（${origin}）立即作废`);
    }
  });
}

// 所有受管字段（照片/偏光/结论/编号）的唯一写入口，保证副作用一致
function setGuarded(sample, field, value, origin) {
  const next = value ?? "";
  if ((sample[field] ?? "") === next) return false;
  sample[field] = next;
  sample.rev = (sample.rev || 1) + 1;
  sample.updatedAt = nowISO();
  if (field === "conclusion" && sample.confirmed) {
    sample.confirmed = false;
    log(`「${sample.code}」的鉴定结论被${origin}修改，已确认状态随之清除`);
  }
  if (field === "code" || field === "polarization") {
    invalidateDependents(sample, origin);
  }
  return true;
}

/* ---------------- 批次合并 ---------------- */

function raiseConflict(sample, field, fieldValue, meta) {
  const existing = state.conflicts.find((c) => c.sampleId === sample.id && c.field === field);
  if (existing) {
    existing.fieldValue = fieldValue;
    existing.labValue = sample[field] ?? "";
    existing.batchId = meta.id;
    existing.source = meta.source;
    existing.createdAt = nowISO();
  } else {
    state.conflicts.push({
      id: crypto.randomUUID(),
      sampleId: sample.id,
      code: sample.code,
      field,
      labValue: sample[field] ?? "",
      fieldValue,
      source: meta.source,
      batchId: meta.id,
      createdAt: nowISO()
    });
  }
  // 未裁决前不能留在对比里
  if (state.compare.includes(sample.id)) {
    state.compare = state.compare.filter((id) => id !== sample.id);
    log(`「${sample.code}」出现待裁决冲突，已退出并排对比`);
  }
}

function mergeRecord(rec, meta, result) {
  const code = String(rec.code || "").trim();
  const lab = state.samples.find((s) => s.code === code);
  if (!lab) {
    const sample = {
      id: crypto.randomUUID(),
      code,
      photo: rec.photo || "",
      location: rec.location || "",
      magnification: rec.magnification || "",
      polarization: rec.polarization || "单偏光",
      minerals: rec.minerals || "",
      texture: rec.texture || "",
      conclusion: rec.conclusion || "",
      comment: rec.comment || "",
      confirmed: false,
      rev: 1,
      createdAt: nowISO(),
      updatedAt: rec.updatedAt || nowISO(),
      base: null
    };
    sample.base = guardedSnapshot(sample);
    state.samples.unshift(sample);
    result.added += 1;
    return;
  }

  const base = rec.base && typeof rec.base === "object" ? rec.base : null;
  let applied = false;
  let conflicted = false;
  let held = false;

  GUARDED_FIELDS.forEach((field) => {
    const incoming = rec[field] ?? "";
    const current = lab[field] ?? "";
    if (incoming === current) return;
    const baseVal = base ? base[field] ?? "" : undefined;
    const fieldChanged = base ? incoming !== baseVal : true;
    const labChanged = base ? current !== baseVal : true;

    // 实验室已确认的结论不能被现场稿覆盖，转入裁决
    if (field === "conclusion" && lab.confirmed) {
      raiseConflict(lab, field, incoming, meta);
      conflicted = true;
      held = true;
      return;
    }
    if (fieldChanged && labChanged) {
      // 两边都动过：保留两份候选，等待裁决
      raiseConflict(lab, field, incoming, meta);
      conflicted = true;
    } else if (fieldChanged) {
      if (setGuarded(lab, field, incoming, `批次「${meta.source}」`)) applied = true;
    }
    // 仅实验室动过：保留实验室稿
  });

  PLAIN_FIELDS.forEach((field) => {
    const incoming = rec[field] ?? "";
    if (incoming === (lab[field] ?? "")) return;
    const baseVal = base ? base[field] ?? "" : undefined;
    if (!base || incoming !== baseVal) {
      lab[field] = incoming;
      applied = true;
    }
  });

  lab.base = guardedSnapshot(lab);
  if (applied) {
    lab.rev = (lab.rev || 1) + 1;
    lab.updatedAt = nowISO();
  }
  if (conflicted) {
    result.conflicted += 1;
    if (held) result.held += 1;
  } else if (applied) {
    result.merged += 1;
  } else {
    result.skipped += 1;
  }
}

function validateBatch(batch) {
  if (!batch || typeof batch !== "object") throw new Error("文件不是有效的批次");
  if (batch.format !== BATCH_FORMAT) throw new Error("文件格式不是野外批次（缺少 format 标识）");
  if (!batch.id) throw new Error("批次缺少编号");
  if (!Array.isArray(batch.samples)) throw new Error("批次缺少样本列表");
  batch.samples.forEach((rec, i) => {
    if (!rec || !String(rec.code || "").trim()) throw new Error(`第 ${i + 1} 条记录缺少样本编号`);
  });
}

function importBatch(batch) {
  // 重复导入同一批次：沿用第一次结果，不再套用
  const prior = state.batches.find((b) => b.id === batch.id);
  if (prior) {
    log(`批次「${batch.id}」重复导入，沿用首次结果（新增${prior.result.added} · 合并${prior.result.merged} · 待裁决${prior.result.conflicted} · 无变化${prior.result.skipped}）`);
    return { reused: true, result: prior.result };
  }
  validateBatch(batch); // 失败即抛错，不落任何改动，可按原批次重试
  const meta = { id: batch.id, source: batch.source || "未知队伍" };
  const result = { added: 0, merged: 0, conflicted: 0, held: 0, skipped: 0 };
  batch.samples.forEach((rec) => mergeRecord(rec, meta, result));
  state.batches.push({
    id: batch.id,
    source: meta.source,
    createdAt: batch.createdAt || nowISO(),
    importedAt: nowISO(),
    result
  });
  const heldNote = result.held ? `（含确认保护 ${result.held} 条）` : "";
  log(`批次「${meta.source} / ${batch.id}」导入完成：新增${result.added} · 合并${result.merged} · 待裁决${result.conflicted}${heldNote} · 无变化${result.skipped}`);
  return { reused: false, result };
}

/* ---------------- 启动一致性校正 ---------------- */

function reconcile() {
  state.compare = state.compare.filter((id) => findSample(id) && !hasConflict(id));
  state.conflicts = state.conflicts.filter((c) => findSample(c.sampleId));
  state.releases.forEach((rel) => {
    if (rel.valid && !findSample(rel.sampleId)) {
      rel.valid = false;
      rel.invalidatedAt = rel.invalidatedAt || nowISO();
    }
  });
}

/* ---------------- 渲染 ---------------- */

function filteredSamples() {
  const mineral = mineralFilter.value.trim();
  const polarization = polarFilter.value;
  const onlyConflict = conflictOnly.checked;
  return state.samples.filter((sample) => {
    const mineralMatch = !mineral || sample.minerals.includes(mineral);
    const polarMatch = !polarization || sample.polarization === polarization;
    const conflictMatch = !onlyConflict || hasConflict(sample.id);
    return mineralMatch && polarMatch && conflictMatch;
  });
}

function renderOverview() {
  const conflictedIds = new Set(state.conflicts.map((c) => c.sampleId));
  const exportable = state.samples.filter((s) => !conflictedIds.has(s.id)).length;
  const confirmed = state.samples.filter((s) => s.confirmed).length;
  const validReleases = state.releases.filter((r) => r.valid).length;
  const invalidReleases = state.releases.length - validReleases;
  const stats = [
    [state.samples.length, "样本总数", ""],
    [exportable, "可导出", ""],
    [state.conflicts.length, "待裁决冲突", state.conflicts.length ? "warn" : ""],
    [confirmed, "已确认结论", ""],
    [validReleases, "有效放行", ""],
    [invalidReleases, "放行已失效", invalidReleases ? "warn" : ""],
    [state.batches.length, "已导入批次", ""]
  ];
  overview.innerHTML = stats.map(([num, label, cls]) =>
    `<div class="stat ${cls}"><b>${num}</b><span>${label}</span></div>`
  ).join("");
}

function renderGrid() {
  const rows = filteredSamples();
  sampleGrid.innerHTML = rows.length ? rows.map((sample) => {
    const conflicted = hasConflict(sample.id);
    const rel = validReleaseOf(sample.id);
    const invalidRel = !rel && state.releases.some((r) => r.sampleId === sample.id && !r.valid);
    const checked = state.compare.includes(sample.id) ? "checked" : "";
    return `
    <article class="sample-card ${conflicted ? "is-conflicted" : ""}">
      ${sample.photo ? `<img src="${esc(sample.photo)}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
      <div class="sample-body">
        <h3>${esc(sample.code)}</h3>
        <div class="badges">
          ${conflicted ? '<span class="badge warn">待裁决</span>' : ""}
          ${sample.confirmed ? '<span class="badge ok">结论已确认</span>' : ""}
          ${rel ? '<span class="badge accent">已放行</span>' : ""}
          ${invalidRel ? '<span class="badge mute">放行已失效</span>' : ""}
        </div>
        <p>${esc(sample.location) || "未记录地点"} · ${esc(sample.magnification) || "未记录倍数"} · ${esc(sample.polarization)}</p>
        <p>矿物：${esc(sample.minerals) || "未记录"}</p>
        <p>结构：${esc(sample.texture) || "未记录"}</p>
        <p>鉴定结论：${esc(sample.conclusion) || "未填写"}${sample.confirmed ? "（已确认）" : ""}</p>
        <p>${esc(sample.comment) || "未填写批注"}</p>
        <div class="card-actions">
          <label title="${conflicted ? "待裁决样本不能进入对比" : ""}">
            <input type="checkbox" data-compare="${sample.id}" ${checked} ${conflicted ? "disabled" : ""}>对比
          </label>
          <button type="button" class="mini" data-edit="${sample.id}">编辑</button>
          <button type="button" class="mini" data-confirm="${sample.id}"
            ${sample.confirmed || !sample.conclusion ? "disabled" : ""}
            title="${!sample.conclusion ? "先填写鉴定结论" : sample.confirmed ? "结论已确认" : "确认后现场稿不能覆盖该结论"}">
            ${sample.confirmed ? "已确认" : "确认结论"}
          </button>
          <button type="button" class="mini accent" data-release="${sample.id}"
            ${conflicted || rel ? "disabled" : ""}
            title="${conflicted ? "待裁决样本不能放行" : rel ? "已有有效放行" : "按当前编号与偏光放行"}">
            ${rel ? "已放行" : "放行"}
          </button>
          <button type="button" class="mini danger" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>`;
  }).join("") : '<p class="empty-tip">还没有样本，先从左侧录入一张薄片照片，或导入野外批次。</p>';
}

function renderConflicts() {
  conflictCount.textContent = state.conflicts.length || "";
  conflictList.innerHTML = state.conflicts.length ? state.conflicts.map((c) => {
    const sample = findSample(c.sampleId);
    const labVal = sample ? sample[c.field] ?? "" : c.labValue;
    const isPhoto = c.field === "photo";
    const candidate = (label, value, side, btnText, btnClass) => `
      <div class="candidate">
        <p>${label}</p>
        ${isPhoto
          ? (value ? `<img src="${esc(value)}" alt="${label}">` : '<p class="val">（无照片）</p>')
          : `<p class="val">${esc(value) || "（空）"}</p>`}
        <button type="button" class="mini ${btnClass}" data-resolve="${side}" data-id="${c.id}">${btnText}</button>
      </div>`;
    return `
    <div class="conflict-card">
      <header><strong>${esc(c.code)}</strong><span class="badge warn">${FIELD_LABELS[c.field] || c.field}</span></header>
      <p class="conflict-meta">野外稿来自「${esc(c.source)}」· ${fmtTime(c.createdAt)}</p>
      <div class="candidates">
        ${candidate("实验室当前", labVal, "lab", "保留实验室稿", "")}
        ${candidate(`野外稿 · ${esc(c.source)}`, c.fieldValue, "field", "采用野外稿", "accent")}
      </div>
    </div>`;
  }).join("") : '<p class="empty-tip">没有待裁决的冲突。</p>';
}

function renderCompare() {
  const compareSamples = state.compare
    .map((id) => findSample(id))
    .filter((s) => s && !hasConflict(s.id))
    .slice(0, 2);
  comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
    <article class="compare-item">
      ${sample.photo ? `<img src="${esc(sample.photo)}" alt="${esc(sample.code)}对比图">` : ""}
      <h3>${esc(sample.code)}</h3>
      <p>${esc(sample.polarization)} · ${esc(sample.minerals) || "未记录矿物"}</p>
      <p>${esc(sample.texture) || "未记录结构"}</p>
      <p>鉴定结论：${esc(sample.conclusion) || "未填写"}</p>
    </article>
  `).join("") : '<p class="empty-tip">勾选两张样本卡片后可并排对比；待裁决样本不能进入对比。</p>';
}

function renderReleases() {
  releaseList.innerHTML = state.releases.length ? state.releases.map((rel) => `
    <li class="${rel.valid ? "" : "is-invalid"}">
      <span class="badge ${rel.valid ? "accent" : "mute"}">${rel.valid ? "有效" : "已失效"}</span>
      <div>
        <strong>${esc(rel.code)}</strong> · ${esc(rel.polarization)}${rel.note ? ` · ${esc(rel.note)}` : ""}<br>
        <time>${fmtTime(rel.createdAt)}${rel.valid ? "" : ` → 失效于 ${fmtTime(rel.invalidatedAt)}`}</time>
      </div>
    </li>
  `).join("") : '<p class="empty-tip">还没有放行记录。</p>';
}

function renderHistory() {
  historyList.innerHTML = state.history.length ? state.history.map((entry) =>
    `<li><time>${fmtTime(entry.at)}</time><span>${esc(entry.text)}</span></li>`
  ).join("") : '<p class="empty-tip">暂无履历。</p>';
}

function render() {
  renderOverview();
  renderGrid();
  renderConflicts();
  renderCompare();
  renderReleases();
  renderHistory();
}

/* ---------------- 表单：录入与编辑 ---------------- */

function resetFormMode() {
  editingId = null;
  pendingPhoto = "";
  photoInput.value = "";
  form.reset();
  formTitle.textContent = "样本录入";
  submitBtn.textContent = "保存样本";
  cancelEditBtn.hidden = true;
  editHint.hidden = true;
}

function startEdit(id) {
  const sample = findSample(id);
  if (!sample) return;
  editingId = id;
  pendingPhoto = "";
  photoInput.value = "";
  const els = form.elements;
  els.code.value = sample.code;
  els.location.value = sample.location;
  els.magnification.value = sample.magnification;
  els.polarization.value = sample.polarization;
  els.minerals.value = sample.minerals;
  els.texture.value = sample.texture;
  els.conclusion.value = sample.conclusion;
  els.comment.value = sample.comment;
  formTitle.textContent = `编辑样本 · ${sample.code}`;
  submitBtn.textContent = "保存修改";
  cancelEditBtn.hidden = false;
  editHint.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

photoInput.addEventListener("change", async () => {
  pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  if (!pendingPhoto && photoInput.files[0]) {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  }
  const fields = {
    code: data.get("code").trim(),
    location: data.get("location").trim(),
    magnification: data.get("magnification").trim(),
    polarization: data.get("polarization"),
    minerals: data.get("minerals").trim(),
    texture: data.get("texture").trim(),
    conclusion: data.get("conclusion").trim(),
    comment: data.get("comment").trim()
  };
  if (!fields.code) return;

  if (editingId) {
    const sample = findSample(editingId);
    if (!sample) { resetFormMode(); return; }
    if (state.samples.some((s) => s.code === fields.code && s.id !== sample.id)) {
      notice(`样本编号 ${fields.code} 已被其他样本占用`, "err");
      return;
    }
    setGuarded(sample, "code", fields.code, "实验室编辑");
    setGuarded(sample, "polarization", fields.polarization, "实验室编辑");
    setGuarded(sample, "conclusion", fields.conclusion, "实验室编辑");
    if (pendingPhoto) setGuarded(sample, "photo", pendingPhoto, "实验室编辑");
    PLAIN_FIELDS.forEach((f) => { sample[f] = fields[f]; });
    sample.updatedAt = nowISO();
    log(`更新样本「${sample.code}」`);
  } else {
    if (state.samples.some((s) => s.code === fields.code)) {
      notice(`样本编号 ${fields.code} 已存在，请使用卡片上的「编辑」`, "err");
      return;
    }
    state.samples.unshift({
      id: crypto.randomUUID(),
      photo: pendingPhoto,
      ...fields,
      confirmed: false,
      rev: 1,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      base: null
    });
    log(`录入样本「${fields.code}」`);
  }
  resetFormMode();
  save();
  render();
});

cancelEditBtn.addEventListener("click", resetFormMode);

/* ---------------- 卡片操作 ---------------- */

sampleGrid.addEventListener("click", (event) => {
  const editBtn = event.target.closest("[data-edit]");
  const confirmBtn = event.target.closest("[data-confirm]");
  const releaseBtn = event.target.closest("[data-release]");
  const deleteBtn = event.target.closest("[data-delete]");

  if (editBtn) {
    startEdit(editBtn.dataset.edit);
    return;
  }

  if (confirmBtn) {
    const sample = findSample(confirmBtn.dataset.confirm);
    if (!sample || sample.confirmed || !sample.conclusion) return;
    sample.confirmed = true;
    sample.updatedAt = nowISO();
    log(`确认鉴定结论：「${sample.code}」${sample.conclusion}（现场稿将不再覆盖该结论）`);
    save();
    render();
    return;
  }

  if (releaseBtn) {
    const sample = findSample(releaseBtn.dataset.release);
    if (!sample || hasConflict(sample.id) || validReleaseOf(sample.id)) return;
    const note = prompt("放行备注（可留空）", "");
    if (note === null) return;
    state.releases.unshift({
      id: crypto.randomUUID(),
      sampleId: sample.id,
      code: sample.code,
      polarization: sample.polarization,
      note: note.trim(),
      createdAt: nowISO(),
      valid: true,
      invalidatedAt: null
    });
    log(`放行「${sample.code} · ${sample.polarization}」${note.trim() ? `：${note.trim()}` : ""}`);
    save();
    render();
    return;
  }

  if (deleteBtn) {
    const sample = findSample(deleteBtn.dataset.delete);
    if (!sample) return;
    state.samples = state.samples.filter((s) => s.id !== sample.id);
    state.compare = state.compare.filter((id) => id !== sample.id);
    state.conflicts = state.conflicts.filter((c) => c.sampleId !== sample.id);
    state.releases.forEach((rel) => {
      if (rel.sampleId === sample.id && rel.valid) {
        rel.valid = false;
        rel.invalidatedAt = nowISO();
      }
    });
    if (editingId === sample.id) resetFormMode();
    log(`删除样本「${sample.code}」，其对比、待裁决冲突与放行一并清理`);
    save();
    render();
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  if (event.target.checked) {
    if (hasConflict(id)) { render(); return; } // 待裁决样本不能进入对比
    state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, 2);
  } else {
    state.compare = state.compare.filter((item) => item !== id);
  }
  save();
  render();
});

/* ---------------- 冲突裁决 ---------------- */

conflictList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-resolve]");
  if (!btn) return;
  const conflict = state.conflicts.find((c) => c.id === btn.dataset.id);
  if (!conflict) return;
  const sample = findSample(conflict.sampleId);
  const side = btn.dataset.resolve;
  if (sample && side === "field") {
    setGuarded(sample, conflict.field, conflict.fieldValue, `裁决采用「${conflict.source}」野外稿`);
  }
  state.conflicts = state.conflicts.filter((c) => c.id !== conflict.id);
  log(`裁决「${conflict.code}」的${FIELD_LABELS[conflict.field] || conflict.field}：${side === "field" ? `采用野外稿（${conflict.source}）` : "保留实验室稿"}`);
  save();
  render();
});

/* ---------------- 批次导入导出与清单导出 ---------------- */

document.querySelector("#importBtn").addEventListener("click", () => batchFile.click());

batchFile.addEventListener("change", async () => {
  const file = batchFile.files[0];
  batchFile.value = "";
  if (!file) return;
  try {
    const batch = JSON.parse(await file.text());
    const outcome = importBatch(batch);
    save();
    render();
    const r = outcome.result;
    const summary = `新增${r.added} · 合并${r.merged} · 待裁决${r.conflicted} · 无变化${r.skipped}`;
    notice(outcome.reused ? `该批次已导入过，沿用首次结果：${summary}` : `批次导入完成：${summary}`, "ok");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`批次导入失败：${msg}；未做任何改动，可按原批次重试`);
    save();
    render();
    notice(`批次导入失败：${msg}。未做任何改动，可按原批次重试。`, "err");
  }
});

document.querySelector("#exportBatchBtn").addEventListener("click", () => {
  const batch = {
    format: BATCH_FORMAT,
    version: 2,
    id: crypto.randomUUID(),
    source: state.station || "未命名队伍",
    createdAt: nowISO(),
    samples: state.samples.map((s) => ({
      code: s.code,
      photo: s.photo,
      location: s.location,
      magnification: s.magnification,
      polarization: s.polarization,
      minerals: s.minerals,
      texture: s.texture,
      conclusion: s.conclusion,
      comment: s.comment,
      updatedAt: s.updatedAt,
      base: s.base || null
    }))
  };
  const date = batch.createdAt.slice(0, 10);
  const team = (batch.source || "team").replace(/[\\/:*?"<>|\s]+/g, "-");
  downloadJSON(batch, `field-batch-${team}-${date}.json`);
  log(`导出野外批次「${batch.id}」：共${batch.samples.length}条，送往实验室合并`);
  save();
  render();
  notice(`已导出野外批次（${batch.samples.length}条），批次号 ${batch.id.slice(0, 8)}…`, "ok");
});

document.querySelector("#exportBtn").addEventListener("click", () => {
  const blocked = state.samples.filter((s) => hasConflict(s.id));
  const exportable = state.samples.filter((s) => !hasConflict(s.id));
  const payload = {
    导出时间: nowISO(),
    台站: state.station,
    样本总数: state.samples.length,
    本次导出: exportable.length,
    待裁决未导出: blocked.length,
    清单: exportable.map((s) => {
      const rel = validReleaseOf(s.id);
      return {
        样本编号: s.code,
        采样地点: s.location,
        放大倍数: s.magnification,
        偏光类型: s.polarization,
        主要矿物: s.minerals,
        颗粒结构: s.texture,
        鉴定结论: s.conclusion,
        结论状态: s.confirmed ? "已确认" : "草稿",
        老师批注: s.comment,
        放行状态: rel ? "已放行" : "未放行",
        放行时间: rel ? rel.createdAt : ""
      };
    })
  };
  downloadJSON(payload, "thin-section-checklist.json");
  log(`导出观察清单：${exportable.length}条（${blocked.length}条待裁决未导出）`);
  save();
  render();
});

/* ---------------- 其余事件 ---------------- */

stationInput.addEventListener("input", () => {
  state.station = stationInput.value.trim() || "实验室";
  save();
});

[mineralFilter, polarFilter, conflictOnly].forEach((field) => field.addEventListener("input", render));

/* ---------------- 启动 ---------------- */

reconcile();
stationInput.value = state.station;
save();
render();
