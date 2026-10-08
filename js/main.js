// 介面：側欄（物品庫/房間/擺法）、檢視器、距離輸入、各種對話框
import {
  S, on, emit, P, L, lib, isRug, isRound, selItem, checkpoint, changed, undo, redo, histState,
  loadAll, newProject, newLayout, addProject, openProject, removeProject, saveProjectNow, pruneMeasures,
  saveLib, deleteLib, usage, putImage, delImage, getImg, saveSettings, exportData, importData,
} from './state.js';
import { uid, cm, toMM, esc, normDeg } from './util.js';
import { buildRoom, wallEdges, cornerName } from './geom.js';
import { Plan2D } from './plan2d.js';
import { rectify } from './rectify.js';

const $ = s => document.querySelector(s);
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const SHAPES = { box: '方塊傢俱', cyl: '圓形傢俱', rug: '地毯（矩形）', rugRound: '地毯（圓／橢圓）' };

let plan, v3d = null, view = '2d';

// ---------- 小元件 ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

function updateHint() {
  const h = $('#hint');
  let t = '';
  if (view === '3d') t = '';
  else if (plan.mode === 'measure') t = plan.mpick ? '再點一條「平行」的邊 → 建立量測線' : '點兩條平行的邊建立量測線・點量測數字可刪除';
  else if (plan.pick) t = '點一條邊作為基準：牆、門框、或其他物件的邊（點空白處取消）';
  else if (selItem()) t = '拖曳移動（Shift 微調 0.1 cm）・拖 ↻ 旋轉・點物件的「邊」→ 設定精確距離';
  else if (!L()?.items.length) t = '從左側「物品庫」新增物品，再放進這個空間';
  else t = matchMedia('(pointer: coarse)').matches ? '點選物件開始調整・拖曳空白處平移・雙指縮放' : '點選物件開始調整・拖曳空白處平移・滾輪或觸控板縮放';
  h.textContent = t;
  h.hidden = !t;
}

function modal(title, html, { wide } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="mbox ${wide ? 'wide' : ''}"><div class="mhead"><b>${esc(title)}</b><button class="ghost x" data-close>✕</button></div><div class="mbody">${html}</div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.querySelector('[data-close]').onclick = close;
  m.onclick = e => { if (e.target === m) close(); };
  return { el: m.querySelector('.mbody'), close };
}

const num = (v, fallback = 0) => { const n = toMM(v); return Number.isFinite(n) ? n : fallback; };

// 重新渲染面板但保留焦點（打字中不會被打斷）
function rerender(box, fn) {
  const a = document.activeElement;
  const key = a && box.contains(a) ? a.dataset.k : null;
  fn();
  if (key) { const n = box.querySelector(`[data-k="${CSS.escape(key)}"]`); n?.focus(); }
}

