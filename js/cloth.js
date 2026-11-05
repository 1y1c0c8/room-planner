// 布的垂墜：用質點＋距離約束（PBD／Verlet）模擬布自然下垂，結果依輸入快取
// 兩種布：
//  cloth（掛在牆上）：以錨點（it.off, it.elev）為原點；x＝面對牆時往右、y＝往上、z＝離開牆面往房內
//    釘子 it.pins = [{ u, v, x, y }]：(u,v)＝布上的點（0–1，u 從左、v 從上緣量），(x,y)＝釘在牆上的位置（相對錨點）
//  throw（披蓋：桌巾、床罩）：以平面圖上的中心（it.x, it.y）、地板為原點，跟著 it.rot 轉；x＝寬、z＝長（2D 往下）、y＝往上
//    攤平從上方放下，落在底下的傢俱上
import { V } from './util.js?v=0.12.0';

export const DRAPES = {
  soft: ['柔軟（絲巾、薄紗）', 0.015, 0.25],
  normal: ['一般（棉布、床單）', 0.08, 0.6],
  stiff: ['挺（帆布、掛毯、毛氈）', 0.35, 1],
};
const G = 9810; // mm/s²
const SKIP = ['wall', 'cloth', 'throw', 'rug', 'rugRound', 'model'];

// 布攤平的尺寸：w＝寬、len＝長、t＝厚度（披蓋的布在物品庫裡是 寬 w × 長 d × 厚 h，才能像傢俱一樣在 2D 擺放）
export const sheet = li => (li.shape === 'throw' ? { w: li.w, len: li.d, t: li.h } : { w: li.w, len: li.h, t: li.d });

export const defaultPins = li => [
  { u: 0, v: 0, x: -li.w / 2, y: li.h / 2 },
  { u: 1, v: 0, x: li.w / 2, y: li.h / 2 },
];
export const pinsOf = (it, li) => (li.shape === 'throw' ? [] : it.pins?.length ? it.pins : defaultPins(li));

// 傢俱 → 碰撞體 [cx, cz, axx, axz, azx, azz, 半寬, 半深, 頂面高, 俯視圓角, 是否圓形]（轉到布的座標系）
function collider(o, ol, origin, ex, ez, yOff) {
  const c = V.sub({ x: o.x, y: o.y }, origin);
  const r = (o.rot * Math.PI) / 180, ax = { x: Math.cos(r), y: Math.sin(r) }, az = { x: -Math.sin(r), y: Math.cos(r) };
  const R = ol.shape === 'box' ? Math.min(Math.max(+ol.rr || 0, 0), Math.min(ol.w, ol.d) / 2) : 0;
  return [V.dot(c, ex), V.dot(c, ez), V.dot(ax, ex), V.dot(ax, ez), V.dot(az, ex), V.dot(az, ez), ol.w / 2, ol.d / 2, ol.h - yOff, R]
    .map(v => Math.round(v * 10) / 10).concat(ol.shape === 'cyl' ? 1 : 0);
}

// 牆上的布：地板高度、附近的傢俱
export function clothEnv(it, li, W, items, libFn) {
  const base = V.add(W.a, V.scale(W.u, it.off));
  const right = { x: W.n.y, y: -W.n.x };
  const reach = li.w + li.h;
  const boxes = [];
  for (const o of items) {
    const ol = libFn(o.libId);
    if (!ol || SKIP.includes(ol.shape)) continue;
    const b = collider(o, ol, base, right, W.n, it.elev), ext = Math.hypot(ol.w, ol.d) / 2;
    if (Math.abs(b[0]) > reach + ext || b[1] - ext > reach || b[1] + ext < -10) continue;
    boxes.push(b);
  }
  return { floor: -it.elev, boxes, wallPlane: true, walls: [] };
}

