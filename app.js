const storageKey = "wxyy-2-thin-section-index";

const KEY_FIELDS = ["photo", "polarization", "minerals", "texture", "comment"];
const PLAIN_FIELDS = ["location", "magnification"];
const ALL_FIELDS = ["code", ...PLAIN_FIELDS, ...KEY_FIELDS];

const defaultState = () => ({
  samples: [],
  compare: [],
  batches: {},
  history: [],
  pendingImport: null
});

let state;
try {
  state = JSON.parse(localStorage.getItem(storageKey)) || defaultState();
} catch {
  state = defaultState();
}
state.samples ??= [];
state.compare ??= [];
state.batches ??= {};
state.history ??= [];
state.pendingImport ??= null;

const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const statsBar = document.querySelector("#statsBar");
const historyList = document.querySelector("#historyList");
const exportBtn = document.querySelector("#exportBtn");
const batchInput = document.querySelector("#batchInput");
const importBtn = document.querySelector("#importBtn");
const templateBtn = document.querySelector("#templateBtn");
const importStatus = document.querySelector("#importStatus");
const submitBtn = document.querySelector("#submitBtn");
const cancelEditBtn = document.querySelector("#cancelEditBtn");
const adjudicateDialog = document.querySelector("#adjudicateDialog");
const closeDialogBtn = document.querySelector("#closeDialogBtn");
const candidateGrid = document.querySelector("#candidateGrid");
const dialogSub = document.querySelector("#dialogSub");

let pendingPhoto = "";
let adjudicateId = null;