// ---------- 檢視器（選到的物件） ----------
function renderInspector() {
  const box = $('#inspector');
  const it = selItem();
  if (!it || view !== '2d') { box.hidden = true; return; }
  const li = lib(it.libId);
  if (!li) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <div class="ihead"><div><b>${esc(li.name)}</b><div class="mute small">${SHAPES[li.shape]}・${cm(li.w)} × ${cm(li.d)} × ${cm(li.h)} cm</div></div>
      <button class="ghost x" data-a="close" title="取消選取">✕</button></div>
    <div class="row"><label>旋轉</label><input data-k="rot" type="number" inputmode="decimal" step="1" value="${+it.rot.toFixed(1)}"><span>°</span>
      <button data-a="ccw" title="逆時針 90°">⟲</button><button data-a="cw" title="順時針 90°">⟳</button></div>
    <div class="btns">
      <button data-a="lock" class="${it.locked ? 'on' : ''}">${it.locked ? '🔒 已鎖定' : '🔓 鎖定'}</button>
      <button data-a="dup">複製</button>
      <button data-a="edit">編輯物品</button>
      <button data-a="del" class="danger">移出</button>
    </div>
    <p class="tip">${it.locked ? '鎖定中：不會被拖動，但仍可當作其他物件的距離基準。' : '點物件的任一條<b>邊</b>，再點另一條邊（牆、門框、其他物件），就能輸入精確距離。'}</p>`;
  box.querySelector('[data-k="rot"]').onchange = e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    checkpoint(); it.rot = normDeg(v); changed();
  };
  box.onclick = e => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    const cur = selItem();
    if (!cur) return;
    if (a === 'close') { S.sel = null; emit('selection'); return; }
    if (a === 'edit') { openLibForm(lib(cur.libId)); return; }
    if ((a === 'cw' || a === 'ccw') && cur.locked) { toast('已鎖定，先解鎖才能旋轉'); return; }
    checkpoint();
    if (a === 'cw') cur.rot = normDeg(cur.rot + 90);
    if (a === 'ccw') cur.rot = normDeg(cur.rot - 90);
    if (a === 'lock') cur.locked = !cur.locked;
    if (a === 'dup') {
      const n = { ...cur, id: uid(), x: cur.x + 150, y: cur.y + 150, locked: false };
      L().items.push(n); S.sel = n.id;
    }
    if (a === 'del') {
      const lay = L();
      lay.items = lay.items.filter(x => x.id !== cur.id);
      pruneMeasures(lay); S.sel = null;
    }
    changed(); emit('selection');
  };
}

// ---------- 距離輸入 ----------
function showDistance({ current, rot, from, to, onApply, onCancel }) {
  const box = $('#distSheet');
  box.hidden = false;
  box.innerHTML = `
    <div class="dt">設定距離</div>
    <div class="mute small">${esc(from)} 的這條邊 ↔ ${esc(to)}</div>
    ${rot ? `<div class="warnline">兩條邊不平行，套用時會把物件旋轉 ${rot > 0 ? '+' : ''}${rot.toFixed(1)}° 讓它們對齊</div>` : ''}
    <div class="drow"><input id="distIn" type="number" inputmode="decimal" step="0.1" min="0" value="${cm(current)}"><span>cm</span></div>
    <label class="chk"><input type="checkbox" id="distPin"> 同時釘一條量測線</label>
    <label class="chk"><input type="checkbox" id="distFlip"> 放到基準邊的另一側</label>
    <div class="btns end"><button data-a="cancel">取消</button><button data-a="ok" class="primary">套用</button></div>`;
  const inp = box.querySelector('#distIn');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  const apply = () => {
    const d = toMM(inp.value);
    if (!Number.isFinite(d) || d < 0) { toast('請輸入 0 以上的數字'); return; }
    const pin = box.querySelector('#distPin').checked, flip = box.querySelector('#distFlip').checked;
    hideDistance();
    onApply(d, pin, flip);
  };
  inp.onkeydown = e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') { hideDistance(); onCancel(); } };
  box.onclick = e => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'ok') apply();
    if (a === 'cancel') { hideDistance(); onCancel(); }
  };
}
function hideDistance() { const b = $('#distSheet'); b.hidden = true; b.innerHTML = ''; }

// ---------- 物品庫 ----------
function thumbHTML(li) {
  const img = li.tex && li.texMode !== 'none' ? getImg(li.tex) : null;
  const shape = isRound(li) ? 'round' : '';
  return img
    ? `<div class="thumb ${shape}" style="background-image:url(${img.src});background-color:${esc(li.color)}"></div>`
    : `<div class="thumb ${shape}" style="background:${esc(li.color)}"></div>`;
}

function renderLib() {
  const box = $('#tab-lib');
  const lay = L();
  const items = [...S.library].sort((a, b) => (isRug(b) - isRug(a)) || a.name.localeCompare(b.name, 'zh-Hant'));
  box.innerHTML = `
    <button class="primary block" data-a="new">＋ 新增物品</button>
    <p class="mute small">物品庫在所有空間共用。改了尺寸或外觀，每個空間都會一起更新。</p>
    <div class="libList">${items.map(li => {
      const n = lay ? lay.items.filter(i => i.libId === li.id).length : 0;
      return `<div class="libCard" data-id="${li.id}">
        ${thumbHTML(li)}
        <div class="lc-main"><b>${esc(li.name)}</b>
          <div class="mute small">${cm(li.w)} × ${cm(li.d)} × ${cm(li.h)} cm</div>
          <div class="tags">${isRug(li) ? '<span class="tag">地毯</span>' : ''}${(li.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}${n ? `<span class="tag on">此方案 ×${n}</span>` : ''}</div>
        </div>
        <div class="lc-act"><button data-a="place" class="primary">放入</button><button data-a="edit">編輯</button></div>
      </div>`;
    }).join('') || '<div class="empty">還沒有物品。<br>先新增你的地毯或傢俱吧。</div>'}</div>`;
}

$('#tab-lib').addEventListener('click', e => {
  const a = e.target.closest('button')?.dataset.a;
  if (!a) return;
  if (a === 'new') return openLibForm(null);
  const li = lib(e.target.closest('.libCard')?.dataset.id);
  if (!li) return;
  if (a === 'edit') openLibForm(li);
  if (a === 'place') placeItem(li);
});

function placeItem(li) {
  const lay = L();
  const poly = buildRoom(P().room).poly;
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  let x = Math.round((Math.min(...xs) + Math.max(...xs)) / 20) * 10, y = Math.round((Math.min(...ys) + Math.max(...ys)) / 20) * 10;
  while (lay.items.some(i => Math.abs(i.x - x) < 1 && Math.abs(i.y - y) < 1)) { x += 150; y += 150; }
  checkpoint();
  const it = { id: uid(), libId: li.id, x, y, rot: 0, locked: false };
  lay.items.push(it);
  S.sel = it.id;
  changed(); emit('selection');
  if (isMobile()) closeSheet();
  if (view !== '2d') setView('2d');
  toast(`已放入「${li.name}」，拖曳它或點它的邊來定位`);
}

function openLibForm(src) {
  const isNew = !src;
  const f = src ? JSON.parse(JSON.stringify(src)) : { id: uid(), name: '', shape: 'box', w: 1000, d: 500, h: 750, color: '#b89a7a', texMode: 'none', tex: null, tileW: 300, tileH: 300, tags: [], notes: '', created: Date.now() };
  let newBlob = null, newURL = null;
  const m = modal(isNew ? '新增物品' : '編輯物品', `
    <div class="form">
      <label>名稱<input data-f="name" value="${esc(f.name)}" placeholder="例如：舊衣裳箱、客廳地毯"></label>
      <label>類型<select data-f="shape">${Object.entries(SHAPES).map(([k, v]) => `<option value="${k}" ${f.shape === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="grid3">
        <label><span><span data-lw>寬</span>（cm）</span><input data-f="w" type="number" inputmode="decimal" step="0.1" value="${cm(f.w)}"></label>
        <label><span><span data-ld>深</span>（cm）</span><input data-f="d" type="number" inputmode="decimal" step="0.1" value="${cm(f.d)}"></label>
        <label>高（cm）<input data-f="h" type="number" inputmode="decimal" step="0.1" value="${cm(f.h)}"></label>
      </div>
      <p class="mute small" data-dimhint></p>
      <label>底色<input data-f="color" type="color" value="${esc(f.color)}"></label>
      <div class="lbl">外觀</div>
      <div class="seg" data-texseg>
        <button data-t="none">純色</button><button data-t="fit">照片貼頂面</button><button data-t="tile">材質重複鋪貼</button>
      </div>
      <div data-texbox></div>
      <label>標籤（用逗號分開）<input data-f="tags" value="${esc((f.tags || []).join(', '))}" placeholder="老物件, 收納"></label>
      <label>備註<textarea data-f="notes" rows="3" placeholder="來源、年代、用途，例如：搬家時可裝約 40 本書">${esc(f.notes || '')}</textarea></label>
      ${!isNew ? `<p class="mute small">使用中的空間：${usage(f.id).map(p => esc(p.name)).join('、') || '（無）'}</p>` : ''}
      <div class="btns end">
        ${!isNew ? '<button data-a="delete" class="danger">從物品庫刪除</button><span class="sp"></span>' : ''}
        <button data-a="cancel">取消</button><button data-a="save" class="primary">${isNew ? '建立' : '儲存'}</button>
      </div>
    </div>`);
  const el = m.el;
  const q = s => el.querySelector(s);

  const syncDimLabels = () => {
    const shape = q('[data-f="shape"]').value;
    q('[data-lw]').textContent = shape === 'rugRound' || shape === 'cyl' ? '直徑／寬' : '寬';
    q('[data-ld]').textContent = shape === 'rugRound' || shape === 'cyl' ? '直徑／深' : '深';
    q('[data-dimhint]').textContent = isRug({ shape }) ? '地毯厚度一般 0.5–2 cm。寬＝俯視時左右、深＝上下，放進空間後可以旋轉。' : '寬＝俯視時左右、深＝前後。尺寸以你量的最大外框為準。';
  };
  q('[data-f="shape"]').onchange = e => {
    syncDimLabels();
    if (isRug({ shape: e.target.value }) && num(q('[data-f="h"]').value) > 50) q('[data-f="h"]').value = '1.0';
  };
  syncDimLabels();

  const renderTex = () => {
    el.querySelectorAll('[data-texseg] button').forEach(b => b.classList.toggle('on', b.dataset.t === f.texMode));
    const box = q('[data-texbox]');
    if (f.texMode === 'none') { box.innerHTML = '<p class="mute small">只用底色。之後隨時可以加照片。</p>'; return; }
    const img = newURL || (f.tex ? getImg(f.tex)?.src : null);
    box.innerHTML = `
      ${f.texMode === 'fit'
        ? '<p class="mute small">拍物品「頂面」（地毯就是正面）。站遠一點、用 iPhone 的長焦鏡頭拍，透視變形最少。接著拖四個角校正，貼圖會依你量的長寬比例拉正。</p>'
        : `<p class="mute small">拍一塊木紋或布料，框出一個區域並告訴我它實際多大，整個物件會用它重複鋪滿。</p>
           <div class="grid2"><label>框選區域寬（cm）<input data-f="tileW" type="number" inputmode="decimal" step="0.1" value="${cm(f.tileW || 300)}"></label>
           <label>框選區域高（cm）<input data-f="tileH" type="number" inputmode="decimal" step="0.1" value="${cm(f.tileH || 300)}"></label></div>`}
      <div class="texrow">${img ? `<img src="${img}" class="texprev">` : '<div class="texprev empty">尚未選照片</div>'}
        <label class="btn">${img ? '換一張照片' : '選擇照片'}<input type="file" accept="image/*" hidden data-file></label></div>`;
    q('[data-file]').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      let aspect;
      if (f.texMode === 'fit') aspect = num(q('[data-f="w"]').value, f.w) / Math.max(1, num(q('[data-f="d"]').value, f.d));
      else { f.tileW = num(q('[data-f="tileW"]').value, 300); f.tileH = num(q('[data-f="tileH"]').value, 300); aspect = f.tileW / Math.max(1, f.tileH); }
      const blob = await rectify(file, { aspect, title: f.texMode === 'fit' ? '校正頂面照片' : '框選材質區域' });
      if (!blob) return;
      newBlob = blob;
      if (newURL) URL.revokeObjectURL(newURL);
      newURL = URL.createObjectURL(blob);
      renderTex();
    };
  };
  q('[data-texseg]').onclick = e => {
    const t = e.target.closest('button')?.dataset.t;
    if (!t) return;
    if (f.texMode === 'tile') { f.tileW = num(q('[data-f="tileW"]')?.value, f.tileW); f.tileH = num(q('[data-f="tileH"]')?.value, f.tileH); }
    f.texMode = t; renderTex();
  };
  renderTex();

  el.querySelector('.btns').onclick = async e => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'cancel') { m.close(); return; }
    if (a === 'delete') {
      const used = usage(f.id);
      if (!confirm(used.length ? `「${f.name}」正在 ${used.length} 個空間中使用，刪除後會一併從那些空間移除。確定刪除？` : `確定從物品庫刪除「${f.name}」？`)) return;
      await deleteLib(f.id); m.close(); toast('已刪除'); return;
    }
    if (a !== 'save') return;
    f.name = q('[data-f="name"]').value.trim() || '未命名物品';
    f.shape = q('[data-f="shape"]').value;
    f.w = num(q('[data-f="w"]').value, f.w); f.d = num(q('[data-f="d"]').value, f.d); f.h = num(q('[data-f="h"]').value, f.h);
    if (!(f.w > 0 && f.d > 0 && f.h > 0)) { toast('寬、深、高都要大於 0'); return; }
    f.color = q('[data-f="color"]').value;
    f.tags = q('[data-f="tags"]').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    f.notes = q('[data-f="notes"]').value;
    if (f.texMode === 'tile') { f.tileW = num(q('[data-f="tileW"]').value, f.tileW); f.tileH = num(q('[data-f="tileH"]').value, f.tileH); }
    if (newBlob) {
      const old = f.tex;
      f.tex = await putImage(newBlob);
      if (old) delImage(old);
    }
    if (f.texMode !== 'none' && !f.tex) f.texMode = 'none';
    await saveLib(f);
    m.close();
    if (isNew && confirm(`已建立「${f.name}」。要直接放進目前的空間嗎？`)) placeItem(f);
  };
  if (isNew) setTimeout(() => q('[data-f="name"]').focus(), 50);
}