// 披蓋的布：附近的傢俱、牆（布垂到牆邊會被擋住）
export function throwEnv(it, li, items, libFn, walls) {
  const r = (it.rot * Math.PI) / 180, ex = { x: Math.cos(r), y: Math.sin(r) }, ez = { x: -Math.sin(r), y: Math.cos(r) };
  const reach = Math.hypot(li.w, li.d) / 2;
  const boxes = [];
  for (const o of items) {
    const ol = libFn(o.libId);
    if (!ol || o.id === it.id || SKIP.includes(ol.shape)) continue;
    const b = collider(o, ol, it, ex, ez, 0);
    if (Math.hypot(b[0], b[1]) > reach + Math.hypot(ol.w, ol.d) / 2) continue;
    boxes.push(b);
  }
  const ws = [];
  for (const W of walls || []) {
    const a = V.sub(W.a, it);
    const s = V.dot(V.scale(a, -1), W.n); // 中心離這面牆多遠（房內為正）
    if (s > reach + 50) continue;
    ws.push([V.dot(a, ex), V.dot(a, ez), V.dot(W.u, ex), V.dot(W.u, ez), V.dot(W.n, ex), V.dot(W.n, ez), W.len].map(v => Math.round(v * 1000) / 1000));
  }
  return { floor: 0, boxes, wallPlane: false, walls: ws };
}

const cache = new Map();
const keyOf = (li, pins, env) => JSON.stringify([li.shape, li.w, li.h, li.d, li.drape || 'normal', pins.map(p => [p.u, p.v, Math.round(p.x), Math.round(p.y)]), Math.round(env.floor), env.boxes, env.walls]);

// 主函式：回傳 { nx, ny, pos(Float32Array, nx*ny*3), box:{x0,x1,y0,y1,z0,z1}, tight, pinNodes }
// warm：拖曳釘子時用上一次的結果當起點，跑少一點步數（即時預覽）
// lazy：拖曳中（物件或旁邊的傢俱在動）先沿用這件布上一次的形狀，放手後才重新模擬
const lastById = new Map();
export const setLazy = on => { lazy = !!on; };
let lazy = false;
export function drape(li, it, env, warm = null) {
  const pins = pinsOf(it, li);
  const key = keyOf(li, pins, env);
  if (!warm) {
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); lastById.set(it.id, hit); return hit; }
    const old = lastById.get(it.id);
    if (lazy && old) return old;
  }
  const r = simulate(li, pins, { walls: [], ...env }, warm);
  if (!warm) {
    cache.set(key, r);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  lastById.set(it.id, r);
  return r;
}

function grid(w, len) {
  const sp = Math.min(Math.max(Math.max(w, len) / 26, 8), 80);
  const nx = Math.min(Math.max(Math.round(w / sp) + 1, 3), 33);
  const ny = Math.min(Math.max(Math.round(len / sp) + 1, 3), 33);
  return { nx, ny };
}

// 一個點推出傢俱外（俯視圓角、圓形都算）；回傳是否碰到
function pushOut(pos, p, b, gap) {
  const [cx, cz, axx, axz, azx, azz, hw, hd, top, R, round] = b;
  const x = pos[p], y = pos[p + 1], z = pos[p + 2];
  if (y > top + gap) return false;
  const dx = x - cx, dz = z - cz;
  const lx = dx * axx + dz * axz, lz = dx * azx + dz * azz;
  let nlx = 0, nlz = 0, pen;
  if (round) {
    const ex = lx / (hw + gap), ez = lz / (hd + gap), d = Math.hypot(ex, ez);
    if (d >= 1) return false;
    const L = Math.hypot(lx, lz);
    pen = L > 1e-6 ? L * (1 / Math.max(d, 1e-6) - 1) : Math.min(hw, hd) + gap;
    if (L > 1e-6) { nlx = lx / L; nlz = lz / L; } else nlx = 1;
  } else {
    const r = Math.min(R, hw, hd), qx = Math.abs(lx) - (hw - r), qz = Math.abs(lz) - (hd - r);
    let dist;
    if (qx > 0 && qz > 0) { const q = Math.hypot(qx, qz); dist = q - r; nlx = Math.sign(lx) * qx / q; nlz = Math.sign(lz) * qz / q; }
    else { dist = Math.max(qx, qz) - r; if (qx > qz) nlx = Math.sign(lx) || 1; else nlz = Math.sign(lz) || 1; }
    pen = gap - dist;
    if (pen <= 0) return false;
  }
  const py = top + gap - y;
  if (py < pen) pos[p + 1] = top + gap;
  else { pos[p] += (nlx * axx + nlz * azx) * pen; pos[p + 2] += (nlx * axz + nlz * azz) * pen; }
  return true;
}

