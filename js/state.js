// 全域狀態、存檔、復原/重做、物品庫、圖片、備份匯出入
import { db } from './db.js';
import { uid } from './util.js';

export const S = {
  library: [],
  projects: [],
  projectId: null,
  settings: { id: 'settings', stature: 1700 },
  sel: null, // 目前選取的物件實例 id
};

const subs = new Set();
export const on = f => subs.add(f);
export const emit = what => { for (const f of subs) f(what); };

export const P = () => S.projects.find(p => p.id === S.projectId) || null;
export const L = (p = P()) => (p ? p.layouts.find(l => l.id === p.activeLayout) || p.layouts[0] : null);
export const lib = id => S.library.find(x => x.id === id);
export const isRug = li => !!li && (li.shape === 'rug' || li.shape === 'rugRound');
export const isRound = li => !!li && (li.shape === 'cyl' || li.shape === 'rugRound');
export const isWall = li => !!li && li.shape === 'wall'; // 牆面物件：畫、海報、鏡子
export const selItem = () => { const l = L(); return l && S.sel ? l.items.find(i => i.id === S.sel) || null : null; };

export function defaultRoom() {
  return {
    mode: 'rect', w: 3000, d: 3000,
    walls: [{ len: 3000, turn: 90 }, { len: 3000, turn: 90 }, { len: 3000, turn: 90 }, { len: 3000, turn: 90 }],
    closure: 'distribute', height: 2600, doors: [], windows: [], boxes: [], interior: [],
    wallColor: '#eeeae3', floorColor: '#c9a985', floorTex: null, floorTile: 300,
    north: 0, lat: null, lng: null, // 日光模式預留
  };
}

export function newLayout(name) { return { id: uid(), name, items: [], measures: [] }; }

export function newProject(name = '新空間') {
  const lay = newLayout('方案 A');
  return { id: uid(), name, room: defaultRoom(), layouts: [lay], activeLayout: lay.id, created: Date.now(), updated: Date.now() };
}

// ---------- 存檔（延遲寫入） ----------
const pending = new Map();
function scheduleSave(p) {
  clearTimeout(pending.get(p.id));
  pending.set(p.id, setTimeout(() => { pending.delete(p.id); db.put('projects', p).catch(console.error); }, 300));
}
export async function flushSaves() {
  for (const [id, t] of pending) {
    clearTimeout(t);
    const p = S.projects.find(x => x.id === id);
    if (p) await db.put('projects', p);
  }
  pending.clear();
}
window.addEventListener('pagehide', () => { flushSaves(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });

// ---------- 復原 / 重做 ----------
let undoStack = [], redoStack = [];
export function checkpoint() {
  const p = P();
  if (!p) return;
  undoStack.push(JSON.stringify(p));
  if (undoStack.length > 150) undoStack.shift();
  redoStack = [];
  emit('history');
}
export function changed(kind = 'project') {
  const p = P();
  if (!p) return;
  p.updated = Date.now();
  scheduleSave(p);
  emit(kind);
}
function restore(json) {
  const np = JSON.parse(json);
  const i = S.projects.findIndex(x => x.id === np.id);
  if (i < 0) return;
  S.projects[i] = np;
  if (S.sel && !L(np).items.some(it => it.id === S.sel)) S.sel = null;
  scheduleSave(np);
  emit('project'); emit('selection'); emit('history');
}
export function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(P())); restore(undoStack.pop()); }
export function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(P())); restore(redoStack.pop()); }
export const histState = () => ({ u: undoStack.length, r: redoStack.length });
function clearHistory() { undoStack = []; redoStack = []; emit('history'); }

// ---------- 專案 ----------
export function openProject(id) {
  S.projectId = id; S.sel = null;
  clearHistory();
  db.put('kv', { id: 'last', value: id });
  emit('switch'); emit('project'); emit('selection');
}
export async function addProject(p) {
  S.projects.push(p);
  await db.put('projects', p);
  openProject(p.id);
}
export async function removeProject(id) {
  S.projects = S.projects.filter(p => p.id !== id);
  await db.del('projects', id);
  if (S.projectId === id) {
    if (!S.projects.length) await addProject(newProject('我的房間'));
    else openProject(S.projects[0].id);
  }
  emit('projects');
}
export async function saveProjectNow(p) { p.updated = Date.now(); await db.put('projects', p); emit('projects'); }

// 移除已不存在物件的量測線
export function pruneMeasures(lay) {
  const ids = new Set(lay.items.map(i => i.id));
  lay.measures = lay.measures.filter(m => [m.a, m.b].every(r => r.k !== 'item' || ids.has(r.id)));
}