// ---------- 房間 ----------
function roomChange(fn, refit = true) {
  checkpoint();
  fn(P().room);
  changed();
  if (refit) plan.fit();
}

function renderRoom() {
  const box = $('#tab-room');
  const p = P();
  if (!p) return;
  const r = p.room;
  const { poly, gap } = buildRoom(r);
  const walls = wallEdges(poly);
  const n = walls.length;
  const turnOpts = t => [[90, '右轉 90°'], [-90, '左轉 90°'], [45, '右轉 45°'], [-45, '左轉 45°']]
    .map(([v, l]) => `<option value="${v}" ${t === v ? 'selected' : ''}>${l}</option>`).join('') + `<option value="custom" ${[90, -90, 45, -45].includes(t) ? '' : 'selected'}>自訂…</option>`;
  rerender(box, () => {
    box.innerHTML = `
      <div class="form">
        <label>空間名稱<input data-k="name" value="${esc(p.name)}"></label>
        <div class="lbl">形狀</div>
        <div class="seg" data-k="modeSeg"><button data-mode="rect" class="${r.mode === 'rect' ? 'on' : ''}">矩形</button><button data-mode="walls" class="${r.mode === 'walls' ? 'on' : ''}">逐牆輸入</button></div>
        ${r.mode === 'rect' ? `
          <div class="grid2">
            <label>寬：牆 1／牆 3（cm）<input data-k="rw" type="number" inputmode="decimal" step="0.1" value="${cm(r.w)}"></label>
            <label>深：牆 2／牆 4（cm）<input data-k="rd" type="number" inputmode="decimal" step="0.1" value="${cm(r.d)}"></label>
          </div>
          <p class="mute small">兩組對牆量出來不一樣長？改用「逐牆輸入」，可以把誤差平均分掉。</p>` : `
          <p class="mute small">從角 A 出發，<b>順時針</b>（俯視）沿著牆走一圈，依序填每面牆的長度，以及走到盡頭時怎麼轉。</p>
          <div class="walls">${r.walls.map((w, i) => `
            <div class="wrow"><span class="wname">牆 ${i + 1}<small>${cornerName(i)}→${cornerName((i + 1) % r.walls.length)}</small></span>
              <input data-k="wl${i}" data-i="${i}" class="wlen" type="number" inputmode="decimal" step="0.1" value="${cm(w.len)}">
              <select data-k="wt${i}" data-i="${i}" class="wturn">${turnOpts(w.turn)}</select>
              ${[90, -90, 45, -45].includes(w.turn) ? '' : `<input data-k="wc${i}" data-i="${i}" class="wcustom" type="number" step="0.1" value="${w.turn}" title="右轉為正、左轉為負">`}
              <button class="ghost x" data-delwall="${i}" title="刪除這面牆" ${r.walls.length <= 3 ? 'disabled' : ''}>✕</button></div>`).join('')}
          </div>
          <button data-addwall>＋ 加一面牆</button>
          <div class="closure ${gap > 50 ? 'bad' : ''}">閉合誤差：<b>${cm(gap)} cm</b>${gap > 50 ? '（偏大，檢查一下長度或轉角？）' : ''}</div>
          <div class="seg small" data-k="closureSeg"><button data-cl="distribute" class="${r.closure !== 'last' ? 'on' : ''}">平均分配到各角</button><button data-cl="last" class="${r.closure === 'last' ? 'on' : ''}">由最後一面牆補齊</button></div>`}
        <label>天花板高度（cm）<input data-k="height" type="number" inputmode="decimal" step="0.1" value="${cm(r.height)}"></label>

        <div class="lbl">門</div>
        ${(r.doors || []).map((d, j) => `
          <div class="door" data-door="${d.id}">
            <div class="dhead"><b>門 ${j + 1}</b><button class="ghost x danger" data-deldoor="${d.id}">刪除</button></div>
            <div class="grid2">
              <label>在哪面牆<select data-k="dw${d.id}" data-dk="wall">${walls.map((w, i) => `<option value="${i}" ${d.wall === i ? 'selected' : ''}>牆 ${i + 1}（${cornerName(i)}→${cornerName((i + 1) % n)}）</option>`).join('')}</select></label>
              <label>距角 ${cornerName(d.wall)}（cm）<input data-k="do${d.id}" data-dk="off" type="number" inputmode="decimal" step="0.1" value="${cm(d.off)}"></label>
              <label>門寬（cm）<input data-k="dd${d.id}" data-dk="w" type="number" inputmode="decimal" step="0.1" value="${cm(d.w)}"></label>
              <label>門高（cm）<input data-k="dh${d.id}" data-dk="h" type="number" inputmode="decimal" step="0.1" value="${cm(d.h)}"></label>
              <label>鉸鏈在<select data-k="dg${d.id}" data-dk="hinge"><option value="start" ${d.hinge !== 'end' ? 'selected' : ''}>靠角 ${cornerName(d.wall)} 那側</option><option value="end" ${d.hinge === 'end' ? 'selected' : ''}>靠角 ${cornerName((d.wall + 1) % n)} 那側</option></select></label>
              <label>開向<select data-k="ds${d.id}" data-dk="swing"><option value="in" ${d.swing !== 'out' ? 'selected' : ''}>往房內開</option><option value="out" ${d.swing === 'out' ? 'selected' : ''}>往房外開</option></select></label>
            </div>
          </div>`).join('')}
        <button data-adddoor>＋ 新增門</button>

        <div class="lbl">外觀</div>
        <div class="grid2">
          <label>牆面顏色<input data-k="wallColor" type="color" value="${esc(r.wallColor)}"></label>
          <label>地板顏色<input data-k="floorColor" type="color" value="${esc(r.floorColor)}"></label>
        </div>
        <div class="texrow">
          ${r.floorTex && getImg(r.floorTex) ? `<img src="${getImg(r.floorTex).src}" class="texprev">` : '<div class="texprev empty">地板材質</div>'}
          <div class="col">
            <label class="btn">${r.floorTex ? '換地板照片' : '上傳地板照片'}<input type="file" accept="image/*" hidden data-floorfile></label>
            ${r.floorTex ? '<button data-floordel class="danger">移除</button>' : ''}
          </div>
        </div>
        ${r.floorTex ? `<label>框選區域實際寬（cm）<input data-k="floorTile" type="number" inputmode="decimal" step="0.1" value="${cm(r.floorTile)}"></label>` : ''}
        <p class="mute small">日光模式（四季光照）之後會用到：房間朝向、窗戶、經緯度。現在可以先不填。</p>
      </div>`;
  });
}