function simulate(li, pins, env, warm) {
  const thr = li.shape === 'throw';
  const { w, len: h, t } = sheet(li);
  const { nx, ny } = grid(w, h);
  const n = nx * ny;
  const gap = Math.max(t || 1, 1) / 2 + 0.5;
  const [, bendK, shearK] = DRAPES[li.drape] || DRAPES.normal;
  const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3), inv = new Float32Array(n).fill(1);
  const idx = (i, j) => j * nx + i;
  const { boxes, walls } = env, floor = env.floor + gap;

  // 釘子 → 最近的格點
  const pinNodes = [];
  for (const p of pins) {
    const i = Math.round(clampN(p.u, 0, 1) * (nx - 1)), j = Math.round(clampN(p.v, 0, 1) * (ny - 1));
    const k = idx(i, j);
    if (pinNodes.some(q => q.k === k)) continue;
    pinNodes.push({ k, tx: p.x, ty: p.y });
    inv[k] = 0;
  }

  // 起始狀態
  const warmOk = warm && warm.nx === nx && warm.ny === ny;
  let ox = 0, oy = 0, y0 = gap + 2;
  if (thr) {
    // 披蓋：攤平放在「布底下最高的那件傢俱」頂面上方一點點，再放手
    for (const b of boxes) {
      const ext = Math.hypot(b[6], b[7]);
      if (Math.abs(b[0]) < w / 2 + ext && Math.abs(b[1]) < h / 2 + ext && covers(b, w, h)) y0 = Math.max(y0, b[8] + gap + 3);
    }
  } else if (!warmOk && pinNodes.length) {
    // 牆上：攤平的布平移到釘子的重心附近（避免一開始被猛拉）
    for (const q of pinNodes) {
      const i = q.k % nx, j = (q.k - i) / nx;
      ox += q.tx - (-w / 2 + (i / (nx - 1)) * w); oy += q.ty - (h / 2 - (j / (ny - 1)) * h);
    }
    ox /= pinNodes.length; oy /= pinNodes.length;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = idx(i, j) * 3;
    if (warmOk) { pos[k] = warm.pos[k]; pos[k + 1] = warm.pos[k + 1]; pos[k + 2] = warm.pos[k + 2]; }
    else if (thr) {
      pos[k] = -w / 2 + (i / (nx - 1)) * w;
      pos[k + 1] = y0 + 1.5 * hash(i, j);
      pos[k + 2] = -h / 2 + (j / (ny - 1)) * h;
    } else {
      pos[k] = -w / 2 + (i / (nx - 1)) * w + ox;
      pos[k + 1] = h / 2 - (j / (ny - 1)) * h + oy;
      pos[k + 2] = gap + 1.5 + 2.5 * hash(i, j); // 一點點起伏，讓被擠壓的地方往外拱出皺褶
    }
  }
  const start = pinNodes.map(q => [pos[q.k * 3], pos[q.k * 3 + 1], pos[q.k * 3 + 2]]);
  prev.set(pos);

  // 約束：結構（相鄰）、剪切（對角）、彎曲（隔一格）
  const flat = (q, d) => { const i = q % nx, j = (q - i) / nx; return d === 0 ? (i / (nx - 1)) * w : (j / (ny - 1)) * h; };
  const ca = [], cb = [], cr = [], ck = [];
  const add = (a, b, k) => { ca.push(a); cb.push(b); ck.push(k); cr.push(Math.hypot(flat(a, 0) - flat(b, 0), flat(a, 1) - flat(b, 1))); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = idx(i, j);
    if (i + 1 < nx) add(a, idx(i + 1, j), 1);
    if (j + 1 < ny) add(a, idx(i, j + 1), 1);
    if (i + 1 < nx && j + 1 < ny) { add(a, idx(i + 1, j + 1), shearK); add(idx(i + 1, j), idx(i, j + 1), shearK); }
    if (i + 2 < nx) add(a, idx(i + 2, j), bendK);
    if (j + 2 < ny) add(a, idx(i, j + 2), bendK);
  }
  const C = ca.length, A = Int32Array.from(ca), B = Int32Array.from(cb), R = Float32Array.from(cr), K = Float32Array.from(ck);

  // 拴繩約束：每個點離每個釘子不能超過布上的距離（不然布會被重力拉長，像橡皮）
  // 披蓋的布沒有釘子：改用布的中心拴住其他點（離中心的距離不會超過攤平時的距離，這永遠成立）
  const anchors = thr ? [[0.5, 0.5]].map(([u, v]) => idx(Math.round(u * (nx - 1)), Math.round(v * (ny - 1)))) : pinNodes.map(q => q.k);
  const tether = anchors.map(a => {
    const d = new Float32Array(n);
    for (let k = 0; k < n; k++) d[k] = Math.hypot(flat(k, 0) - flat(a, 0), flat(k, 1) - flat(a, 1));
    return d;
  });

  const steps = warmOk ? 60 : thr ? 400 : 220, iters = warmOk ? 5 : thr ? 4 : 7, ramp = warmOk ? 1 : Math.round(steps * 0.4);
  const dt = 1 / (thr ? 120 : 60), gStep = G * dt * dt, damp = 0.975;

  const collide = k => {
    const p = k * 3;
    let hit = false;
    if (env.wallPlane && pos[p + 2] < gap) { pos[p + 2] = gap; hit = true; }
    if (pos[p + 1] < floor) { pos[p + 1] = floor; hit = true; }
    for (const b of boxes) if (pushOut(pos, p, b, gap)) hit = true;
    for (const [ax, az, ux, uz, wnx, wnz, wl] of walls) {
      const dx = pos[p] - ax, dz = pos[p + 2] - az, s = dx * wnx + dz * wnz, tt = dx * ux + dz * uz;
      if (s < gap && s > -400 && tt > -50 && tt < wl + 50) { pos[p] += wnx * (gap - s); pos[p + 2] += wnz * (gap - s); hit = true; }
    }
    return hit;
  };
  const touched = new Uint8Array(n);

  for (let s = 0; s < steps; s++) {
    const tr = Math.min(1, (s + 1) / ramp);
    pinNodes.forEach((q, m) => {
      const p = q.k * 3, [x0, yy0, z0] = start[m];
      pos[p] = x0 + (q.tx - x0) * tr; pos[p + 1] = yy0 + (q.ty - yy0) * tr; pos[p + 2] = z0 + (gap - z0) * tr;
    });
    for (let k = 0; k < n; k++) {
      if (!inv[k]) continue;
      const p = k * 3;
      for (let d = 0; d < 3; d++) {
        const v = (pos[p + d] - prev[p + d]) * damp;
        prev[p + d] = pos[p + d];
        pos[p + d] += v;
      }
      pos[p + 1] -= gStep;
    }
    touched.fill(0);
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < C; c++) {
        const a = A[c], b = B[c], wa = inv[a], wb = inv[b], ws = wa + wb;
        if (!ws) continue;
        const pa = a * 3, pb = b * 3;
        const dx = pos[pb] - pos[pa], dy = pos[pb + 1] - pos[pa + 1], dz = pos[pb + 2] - pos[pa + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const rest = R[c];
        if (K[c] < 1 && len < rest * 0.6) continue; // 彎曲約束只抵抗、不硬撐（太擠就讓它摺）
        const f = ((len - rest) / len / ws) * K[c];
        pos[pa] += dx * f * wa; pos[pa + 1] += dy * f * wa; pos[pa + 2] += dz * f * wa;
        pos[pb] -= dx * f * wb; pos[pb + 1] -= dy * f * wb; pos[pb + 2] -= dz * f * wb;
      }
      anchors.forEach((a, m) => {
        const pq = a * 3, qx = pos[pq], qy = pos[pq + 1], qz = pos[pq + 2], d = tether[m];
        for (let k = 0; k < n; k++) {
          if (!inv[k] || k === a) continue;
          const p = k * 3, dx = pos[p] - qx, dy = pos[p + 1] - qy, dz = pos[p + 2] - qz;
          const L2 = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (L2 <= d[k] || L2 < 1e-6) continue;
          const f = d[k] / L2;
          pos[p] = qx + dx * f; pos[p + 1] = qy + dy * f; pos[p + 2] = qz + dz * f;
        }
      });
      for (let k = 0; k < n; k++) if (inv[k] && collide(k)) touched[k] = 1;
    }
    // 碰到東西的點加摩擦，布才停得住（桌巾不會從桌面滑掉）
    const fr = thr ? 0.6 : 0.35;
    for (let k = 0; k < n; k++) {
      if (!inv[k] || !touched[k]) continue;
      const p = k * 3;
      for (let d = 0; d < 3; d++) prev[p + d] += (pos[p + d] - prev[p + d]) * fr;
    }
  }

  let x0 = Infinity, x1 = -Infinity, yy0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const p = k * 3;
    x0 = Math.min(x0, pos[p]); x1 = Math.max(x1, pos[p]);
    yy0 = Math.min(yy0, pos[p + 1]); y1 = Math.max(y1, pos[p + 1]);
    z0 = Math.min(z0, pos[p + 2]); z1 = Math.max(z1, pos[p + 2]);
  }
  // 釘子拉得比布還開 → 布被拉緊（提醒使用者）
  let tight = false;
  for (let a = 0; a < pinNodes.length; a++) for (let b = a + 1; b < pinNodes.length; b++) {
    const qa = pinNodes[a], qb = pinNodes[b];
    const cloth = Math.hypot(flat(qa.k, 0) - flat(qb.k, 0), flat(qa.k, 1) - flat(qb.k, 1));
    if (Math.hypot(qa.tx - qb.tx, qa.ty - qb.ty) > cloth * 1.03 + 5) tight = true;
  }
  return { nx, ny, pos, box: { x0, x1, y0: yy0, y1, z0, z1 }, tight, pinNodes: pinNodes.map(q => q.k) };
}