function save() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function saveOrReport() {
  try {
    save();
    return true;
  } catch {
    return false;
  }
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function addHistory(type, text) {
  state.history.unshift({ id: uid(), at: now(), type, text });
  if (state.history.length > 300) state.history.length = 300;
}

function snapshot(sample) {
  const s = {};
  for (const f of ALL_FIELDS) s[f] = sample[f] ?? "";
  return s;
}

function makeSample(fields, extra = {}) {
  return {
    id: uid(),
    code: fields.code ?? "",
    photo: fields.photo ?? "",
    location: fields.location ?? "",
    magnification: fields.magnification ?? "",
    polarization: fields.polarization ?? "单偏光",
    minerals: fields.minerals ?? "",
    texture: fields.texture ?? "",
    comment: fields.comment ?? "",
    source: extra.source ?? "lab",
    confirmed: extra.confirmed ?? false,
    released: false,
    candidates: null,
    createdAt: now(),
    updatedAt: now()
  };
}

function canCompare(sample) {
  return !!sample && !sample.candidates && !!sample.confirmed;
}

// 样本编号或偏光变化后，依赖它的对比与放行结论立即失效。
function invalidateDependencies(sample, reasonLabel) {
  const affected = [];
  if (state.compare.includes(sample.id)) {
    state.compare = state.compare.filter((id) => id !== sample.id);
    affected.push("对比");
  }
  if (sample.released) {
    sample.released = false;
    affected.push("放行");
  }
  if (affected.length) {
    addHistory("invalidate", `${sample.code} ${reasonLabel}，依赖它的${affected.join("、")}结论已失效，请重新${affected.join("、")}`);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
}

function filteredSamples() {
  const mineral = mineralFilter.value.trim();
  const polarization = polarFilter.value;
  return state.samples.filter((sample) => {
    const mineralMatch = !mineral || sample.minerals.includes(mineral);
    const polarMatch = !polarization || sample.polarization === polarization;
    return mineralMatch && polarMatch;
  });
}

function statusBadge(sample) {
  if (sample.candidates) return `<span class="badge badge-pending">待裁决</span>`;
  if (!sample.confirmed) return `<span class="badge badge-draft">现场稿</span>`;
  if (sample.released) return `<span class="badge badge-released">已放行</span>`;
  return `<span class="badge badge-confirmed">已确认</span>`;
}

function cardHtml(sample) {
  const pending = !!sample.candidates;
  const comparable = canCompare(sample);
  return `
    <article class="sample-card ${pending ? "card-pending" : ""}">
      <div class="card-media">
        ${sample.photo ? `<img src="${sample.photo}" alt="${sample.code}显微照片">` : `<div class="photo-placeholder"></div>`}
        ${statusBadge(sample)}
      </div>
      <div class="sample-body">
        <h3>${sample.code}</h3>
        <p>${sample.location || "未记录地点"} · ${sample.magnification || "未记录倍数"} · ${sample.polarization}</p>
        <p>矿物：${sample.minerals || "未记录"}</p>
        <p>结构：${sample.texture || "未记录"}</p>
        <p>${sample.comment || "未填写批注"}</p>
        ${pending ? `<p class="pending-note">存在两份候选，裁决前不可对比、不可导出。</p>` : ""}
        <div class="card-actions">
          <label class="${comparable ? "" : "disabled"}" title="${comparable ? "" : "未裁决或未确认，不能对比"}">
            <input type="checkbox" data-compare="${sample.id}" ${state.compare.includes(sample.id) ? "checked" : ""} ${comparable ? "" : "disabled"}>对比
          </label>
          ${sample.confirmed && !pending ? `<button type="button" data-release="${sample.id}" class="${sample.released ? "btn-released" : ""}">${sample.released ? "已放行" : "放行"}</button>` : ""}
          ${pending ? `<button type="button" data-adjudicate="${sample.id}" class="btn-adjudicate">裁决</button>` : ""}
          <button type="button" data-edit="${sample.id}">编辑</button>
          <button type="button" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>`;
}

function renderStats() {
  const total = state.samples.length;
  const pending = state.samples.filter((s) => s.candidates).length;
  const drafts = state.samples.filter((s) => !s.candidates && !s.confirmed).length;
  const confirmed = state.samples.filter((s) => !s.candidates && s.confirmed).length;
  const released = state.samples.filter((s) => !s.candidates && s.confirmed && s.released).length;
  const inCompare = state.compare.length;
  const failed = state.pendingImport ? 1 : 0;
  statsBar.innerHTML = `
    <span class="stat">总样本 <b>${total}</b></span>
    <span class="stat">待裁决 <b>${pending}</b></span>
    <span class="stat">现场稿 <b>${drafts}</b></span>
    <span class="stat">已确认 <b>${confirmed}</b></span>
    <span class="stat">已放行 <b>${released}</b></span>
    <span class="stat">对比中 <b>${inCompare}</b></span>
    ${failed ? `<span class="stat stat-fail">导入失败 <b>${failed}</b>（可按原批次重试）</span>` : ""}`;
}

function renderGrid() {
  const rows = filteredSamples();
  sampleGrid.innerHTML = rows.length ? rows.map(cardHtml).join("") : "<p>还没有样本，先从左侧录入一张薄片照片，或导入现场批次。</p>";
}

function renderCompare() {
  const compareSamples = state.compare
    .map((id) => state.samples.find((sample) => sample.id === id))
    .filter((sample) => canCompare(sample))
    .slice(0, 2);

  comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
    <article class="compare-item">
      ${sample.photo ? `<img src="${sample.photo}" alt="${sample.code}对比图">` : ""}
      <h3>${sample.code}</h3>
      <p>${sample.polarization} · ${sample.minerals || "未记录矿物"}</p>
      <p>${sample.texture || "未记录结构"}</p>
    </article>`).join("") : "<p>勾选两张已确认、已裁决的样本卡片后可并排对比。</p>";
}

function renderHistory() {
  if (!state.history.length) {
    historyList.innerHTML = "<p class=\"hint\">暂无履历。</p>";
    return;
  }
  historyList.innerHTML = state.history.map((h) => `
    <div class="history-item">
      <span class="history-type">${h.type}</span>
      <span class="history-text">${h.text}</span>
      <time>${new Date(h.at).toLocaleString("zh-CN")}</time>
    </div>`).join("");
}

function renderImportStatus() {
  const p = state.pendingImport;
  if (p) {
    importStatus.innerHTML = `
      <div class="import-fail">
        <p>导入失败：${p.error}</p>
        <button type="button" id="retryImportBtn">按原批次重试</button>
      </div>`;
    return;
  }
  const last = Object.values(state.batches).sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
  if (last) {
    importStatus.innerHTML = `<p class="import-ok">最近导入：${new Date(last.importedAt).toLocaleString("zh-CN")} · 新增 ${last.result.created.length} · 更新 ${last.result.updated.length} · 冲突 ${last.result.conflict.length}</p>`;
  } else {
    importStatus.innerHTML = `<p class="hint">尚未导入现场批次。</p>`;
  }
}

function renderExportLabel() {
  const list = state.samples.filter((s) => !s.candidates && s.confirmed && s.released);
  exportBtn.textContent = `导出观察清单${list.length ? ` (${list.length})` : ""}`;
}

function render() {
  renderStats();
  renderGrid();
  renderCompare();
  renderHistory();
  renderImportStatus();
  renderExportLabel();
}

// ---------- 导入 ----------

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0).toString(36);
}

function batchIdOf(batch) {
  if (batch.batchId != null && String(batch.batchId).trim()) return String(batch.batchId).trim();
  const fingerprint = (batch.samples || [])
    .map((s) => `${s.code ?? ""}@${s.updatedAt ?? s.exportedAt ?? ""}`)
    .join("|");
  return "batch-" + hashString(fingerprint);
}

function extractFieldSample(item) {
  const out = {};
  for (const f of ALL_FIELDS) {
    if (item[f] === undefined) continue;
    out[f] = f === "code" ? String(item[f]).trim() : item[f];
  }
  return out;
}

function fieldOverrides(item) {
  const o = {};
  for (const f of ALL_FIELDS) {
    if (item[f] !== undefined) o[f] = item[f];
  }
  return o;
}

function failImport(rawText, error) {
  state.pendingImport = { batchId: null, payload: rawText, error, failedAt: now() };
  addHistory("import-failed", `导入失败：${error}`);
  saveOrReport();
  return { ok: false, error };
}

function runImport(rawText) {
  let batch;
  try {
    batch = JSON.parse(rawText);
  } catch (e) {
    return failImport(rawText, "批次文件不是有效 JSON：" + e.message);
  }
  if (!batch || !Array.isArray(batch.samples)) {
    return failImport(rawText, "批次格式不正确：缺少 samples 数组");
  }
  const batchId = batchIdOf(batch);

  // 重复导入同一批次：沿用第一次结果，不重复应用。
  if (state.batches[batchId]) {
    const first = state.batches[batchId];
    addHistory("import-idem", `重复导入批次 ${batchId}，沿用第一次结果（${new Date(first.importedAt).toLocaleString("zh-CN")}）：新增 ${first.result.created.length}、更新 ${first.result.updated.length}、冲突 ${first.result.conflict.length}`);
    saveOrReport();
    return { ok: true, idempotent: true, result: first.result, importedAt: first.importedAt };
  }

  const before = JSON.parse(JSON.stringify(state));
  const result = { created: [], updated: [], conflict: [], skipped: [] };
  const baseByCode = batch.base && typeof batch.base === "object" ? batch.base : {};

  for (const rawItem of batch.samples) {
    const item = extractFieldSample(rawItem);
    if (!item.code) {
      result.skipped.push({ code: "(空)", reason: "缺少样本编号" });
      continue;
    }
    const existing = state.samples.find((s) => s.code === item.code);

    if (!existing) {
      state.samples.unshift(makeSample(item, { source: "field", confirmed: false }));
      result.created.push(item.code);
      addHistory("import", `导入现场稿 ${item.code}（新增）`);
      continue;
    }

    const base = baseByCode[item.code] || null;

    // 实验室已确认的结论不能被现场稿覆盖：关键字段有差异即保留两份候选待裁决。
    if (existing.confirmed) {
      const diffs = KEY_FIELDS.filter((f) => item[f] !== undefined && item[f] !== existing[f]);
      if (diffs.length) {
        existing.candidates = {
          lab: snapshot(existing),
          field: snapshot({ ...existing, ...fieldOverrides(item) })
        };
        invalidateDependencies(existing, "进入待裁决状态");
        result.conflict.push({ code: item.code, fields: diffs });
        addHistory("conflict", `${item.code} 已确认结论与现场稿冲突（${diffs.join("、")}），保留两份候选待裁决`);
      } else {
        result.skipped.push({ code: item.code, reason: "与已确认结论一致" });
      }
      continue;
    }

    // 现场稿（未确认）：按断网前快照做三方合并。
    if (base) {
      const fieldChanged = KEY_FIELDS.filter((f) => item[f] !== undefined && item[f] !== base[f]);
      const bothChanged = KEY_FIELDS.filter(
        (f) => fieldChanged.includes(f) && existing[f] !== base[f] && existing[f] !== item[f]
      );
      if (bothChanged.length) {
        existing.candidates = {
          lab: snapshot(existing),
          field: snapshot({ ...existing, ...fieldOverrides(item) })
        };
        result.conflict.push({ code: item.code, fields: bothChanged });
        addHistory("conflict", `${item.code} 现场稿与实验室稿均有修改（${bothChanged.join("、")}），保留两份候选待裁决`);
      } else {
        let applied = false;
        for (const f of ALL_FIELDS) {
          if (item[f] === undefined || item[f] === existing[f]) continue;
          if (KEY_FIELDS.includes(f) && !fieldChanged.includes(f)) continue;
          const oldVal = existing[f];
          existing[f] = item[f];
          if ((f === "code" || f === "polarization") && oldVal !== item[f]) {
            invalidateDependencies(existing, f === "code" ? "样本编号变化" : "偏光变化");
          }
          applied = true;
        }
        if (applied) {
          existing.updatedAt = now();
          result.updated.push(item.code);
          addHistory("import", `导入现场稿 ${item.code}（更新）`);
        } else {
          result.skipped.push({ code: item.code, reason: "无变化" });
        }
      }
    } else {
      // 缺少断网前快照：关键字段有差异即保留两份候选，其余字段按现场稿合并。
      const diffs = KEY_FIELDS.filter((f) => item[f] !== undefined && item[f] !== existing[f]);
      if (diffs.length) {
        existing.candidates = {
          lab: snapshot(existing),
          field: snapshot({ ...existing, ...fieldOverrides(item) })
        };
        result.conflict.push({ code: item.code, fields: diffs });
        addHistory("conflict", `${item.code} 现场稿与实验室稿不一致（${diffs.join("、")}），保留两份候选待裁决`);
      } else {
        let applied = false;
        for (const f of PLAIN_FIELDS) {
          if (item[f] !== undefined && item[f] !== existing[f]) {
            existing[f] = item[f];
            applied = true;
          }
        }
        if (applied) {
          existing.updatedAt = now();
          result.updated.push(item.code);
          addHistory("import", `导入现场稿 ${item.code}（更新）`);
        } else {
          result.skipped.push({ code: item.code, reason: "无变化" });
        }
      }
    }
  }

  state.batches[batchId] = { importedAt: now(), geologist: batch.geologist || "", result };
  state.pendingImport = null;

  if (!saveOrReport()) {
    Object.assign(state, before);
    state.pendingImport = { batchId, payload: rawText, error: "本地存储不足，导入未保存", failedAt: now() };
    addHistory("import-failed", `导入失败：本地存储不足，已按原批次保留待重试`);
    saveOrReport();
    return { ok: false, error: "本地存储不足，导入未保存；可按原批次重试" };
  }
  return { ok: true, result, batchId };
}

// ---------- 裁决 ----------

function adjudicate(sampleId, which) {
  const sample = state.samples.find((s) => s.id === sampleId);
  if (!sample || !sample.candidates) return;
  const chosen = sample.candidates[which];
  if (!chosen) return;
  const oldCode = sample.code;
  const oldPolar = sample.polarization;
  for (const f of ALL_FIELDS) sample[f] = chosen[f] ?? "";
  sample.candidates = null;
  sample.confirmed = true;
  sample.source = which === "lab" ? "lab" : "field";
  sample.updatedAt = now();
  addHistory("adjudicate", `${sample.code} 裁决采用${which === "lab" ? "实验室" : "现场"}版本`);
  if (sample.code !== oldCode || sample.polarization !== oldPolar) {
    invalidateDependencies(sample, sample.code !== oldCode ? "样本编号变化" : "偏光变化");
  }
  save();
  render();
}

function openAdjudicate(id) {
  const sample = state.samples.find((s) => s.id === id);
  if (!sample || !sample.candidates) return;
  adjudicateId = id;
  dialogSub.textContent = `${sample.code}：实验室与现场对照片、偏光或鉴定结论有不同修改，请选择一份候选；裁决后即可对比与导出。`;
  candidateGrid.innerHTML = ["lab", "field"].map((which) => {
    const c = sample.candidates[which];
    return `
      <article class="candidate-card">
        <h3>${which === "lab" ? "实验室版本" : "现场版本"}</h3>
        ${c.photo ? `<img src="${c.photo}" alt="候选照片">` : `<div class="photo-placeholder"></div>`}
        <p>编号：${c.code}</p>
        <p>偏光：${c.polarization}</p>
        <p>矿物：${c.minerals || "—"}</p>
        <p>结构：${c.texture || "—"}</p>
        <p>批注：${c.comment || "—"}</p>
        <p>地点：${c.location || "—"} · 倍数：${c.magnification || "—"}</p>
        <button type="button" data-pick="${which}">采用此版本</button>
      </article>`;
  }).join("");
  if (typeof adjudicateDialog.showModal === "function") adjudicateDialog.showModal();
}

function closeAdjudicate() {
  adjudicateId = null;
  adjudicateDialog.close();
}

// ---------- 编辑 ----------

function resetForm() {
  form.dataset.editingId = "";
  pendingPhoto = "";
  photoInput.value = "";
  form.reset();
  submitBtn.textContent = "保存样本";
  cancelEditBtn.hidden = true;
}

function startEdit(id) {
  const sample = state.samples.find((s) => s.id === id);
  if (!sample) return;
  form.dataset.editingId = id;
  form.code.value = sample.code;
  form.location.value = sample.location;
  form.magnification.value = sample.magnification;
  form.polarization.value = sample.polarization;
  form.minerals.value = sample.minerals;
  form.texture.value = sample.texture;
  form.comment.value = sample.comment;
  pendingPhoto = sample.photo;
  photoInput.value = "";
  submitBtn.textContent = "保存修改";
  cancelEditBtn.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- 模板 / 导出 ----------

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function downloadTemplate() {
  const base = {};
  const samples = state.samples.map((s) => {
    const f = snapshot(s);
    base[s.code] = { ...f };
    return f;
  });
  samples.push({
    code: "BX-17-NEW",
    photo: "",
    location: "",
    magnification: "",
    polarization: "正交偏光",
    minerals: "",
    texture: "",
    comment: "现场新增样本"
  });
  const batch = {
    _说明: "现场地质员断网修改后带回的批次。samples 为现场稿，base 为断网前快照（用于三方合并）。",
    batchId: "field-batch-" + new Date().toISOString().slice(0, 10),
    geologist: "两组地质员",
    exportedAt: now(),
    base,
    samples
  };
  downloadJson(batch, "field-batch.json");
}

// ---------- 事件 ----------

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
    photo: pendingPhoto,
    location: data.get("location").trim(),
    magnification: data.get("magnification").trim(),
    polarization: data.get("polarization"),
    minerals: data.get("minerals").trim(),
    texture: data.get("texture").trim(),
    comment: data.get("comment").trim()
  };
  const editingId = form.dataset.editingId;

  if (editingId) {
    const sample = state.samples.find((s) => s.id === editingId);
    if (sample) {
      const oldCode = sample.code;
      const oldPolar = sample.polarization;
      for (const f of ALL_FIELDS) {
        if (f === "photo" && !pendingPhoto) continue;
        sample[f] = fields[f] ?? "";
      }
      sample.confirmed = true;
      sample.candidates = null;
      sample.source = "lab";
      sample.updatedAt = now();
      addHistory("lab-edit", `实验室编辑样本 ${sample.code}`);
      if (sample.code !== oldCode || sample.polarization !== oldPolar) {
        invalidateDependencies(sample, sample.code !== oldCode ? "样本编号变化" : "偏光变化");
      }
    }
  } else {
    const existing = state.samples.find((s) => s.code === fields.code);
    if (existing) {
      const oldPolar = existing.polarization;
      for (const f of ALL_FIELDS) existing[f] = fields[f] ?? "";
      existing.confirmed = true;
      existing.candidates = null;
      existing.source = "lab";
      existing.updatedAt = now();
      addHistory("lab-entry", `实验室录入更新 ${existing.code}`);
      if (existing.polarization !== oldPolar) {
        invalidateDependencies(existing, "偏光变化");
      }
    } else {
      state.samples.unshift(makeSample(fields, { source: "lab", confirmed: true }));
      addHistory("lab-entry", `实验室录入新样本 ${fields.code}`);
    }
  }

  resetForm();
  save();
  render();
});

cancelEditBtn.addEventListener("click", () => {
  resetForm();
});

sampleGrid.addEventListener("click", (event) => {
  const target = event.target;
  const deleteId = target.dataset.delete;
  const editId = target.dataset.edit;
  const releaseId = target.dataset.release;
  const adjudicateIdAttr = target.dataset.adjudicate;

  if (deleteId) {
    const sample = state.samples.find((s) => s.id === deleteId);
    state.samples = state.samples.filter((s) => s.id !== deleteId);
    state.compare = state.compare.filter((id) => id !== deleteId);
    addHistory("delete", `删除样本 ${sample ? sample.code : deleteId}`);
    save();
    render();
    return;
  }
  if (editId) {
    startEdit(editId);
    return;
  }
  if (releaseId) {
    const sample = state.samples.find((s) => s.id === releaseId);
    if (sample && !sample.candidates && sample.confirmed) {
      sample.released = !sample.released;
      addHistory("release", `${sample.code} ${sample.released ? "放行" : "取消放行"}`);
      save();
      render();
    }
    return;
  }
  if (adjudicateIdAttr) {
    openAdjudicate(adjudicateIdAttr);
    return;
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  const sample = state.samples.find((s) => s.id === id);
  if (event.target.checked) {
    if (!canCompare(sample)) {
      event.target.checked = false;
      return;
    }
    state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, 2);
  } else {
    state.compare = state.compare.filter((item) => item !== id);
  }
  save();
  render();
});

candidateGrid.addEventListener("click", (event) => {
  const pick = event.target.dataset.pick;
  if (!pick || !adjudicateId) return;
  adjudicate(adjudicateId, pick);
  closeAdjudicate();
});

closeDialogBtn.addEventListener("click", () => {
  closeAdjudicate();
});

adjudicateDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAdjudicate();
});

mineralFilter.addEventListener("input", render);
polarFilter.addEventListener("input", render);

importBtn.addEventListener("click", async () => {
  const file = batchInput.files[0];
  if (!file) {
    alert("请先选择批次 JSON 文件");
    return;
  }
  const text = await file.text();
  const r = runImport(text);
  batchInput.value = "";
  render();
  if (!r.ok) {
    alert("导入失败：" + r.error);
  } else if (r.idempotent) {
    alert("该批次已导入过，沿用第一次结果，不重复应用。");
  }
});

templateBtn.addEventListener("click", () => {
  downloadTemplate();
});

importStatus.addEventListener("click", (event) => {
  if (event.target.id === "retryImportBtn" && state.pendingImport) {
    const r = runImport(state.pendingImport.payload);
    render();
    if (!r.ok) alert("重试失败：" + r.error);
  }
});

exportBtn.addEventListener("click", () => {
  const list = state.samples.filter((s) => !s.candidates && s.confirmed && s.released);
  if (!list.length) {
    alert("没有已放行的样本可导出。请先裁决冲突并放行。");
    return;
  }
  const checklist = list.map((sample) => ({
    样本编号: sample.code,
    采样地点: sample.location,
    放大倍数: sample.magnification,
    偏光类型: sample.polarization,
    主要矿物: sample.minerals,
    颗粒结构: sample.texture,
    老师批注: sample.comment
  }));
  downloadJson({ exportedAt: now(), 样本数: list.length, 观察清单: checklist }, "thin-section-checklist.json");
});

render();
