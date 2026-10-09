// 幾何：房間多邊形、牆、門、物件的邊，以及「可作為距離基準的邊」
import { V, polyArea } from './util.js';

export const WALL_T = 100; // 2D 顯示用的牆厚（mm）

export const cornerName = i => String.fromCharCode(65 + (i % 26));

// 由輸入資料產生房間多邊形（座標：x 往右、y 往下，單位 mm）
export function buildRoom(room) {
  if (room.mode === 'rect') {
    const { w, d } = room;
    return { poly: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }], gap: 0 };
  }
  const walls = room.walls || [];
  const n = walls.length;
  if (n < 3) return { poly: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], gap: 0 };
  // 從角 A 出發，沿牆（俯視順時針）走一圈；turn 為右轉角度
  let p = { x: 0, y: 0 }, th = 0;
  const pts = [p];
  for (const w of walls) {
    p = { x: p.x + w.len * Math.cos(th), y: p.y + w.len * Math.sin(th) };
    pts.push(p);
    th += (w.turn * Math.PI) / 180;
  }
  const end = pts[n];
  const gap = Math.hypot(end.x, end.y);
  let poly;
  if (room.closure === 'last') {
    poly = pts.slice(0, n); // 最後一面牆直接接回起點
  } else {
    // 依累積長度把閉合誤差平均分到各個角
    const total = walls.reduce((s, w) => s + w.len, 0) || 1;
    let cum = 0;
    poly = [pts[0]];
    for (let i = 1; i < n; i++) {
      cum += walls[i - 1].len;
      const f = cum / total;
      poly.push({ x: pts[i].x - end.x * f, y: pts[i].y - end.y * f });
    }
  }
  return { poly, gap };
}

export function wallEdges(poly) {
  const s = Math.sign(polyArea(poly)) || 1;
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const u = V.norm(V.sub(b, a));
    const n = s > 0 ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x }; // 指向室內
    return { a, b, u, n, len: V.len(V.sub(b, a)), mid: V.mid(a, b), i };
  });
}

export function itemCorners(it, li) {
  const r = (it.rot * Math.PI) / 180, w = li.w / 2, d = li.d / 2;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, y]) => V.add({ x: it.x, y: it.y }, V.rot({ x, y }, r)));
}

// 物件的 4 條邊（圓形物件用外接矩形的切線）；n 指向物件外側
export function itemEdges(it, li) {
  const c = itemCorners(it, li);
  const ctr = { x: it.x, y: it.y };
  return c.map((a, i) => {
    const b = c[(i + 1) % 4];
    const mid = V.mid(a, b);
    const u = V.norm(V.sub(b, a));
    let n = { x: -u.y, y: u.x };
    if (V.dot(V.sub(mid, ctr), n) < 0) n = V.scale(n, -1);
    return { a, b, u, n, mid, len: V.len(V.sub(b, a)), i };
  });
}

export function doorGeom(door, walls) {
  const W = walls[door.wall];
  if (!W) return null;
  const a = V.add(W.a, V.scale(W.u, door.off));
  const b = V.add(W.a, V.scale(W.u, door.off + door.w));
  const end = door.hinge === 'end';
  return {
    a, b, W, u: W.u, n: W.n, w: door.w,
    hinge: end ? b : a,
    other: end ? a : b,
    open: V.scale(W.n, door.swing === 'out' ? -1 : 1),
  };
}

export const refKey = r => (r.k === 'wall' ? `wall:${r.i}` : r.k === 'door' ? `door:${r.id}:${r.s}` : `${r.k}:${r.id}:${r.e}`);