// ---------- 物品庫 ----------
export async function saveLib(item) {
  item.updated = Date.now();
  const i = S.library.findIndex(x => x.id === item.id);
  if (i < 0) S.library.push(item); else S.library[i] = item;
  await db.put('library', item);
  emit('library');
}
export function usage(id) {
  return S.projects.filter(p => p.layouts.some(l => l.items.some(it => it.libId === id)));
}
export async function deleteLib(id) {
  for (const p of S.projects) {
    let touched = false;
    for (const l of p.layouts) {
      const n = l.items.length;
      l.items = l.items.filter(it => it.libId !== id);
      if (l.items.length !== n) { touched = true; pruneMeasures(l); }
    }
    if (touched) { p.updated = Date.now(); await db.put('projects', p); }
  }
  const li = lib(id);
  S.library = S.library.filter(x => x.id !== id);
  await db.del('library', id);
  if (li?.tex) await delImage(li.tex);
  if (S.sel && !selItem()) S.sel = null;
  clearHistory();
  emit('library'); emit('project'); emit('selection');
}

// ---------- 圖片 ----------
const imgCache = new Map();
export async function putImage(blob) {
  const id = 'img_' + uid();
  await db.put('images', { id, blob });
  return id;
}
export async function delImage(id) {
  if (!id) return;
  const c = imgCache.get(id);
  if (c?.img) URL.revokeObjectURL(c.img.src);
  imgCache.delete(id);
  await db.del('images', id);
}
// 同步取得已載入的圖片；尚未載入則觸發載入，完成後發出 'images'
export function getImg(id) {
  if (!id) return null;
  let c = imgCache.get(id);
  if (c) return c.img;
  c = { img: null };
  imgCache.set(id, c);
  db.get('images', id).then(r => {
    if (!r) return;
    const im = new Image();
    im.onload = () => { c.img = im; emit('images'); };
    im.src = URL.createObjectURL(r.blob);
  });
  return null;
}

// ---------- 設定 ----------
export async function saveSettings() { await db.put('kv', S.settings); emit('settings'); }

// ---------- 載入 ----------
export async function loadAll() {
  S.library = await db.all('library');
  S.projects = await db.all('projects');
  const st = await db.get('kv', 'settings');
  if (st) Object.assign(S.settings, st);
  const last = await db.get('kv', 'last');
  if (!S.projects.length) {
    const p = newProject('我的房間');
    S.projects.push(p);
    await db.put('projects', p);
  }
  for (const p of S.projects) { p.room.windows ||= []; p.room.boxes ||= []; p.room.interior ||= []; } // 舊版資料補欄位
  S.projectId = last && S.projects.some(p => p.id === last.value) ? last.value : S.projects[0].id;
  try { await navigator.storage?.persist?.(); } catch { /* 不支援就算了 */ }
}

// ---------- 備份 ----------
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

export async function exportData() {
  await flushSaves();
  const images = [];
  for (const im of await db.all('images')) images.push({ id: im.id, data: await blobToDataURL(im.blob) });
  return { app: 'room-planner', v: 1, at: Date.now(), settings: S.settings, library: S.library, projects: S.projects, images };
}

export async function importData(data) {
  if (data?.app !== 'room-planner') throw new Error('這不是房間擺設的備份檔');
  const n = { proj: 0, lib: 0, img: 0 };
  for (const im of data.images || []) {
    const blob = await (await fetch(im.data)).blob();
    await db.put('images', { id: im.id, blob });
    imgCache.delete(im.id);
    n.img++;
  }
  // 同一個 id 以「較新的」為準
  for (const li of data.library || []) {
    const ex = lib(li.id);
    if (!ex || (li.updated || 0) >= (ex.updated || 0)) { await db.put('library', li); n.lib++; }
  }
  for (const p of data.projects || []) {
    const ex = S.projects.find(x => x.id === p.id);
    if (!ex || (p.updated || 0) >= (ex.updated || 0)) { await db.put('projects', p); n.proj++; }
  }
  S.library = await db.all('library');
  S.projects = await db.all('projects');
  for (const p of S.projects) { p.room.windows ||= []; p.room.boxes ||= []; p.room.interior ||= []; }
  if (!S.projects.some(p => p.id === S.projectId)) S.projectId = S.projects[0]?.id;
  S.sel = null;
  clearHistory();
  emit('switch'); emit('project'); emit('library'); emit('images'); emit('projects');
  return n;
}