$('#tab-room').addEventListener('change', async e => {
  const t = e.target, k = t.dataset.k, p = P();
  if (!k || !p) return;
  if (k === 'name') { p.name = t.value.trim() || '未命名空間'; await saveProjectNow(p); renderTitle(); return; }
  if (k === 'rw' || k === 'rd') { const v = toMM(t.value); if (v > 0) roomChange(r => { r[k === 'rw' ? 'w' : 'd'] = v; }); return; }
  if (k === 'height') { const v = toMM(t.value); if (v > 0) roomChange(r => { r.height = v; }, false); return; }
  if (k === 'wallColor' || k === 'floorColor') { roomChange(r => { r[k] = t.value; }, false); return; }
  if (k === 'floorTile') { const v = toMM(t.value); if (v > 0) roomChange(r => { r.floorTile = v; }, false); return; }
  if (t.classList.contains('wlen')) { const v = toMM(t.value); if (v > 0) roomChange(r => { r.walls[+t.dataset.i].len = v; }); return; }
  if (t.classList.contains('wturn')) {
    if (t.value === 'custom') { roomChange(r => { r.walls[+t.dataset.i].turn = 100; }); return; }
    roomChange(r => { r.walls[+t.dataset.i].turn = +t.value; }); return;
  }
  if (t.classList.contains('wcustom')) { const v = parseFloat(t.value); if (Number.isFinite(v)) roomChange(r => { r.walls[+t.dataset.i].turn = v; }); return; }
  const dk = t.dataset.dk;
  if (dk) {
    const id = t.closest('[data-door]').dataset.door;
    roomChange(r => {
      const d = r.doors.find(x => x.id === id);
      if (dk === 'wall') d.wall = +t.value;
      else if (dk === 'hinge' || dk === 'swing') d[dk] = t.value;
      else { const v = toMM(t.value); if (v >= 0) d[dk] = v; }
    }, false);
  }
});