// 所有可被選為距離基準的邊
export function refEdges(p, lay, libFn, walls) {
  const out = [];
  walls.forEach((e, i) => out.push({
    ref: { k: 'wall', i }, kind: 'wall', a: e.a, b: e.b, u: e.u, n: e.n, len: e.len, mid: e.mid,
    label: `牆 ${i + 1}（${cornerName(i)}–${cornerName((i + 1) % walls.length)}）`,
  }));
  (p.room.doors || []).forEach((d, j) => {
    const g = doorGeom(d, walls);
    if (!g) return;
    [[g.a, g.u], [g.b, V.scale(g.u, -1)]].forEach(([pt, nn], s) => {
      const a = V.add(pt, V.scale(g.n, -WALL_T)), b = V.add(pt, V.scale(g.n, 200));
      out.push({ ref: { k: 'door', id: d.id, s }, kind: 'door', a, b, u: g.n, n: nn, len: WALL_T + 200, mid: V.mid(a, b), label: `${nm(d, `門 ${j + 1}`)} 的門框` });
    });
  });
  (p.room.boxes || []).forEach((bx, j) => {
    const W = walls[bx.wall];
    if (!W) return;
    const at = t => V.add(W.a, V.scale(W.u, t)), fr = t => V.add(at(t), V.scale(W.n, bx.depth));
    const t0 = bx.off, t1 = bx.off + bx.w, label = nm(bx, `量體 ${j + 1}`);
    out.push({ ref: { k: 'box', id: bx.id, e: 0 }, kind: 'box', a: fr(t0), b: fr(t1), u: W.u, n: W.n, len: bx.w, mid: fr((t0 + t1) / 2), label: `${label} 前緣` });
    out.push({ ref: { k: 'box', id: bx.id, e: 1 }, kind: 'box', a: at(t0), b: fr(t0), u: W.n, n: V.scale(W.u, -1), len: bx.depth, mid: V.mid(at(t0), fr(t0)), label: `${label} 側邊` });
    out.push({ ref: { k: 'box', id: bx.id, e: 2 }, kind: 'box', a: at(t1), b: fr(t1), u: W.n, n: W.u, len: bx.depth, mid: V.mid(at(t1), fr(t1)), label: `${label} 側邊` });
  });
  (p.room.beams || []).forEach((bm, j) => {
    const g = beamGeom(bm, walls);
    if (!g) return;
    const label = nm(bm, `樑 ${j + 1}`), q = g.quad;
    out.push({ ref: { k: 'beam', id: bm.id, e: 0 }, kind: 'beam', a: q[0], b: q[1], u: g.W.u, n: V.scale(g.W.n, -1), len: g.t1 - g.t0, mid: V.mid(q[0], q[1]), label: `${label} 邊緣` });
    out.push({ ref: { k: 'beam', id: bm.id, e: 1 }, kind: 'beam', a: q[3], b: q[2], u: g.W.u, n: g.W.n, len: g.t1 - g.t0, mid: V.mid(q[3], q[2]), label: `${label} 邊緣` });
  });
  const sk = p.room.skirting;
  if (sk?.on) walls.forEach((W, i) => skirtSegs(p.room, i, W).forEach(([t0, t1], k) => {
    const a = V.add(V.add(W.a, V.scale(W.u, t0)), V.scale(W.n, sk.t)), b = V.add(V.add(W.a, V.scale(W.u, t1)), V.scale(W.n, sk.t));
    out.push({ ref: { k: 'skirt', id: `${i}`, e: k }, kind: 'skirt', a, b, u: W.u, n: W.n, len: t1 - t0, mid: V.mid(a, b), label: `牆 ${i + 1} 踢腳線` });
  }));
  for (const it of lay.items) {
    const li = libFn(it.libId);
    if (!li || li.shape === 'wall') continue;
    for (const e of itemEdges(it, li)) out.push({
      ref: { k: 'item', id: it.id, e: e.i }, kind: 'item', owner: it.id,
      a: e.a, b: e.b, u: e.u, n: e.n, len: e.len, mid: e.mid, label: li.name,
    });
  }
  for (const r of out) r.key = refKey(r.ref);
  return out;
}

export const isParallel = (e1, e2) => Math.abs(V.cross(e1.u, e2.u)) < 0.009; // 約 0.5°

// 兩條平行邊之間的量測線（取兩邊重疊範圍的中間）
export function measureGeom(e1, e2) {
  const t2a = V.dot(V.sub(e2.a, e1.a), e1.u), t2b = V.dot(V.sub(e2.b, e1.a), e1.u);
  const lo = Math.max(0, Math.min(t2a, t2b)), hi = Math.min(e1.len, Math.max(t2a, t2b));
  const t = lo <= hi ? (lo + hi) / 2 : Math.max(0, Math.min(e1.len, (t2a + t2b) / 2));
  const p1 = V.add(e1.a, V.scale(e1.u, t));
  const s = V.dot(V.sub(p1, e2.a), e2.n);
  return { p1, p2: V.sub(p1, V.scale(e2.n, s)), dist: Math.abs(s) };
}

// ---------- v0.4：內外牆、牆面量體、窗戶所在面 ----------
export const isInterior = (room, i) => (room.interior || []).includes(i);

// 牆面量體（貼牆凸出的箱體，例如舊冷氣窗台）：t0..t1 沿牆、z0..z1 高度、depth 往房內凸出
export function boxGeom(b, walls, H) {
  const W = walls[b.wall];
  if (!W) return null;
  const z1 = b.toCeil ? H : Math.min(H, b.bottom + b.h);
  return { W, t0: b.off, t1: b.off + b.w, z0: b.bottom, z1, depth: b.depth };
}

// 窗戶所在平面離牆面多遠（開在量體正面時＝量體深度）
export function winDepth(room, w) {
  if (!w.host) return 0;
  const b = (room.boxes || []).find(x => x.id === w.host);
  return b ? b.depth : 0;
}

// ---------- v0.5：自訂名稱、樑、踢腳線 ----------
export const nm = (o, def) => (o && o.name && o.name.trim()) || def;

// 樑：平行於某面牆、距牆 dist、寬 w、從天花板往下凸 drop；長度延伸到房間另一側的牆
export function beamGeom(b, walls) {
  const W = walls[b.wall];
  if (!W) return null;
  const p0 = V.add(W.a, V.scale(W.n, b.dist + b.w / 2));
  const ts = [];
  for (const e of walls) {
    const den = V.cross(W.u, e.u);
    if (Math.abs(den) < 1e-9) continue;
    const t = V.cross(V.sub(e.a, p0), e.u) / den, s = V.cross(V.sub(e.a, p0), W.u) / den;
    if (s >= -1e-6 && s <= e.len + 1e-6) ts.push(t);
  }
  if (ts.length < 2) return null;
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const at = (t, d) => V.add(V.add(W.a, V.scale(W.u, t)), V.scale(W.n, d));
  return { W, t0, t1, d0: b.dist, d1: b.dist + b.w, quad: [at(t0, b.dist), at(t1, b.dist), at(t1, b.dist + b.w), at(t0, b.dist + b.w)] };
}

// 踢腳線沿牆的區段（扣掉門洞）
export function skirtSegs(room, i, W) {
  const cuts = (room.doors || []).filter(d => d.wall === i).map(d => [d.off, d.off + d.w]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = 0;
  for (const [a, b] of cuts) { if (a > t + 1) out.push([t, Math.min(a, W.len)]); t = Math.max(t, b); }
  if (W.len > t + 1) out.push([t, W.len]);
  return out;
}