// 攤平的布（中心在原點）跟這件傢俱的俯視範圍有沒有重疊（用傢俱的四個角＋中心粗估）
function covers(b, w, h) {
  const [cx, cz, axx, axz, azx, azz, hw, hd] = b;
  const pts = [[0, 0], [hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd], [hw, 0], [-hw, 0], [0, hd], [0, -hd]];
  return pts.some(([a, c]) => Math.abs(cx + a * axx + c * azx) < w / 2 && Math.abs(cz + a * axz + c * azz) < h / 2);
}
const clampN = (v, a, b) => Math.min(Math.max(+v || 0, a), b);
const hash = (i, j) => { const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; return s - Math.floor(s); };

// 布上某一點（u,v）目前在哪裡（相對錨點）：新增釘子時，讓它釘在布現在的位置，不會突然扯動
export function pointAt(res, u, v) {
  const i = Math.round(clampN(u, 0, 1) * (res.nx - 1)), j = Math.round(clampN(v, 0, 1) * (res.ny - 1));
  const p = (j * res.nx + i) * 3;
  return { x: res.pos[p], y: res.pos[p + 1], z: res.pos[p + 2] };
}

// 方便各視圖呼叫：某一件布目前垂下來的樣子
export const clothOf = (it, li, W, items, libFn) => drape(li, it, clothEnv(it, li, W, items, libFn));
export const throwOf = (it, li, items, libFn, walls) => drape(li, it, throwEnv(it, li, items, libFn, walls));

// 釘子不能釘得比布上的距離還開（布會被拉破）：把第 i 個釘子拉回到「剛好拉直」的位置
export function limitPin(li, pins, i) {
  const p = { ...pins[i] };
  for (let r = 0; r < 4; r++) {
    let ok = true;
    pins.forEach((q, j) => {
      if (j === i) return;
      const max = Math.hypot((p.u - q.u) * li.w, (p.v - q.v) * li.h);
      const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
      if (d > max && d > 0) { p.x = q.x + (dx / d) * max; p.y = q.y + (dy / d) * max; ok = false; }
    });
    if (ok) break;
  }
  p.x = Math.round(p.x); p.y = Math.round(p.y);
  return p;
}