$('#tab-room').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = P();
  if (b.dataset.mode && b.dataset.mode !== p.room.mode) {
    roomChange(r => {
      if (b.dataset.mode === 'walls') {
        r.walls = [{ len: r.w, turn: 90 }, { len: r.d, turn: 90 }, { len: r.w, turn: 90 }, { len: r.d, turn: 90 }];
      } else {
        if (r.walls.length !== 4 && !confirm('切回矩形會只保留前兩面牆的長度，門的位置可能需要重設。確定？')) return;
        r.w = r.walls[0].len; r.d = r.walls[1].len;
        r.doors.forEach(d => { d.wall = Math.min(d.wall, 3); });
      }
      r.mode = b.dataset.mode;
    });
    return;
  }
  if (b.dataset.cl) { roomChange(r => { r.closure = b.dataset.cl; }); return; }
  if (b.hasAttribute('data-addwall')) { roomChange(r => { r.walls.push({ len: 1000, turn: 90 }); }); return; }
  if (b.dataset.delwall) {
    const i = +b.dataset.delwall;
    roomChange(r => {
      r.walls.splice(i, 1);
      r.doors = r.doors.filter(d => d.wall !== i).map(d => ({ ...d, wall: d.wall > i ? d.wall - 1 : d.wall }));
    });
    return;
  }
  if (b.hasAttribute('data-adddoor')) {
    roomChange(r => { r.doors.push({ id: uid(), wall: 0, off: 300, w: 800, h: 2100, hinge: 'start', swing: 'in' }); }, false);
    return;
  }
  if (b.dataset.deldoor) { roomChange(r => { r.doors = r.doors.filter(d => d.id !== b.dataset.deldoor); }, false); return; }
  if (b.hasAttribute('data-floordel')) { const old = p.room.floorTex; roomChange(r => { r.floorTex = null; }, false); delImage(old); }
});

$('#tab-room').addEventListener('change', async e => {
  if (!e.target.hasAttribute('data-floorfile')) return;
  const file = e.target.files[0];
  if (!file) return;
  const blob = await rectify(file, { aspect: 1, title: '框選一塊正方形的地板' });
  if (!blob) return;
  const id = await putImage(blob);
  const old = P().room.floorTex;
  roomChange(r => { r.floorTex = id; }, false);
  if (old) delImage(old);
  toast('框選區域的實際寬度可在下方調整');
});

// ---------- 擺法方案 ----------
function renderLay() {
  const box = $('#tab-lay');
  const p = P();
  if (!p) return;
  const lay = L(p);
  box.innerHTML = `
    <p class="mute small">同一個房間可以存好幾種擺法，切換比較。房間的形狀和門是共用的。</p>
    <div class="layList">${p.layouts.map(l => `
      <div class="layRow ${l.id === lay.id ? 'on' : ''}" data-id="${l.id}">
        <button class="ghost lname" data-a="open">${l.id === lay.id ? '● ' : '○ '}${esc(l.name)}<small>${l.items.length} 件物品</small></button>
        <button class="ghost" data-a="rename">改名</button>
        <button class="ghost danger" data-a="del" ${p.layouts.length <= 1 ? 'disabled' : ''}>刪除</button>
      </div>`).join('')}</div>
    <div class="btns"><button data-a="dup" class="primary">複製目前方案</button><button data-a="blank">新增空白方案</button></div>
    <div class="lbl">量測線</div>
    <p class="mute small">目前方案有 ${lay.measures.length} 條量測線。在 2D 上方切到「量測線」模式可以新增或刪除。</p>
    ${lay.measures.length ? '<button data-a="clearMeasures" class="danger">清除全部量測線</button>' : ''}`;
}

$('#tab-lay').addEventListener('click', e => {
  const a = e.target.closest('button')?.dataset.a;
  if (!a) return;
  const p = P();
  const id = e.target.closest('.layRow')?.dataset.id;
  const l = p.layouts.find(x => x.id === id);
  if (a === 'open' && l) { checkpoint(); p.activeLayout = l.id; S.sel = null; changed(); emit('selection'); return; }
  if (a === 'rename' && l) { const n = prompt('方案名稱', l.name); if (n?.trim()) { checkpoint(); l.name = n.trim(); changed(); } return; }
  if (a === 'del' && l) { if (!confirm(`刪除「${l.name}」？`)) return; checkpoint(); p.layouts = p.layouts.filter(x => x.id !== l.id); if (p.activeLayout === l.id) p.activeLayout = p.layouts[0].id; S.sel = null; changed(); emit('selection'); return; }
  if (a === 'dup' || a === 'blank') {
    checkpoint();
    const cur = L(p);
    const nl = newLayout(`方案 ${String.fromCharCode(65 + p.layouts.length)}`);
    if (a === 'dup') {
      const idMap = new Map();
      nl.items = cur.items.map(it => { const nid = uid(); idMap.set(it.id, nid); return { ...it, id: nid }; });
      const fix = r => (r.k === 'item' ? { ...r, id: idMap.get(r.id) } : { ...r });
      nl.measures = cur.measures.map(m => ({ id: uid(), a: fix(m.a), b: fix(m.b) }));
    }
    p.layouts.push(nl); p.activeLayout = nl.id; S.sel = null;
    changed(); emit('selection');
    toast(`已建立「${nl.name}」`);
    return;
  }
  if (a === 'clearMeasures') { checkpoint(); L(p).measures = []; changed(); }
});

// ---------- 專案（空間）清單 ----------
function openProjects() {
  const fmt = t => new Date(t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const m = modal('我的空間', `
    <div class="projList">${[...S.projects].sort((a, b) => b.updated - a.updated).map(p => `
      <div class="projRow ${p.id === S.projectId ? 'on' : ''}" data-id="${p.id}">
        <button class="ghost pname" data-a="open"><b>${esc(p.name)}</b><small>${p.room.mode === 'rect' ? `${cm(p.room.w)} × ${cm(p.room.d)} cm` : `${p.room.walls.length} 面牆`}・${p.layouts.length} 個方案・${fmt(p.updated)}</small></button>
        <button class="ghost" data-a="rename">改名</button><button class="ghost" data-a="copy">複製</button><button class="ghost danger" data-a="del">刪除</button>
      </div>`).join('')}</div>
    <div class="btns"><button data-a="new" class="primary">＋ 新空間</button></div>
    <p class="mute small">每個空間是一個獨立的專案（例如：現在的房間、下一個租屋處）。物品庫是共用的，所以同一批傢俱可以拿去不同空間試擺。</p>`);
  m.el.onclick = async e => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    const p = S.projects.find(x => x.id === e.target.closest('.projRow')?.dataset.id);
    if (a === 'new') {
      const name = prompt('新空間的名稱', '新空間');
      if (!name) return;
      m.close();
      await addProject(newProject(name.trim()));
      openSheet('room');
      toast('先在「房間」分頁填尺寸');
      return;
    }
    if (!p) return;
    if (a === 'open') { m.close(); openProject(p.id); return; }
    if (a === 'rename') { const n = prompt('空間名稱', p.name); if (n?.trim()) { p.name = n.trim(); await saveProjectNow(p); m.close(); openProjects(); } return; }
    if (a === 'copy') {
      const c = JSON.parse(JSON.stringify(p));
      c.id = uid(); c.name = p.name + '（副本）'; c.created = c.updated = Date.now();
      m.close(); await addProject(c); return;
    }
    if (a === 'del') { if (!confirm(`刪除「${p.name}」？這個動作無法復原（物品庫不受影響）。`)) return; await removeProject(p.id); m.close(); openProjects(); }
  };
}

// ---------- 選單：備份、設定、說明 ----------
function openMenu() {
  const canShare = !!navigator.canShare;
  const m = modal('選單', `
    <div class="lbl">備份與搬移</div>
    <p class="mute small">資料只存在<b>這台裝置的這個瀏覽器</b>。要在手機和電腦之間搬資料，請匯出備份檔，再到另一台裝置匯入（AirDrop 最快）。</p>
    <div class="btns"><button data-a="export" class="primary">下載備份檔</button>${canShare ? '<button data-a="share">分享／AirDrop</button>' : ''}
      <label class="btn">匯入備份檔<input type="file" accept=".json,application/json" hidden data-import></label></div>
    <div class="lbl">設定</div>
    <label class="inline">你的身高（cm）<input data-k="stature" type="number" inputmode="decimal" step="0.1" value="${cm(S.settings.stature)}"></label>
    <p class="mute small">3D 走動時的眼睛高度會用「身高 − 11 cm」估算，走動時也可以隨時調整。</p>
    <div class="lbl">操作說明</div>
    <ul class="help">
      <li><b>擺放</b>：只在 2D 擺。拖曳移動（預設以 1 cm 為單位，按住 Shift 微調 0.1 cm），靠近牆或其他物件的邊會自動貼齊。</li>
      <li><b>精確距離</b>：選取物件 → 點它的一條邊 → 點另一條邊（牆、門框、其他物件）→ 輸入距離。不平行的話會自動轉正。</li>
      <li><b>鎖定</b>：鎖住的物件不會被拖動，但可以當距離基準。</li>
      <li><b>量測線</b>：切到「量測線」模式，點兩條平行的邊，就會一直顯示它們之間的距離。</li>
      <li><b>快捷鍵</b>：⌘Z 復原、⇧⌘Z 重做、方向鍵移動 1 cm（Shift 0.1 cm）、R 旋轉 90°、L 鎖定、Delete 移出、Esc 取消。</li>
      <li><b>3D 走動</b>：WASD／方向鍵移動、拖曳轉頭、Shift 快走、R／F 升降視線；手機用左下搖桿。</li>
    </ul>
    <p class="mute small">v0.1・資料不會上傳到任何伺服器。</p>`);
  const el = m.el;
  el.querySelector('[data-k="stature"]').onchange = async e => {
    const v = toMM(e.target.value);
    if (v > 500) { S.settings.stature = v; await saveSettings(); toast('已更新身高'); }
  };
  el.querySelector('[data-import]').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const n = await importData(JSON.parse(await file.text()));
      m.close();
      toast(`已匯入：${n.proj} 個空間、${n.lib} 件物品、${n.img} 張照片`);
    } catch (err) { alert('匯入失敗：' + err.message); }
  };
  el.onclick = async e => {
    const a = e.target.closest('button')?.dataset.a;
    if (a !== 'export' && a !== 'share') return;
    const data = await exportData();
    const d = new Date();
    const name = `房間擺設備份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (a === 'share') {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch { /* 使用者取消 */ } return; }
    }
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}

// ---------- 側欄 / 手機底部抽屜 ----------
function setTab(t) {
  document.querySelectorAll('#side .tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['lib', 'room', 'lay'].forEach(x => { $('#tab-' + x).hidden = x !== t; });
  document.querySelectorAll('#mobileNav button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t && $('#side').classList.contains('open')));
}
function openSheet(t) { setTab(t); $('#side').classList.add('open'); setTab(t); }
function closeSheet() { $('#side').classList.remove('open'); setTab(document.querySelector('#side .tabs button.on')?.dataset.tab || 'lib'); }

$('#side .tabs').onclick = e => { const t = e.target.closest('button')?.dataset.tab; if (t) setTab(t); };
$('#sheetClose').onclick = closeSheet;
$('#mobileNav').onclick = e => {
  const t = e.target.closest('button')?.dataset.tab;
  if (!t) return;
  const open = $('#side').classList.contains('open');
  const cur = document.querySelector('#side .tabs button.on')?.dataset.tab;
  if (open && cur === t) closeSheet(); else openSheet(t);
};

// ---------- 2D / 3D ----------
async function setView(v) {
  view = v;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#c2d').hidden = v !== '2d';
  $('#tools2d').hidden = v !== '2d';
  $('#v3d').hidden = v !== '3d';
  $('#tools3d').hidden = v !== '3d';
  plan.active = v === '2d';
  if (v === '2d') { plan.resize(); v3d?.show(false); $('#joy').hidden = true; $('#walkHelp').hidden = true; }
  else {
    plan.cancelPick();
    if (!v3d) {
      $('#v3d').innerHTML = '<div class="loading">載入 3D…</div>';
      try {
        const { View3D } = await import('./view3d.js');
        $('#v3d').innerHTML = '';
        v3d = new View3D($('#v3d'), { onEye: cmv => { $('#eye').value = cmv; $('#eyeVal').textContent = cmv + ' cm'; } });
        v3d.bindJoystick($('#joy'));
      } catch (err) {
        $('#v3d').innerHTML = `<div class="loading">3D 載入失敗（需要網路）：${esc(err.message)}</div>`;
        return;
      }
    }
    if (view === '3d') { v3d.show(true); syncWalkUI(); }
  }
  renderInspector();
  updateHint();
}

function syncWalkUI() {
  const walk = v3d?.mode === 'walk';
  document.querySelectorAll('#camSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === (walk ? 'walk' : 'orbit')));
  $('#eyeBox').hidden = !walk;
  $('#btnPLock').hidden = !walk || matchMedia('(pointer: coarse)').matches;
  $('#joy').hidden = !walk || !matchMedia('(pointer: coarse)').matches;
  $('#walkHelp').hidden = !walk;
  $('#walkHelp').textContent = matchMedia('(pointer: coarse)').matches
    ? '左下搖桿移動・在畫面上滑動轉頭'
    : 'WASD／方向鍵移動・拖曳轉頭・Shift 快走・R／F 升降視線';
  if (walk) { const e = Math.round(v3d.eye * 100); $('#eye').value = e; $('#eyeVal').textContent = e + ' cm'; }
}

$('#viewSeg').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v && v !== view) setView(v); };
$('#camSeg').onclick = e => {
  const m = e.target.closest('button')?.dataset.m;
  if (!m || !v3d) return;
  if (m === 'walk') v3d.eye = (S.settings.stature - 110) / 1000;
  v3d.setMode(m);
  syncWalkUI();
};
$('#eye').oninput = e => { v3d?.setEye(+e.target.value); $('#eyeVal').textContent = e.target.value + ' cm'; };
$('#btnPLock').onclick = () => { v3d?.lockPointer(); toast('移動滑鼠轉頭，按 Esc 離開'); };

$('#modeSeg').onclick = e => {
  const m = e.target.closest('button')?.dataset.m;
  if (!m) return;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  plan.setMode(m);
};
$('#zoomIn').onclick = () => plan.zoomAt(plan.w / 2, plan.h / 2, 1.25);
$('#zoomOut').onclick = () => plan.zoomAt(plan.w / 2, plan.h / 2, 0.8);
$('#zoomFit').onclick = () => plan.fit();

$('#btnUndo').onclick = () => undo();
$('#btnRedo').onclick = () => redo();
$('#btnProj').onclick = openProjects;
$('#btnMenu').onclick = openMenu;

function renderTitle() { $('#projName').textContent = P()?.name || ''; document.title = `${P()?.name || ''}・房間擺設`; }

// ---------- 鍵盤 ----------
window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || !$('#modal').hidden || document.querySelector('.rectify')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (view !== '2d') return;
  if (e.key === 'Escape') {
    if (plan.pick) plan.cancelPick();
    else if (plan.mode === 'measure') { plan.mpick = null; $('#modeSeg [data-m="select"]').click(); }
    else if (S.sel) { S.sel = null; emit('selection'); }
    return;
  }
  const it = selItem();
  if (!it) return;
  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (arrows[e.key]) {
    e.preventDefault();
    if (it.locked) { toast('已鎖定'); return; }
    const st = e.shiftKey ? 1 : 10;
    checkpoint(); it.x += arrows[e.key][0] * st; it.y += arrows[e.key][1] * st; changed();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('#inspector [data-a="del"]')?.click(); return; }
  if (e.key === 'r' || e.key === 'R') { $('#inspector [data-a="cw"]')?.click(); return; }
  if (e.key === 'l' || e.key === 'L') { $('#inspector [data-a="lock"]')?.click(); }
});

// ---------- 事件串接 ----------
const ui = { toast, updateHint, showDistance, hideDistance, refreshInspector: () => {
  const it = selItem(); const inp = $('#inspector [data-k="rot"]');
  if (it && inp && document.activeElement !== inp) inp.value = +it.rot.toFixed(1);
} };

on(what => {
  if (what === 'switch') { plan.needFit = true; plan.fit(); plan.pick = null; plan.mpick = null; hideDistance(); renderTitle(); }
  if (['project', 'library', 'images', 'switch', 'selection'].includes(what)) plan.draw();
  if (what === 'project' || what === 'switch') {
    renderRoom();
    renderLay(); renderLib(); renderInspector();
  }
  if (what === 'library' || what === 'images') { renderLib(); renderInspector(); if (what === 'images') renderRoom(); }
  if (what === 'selection') renderInspector();
  if (what === 'projects') renderTitle();
  if (what === 'history') { const h = histState(); $('#btnUndo').disabled = !h.u; $('#btnRedo').disabled = !h.r; }
  if (v3d && ['project', 'library', 'images', 'switch', 'settings'].includes(what)) v3d.markDirty();
  updateHint();
});


// ---------- 啟動 ----------
(async function start() {
  await loadAll();
  plan = new Plan2D($('#c2d'), ui);
  window.__rp = { plan, get v3d() { return v3d; } }; // 除錯用
  renderTitle(); renderLib(); renderRoom(); renderLay(); renderInspector();
  setTab('lib');
  emit('history');
  updateHint();
  if (!S.library.length && P().room.w === 3000 && P().room.mode === 'rect' && !L().items.length) {
    setTimeout(() => { isMobile() ? openSheet('room') : setTab('room'); toast('歡迎！先在「房間」填入你量的尺寸'); }, 300);
  }
})();
