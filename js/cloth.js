// 布的垂墜：用質點＋距離約束（PBD／Verlet）模擬布被幾個釘子固定後自然下垂，結果依輸入快取
// 座標（mm）：以物件的錨點（it.off, it.elev）為原點；x＝站在房內面對牆時往右、y＝往上、z＝離開牆面往房內
// 釘子 it.pins = [{ u, v, x, y }]：(u,v)＝布上的點（0–1，u 從左、v 從上緣量），(x,y)＝釘在牆上的位置（相對錨點）
import { V } from './util.js?v=0.11.0';

export const DRAPES = {
  soft: ['柔軟（絲巾、薄紗）', 0.015, 0.25],
  normal: ['一般（棉布、床單）', 0.08, 0.6],
  stiff: ['挺（帆布、掛毯、毛氈）', 0.35, 1],
};
const G = 9810; // mm/s²

export const defaultPins = li => [
  { u: 0, v: 0, x: -li.w / 2, y: li.h / 2 },
  { u: 1, v: 0, x: li.w / 2, y: li.h / 2 },
];
export const pinsOf = (it, li) => (it.pins?.length ? it.pins : defaultPins(li));

// 每一件布的模擬環境：地板高度、附近的傢俱（轉到布的座標系）
export function clothEnv(it, li, W, items, libFn) {
  const base = V.add(W.a, V.scale(W.u, it.off));
  const right = { x: W.n.y, y: -W.n.x };
  const reach = li.w + li.h;
  const boxes = [];
  for (const o of items) {
    const ol = libFn(o.libId);
    if (!ol || ['wall', 'cloth', 'rug', 'rugRound', 'model'].includes(ol.shape)) continue;
    const c = V.sub({ x: o.x, y: o.y }, base);
    const cx = V.dot(c, right), cz = V.dot(c, W.n);
    const ext = Math.hypot(ol.w, ol.d) / 2;
    if (Math.abs(cx) > reach + ext || cz - ext > reach || cz + ext < -10) continue;
    const r = (o.rot * Math.PI) / 180, ax = { x: Math.cos(r), y: Math.sin(r) }, az = { x: -Math.sin(r), y: Math.cos(r) };
    boxes.push([cx, cz, V.dot(ax, right), V.dot(ax, W.n), V.dot(az, right), V.dot(az, W.n), ol.w / 2, ol.d / 2, ol.h - it.elev].map(v => Math.round(v * 10) / 10));
  }
  return { floor: -it.elev, boxes };
}

const cache = new Map();
const keyOf = (li, pins, env) => JSON.stringify([li.w, li.h, li.d, li.drape || 'normal', pins.map(p => [p.u, p.v, Math.round(p.x), Math.round(p.y)]), Math.round(env.floor), env.boxes]);

// 主函式：回傳 { nx, ny, pos(Float32Array, nx*ny*3), box:{x0,x1,y0,y1,z1}, tight }
// warm：拖曳釘子時用上一次的結果當起點，跑少一點步數（即時預覽）
export function drape(li, it, env, warm = null) {
  const pins = pinsOf(it, li);
  const key = keyOf(li, pins, env);
  if (!warm) {
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  }
  const r = simulate(li, pins, env, warm);
  if (!warm) {
    cache.set(key, r);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return r;
}

function grid(li) {
  const sp = Math.min(Math.max(Math.max(li.w, li.h) / 26, 8), 80);
  const nx = Math.min(Math.max(Math.round(li.w / sp) + 1, 3), 33);
  const ny = Math.min(Math.max(Math.round(li.h / sp) + 1, 3), 33);
  return { nx, ny };
}

function simulate(li, pins, env, warm) {
  const { nx, ny } = grid(li);
  const n = nx * ny, w = li.w, h = li.h;
  const gap = Math.max(li.d || 1, 1) / 2 + 0.5;
  const [, bendK, shearK] = DRAPES[li.drape] || DRAPES.normal;
  const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3), inv = new Float32Array(n).fill(1);
  const idx = (i, j) => j * nx + i;

  // 釘子 → 最近的格點
  const pinNodes = [];
  for (const p of pins) {
    const i = Math.round(clampN(p.u, 0, 1) * (nx - 1)), j = Math.round(clampN(p.v, 0, 1) * (ny - 1));
    const k = idx(i, j);
    if (pinNodes.some(q => q.k === k)) continue;
    pinNodes.push({ k, tx: p.x, ty: p.y });
    inv[k] = 0;
  }

  // 起始狀態：攤平的布平移到釘子的重心附近（避免一開始被猛拉）；拖曳時接著上一次的形狀
  const warmOk = warm && warm.nx === nx && warm.ny === ny;
  let ox = 0, oy = 0;
  if (!warmOk && pinNodes.length) {
    for (const q of pinNodes) {
      const i = q.k % nx, j = (q.k - i) / nx;
      ox += q.tx - (-w / 2 + (i / (nx - 1)) * w); oy += q.ty - (h / 2 - (j / (ny - 1)) * h);
    }
    ox /= pinNodes.length; oy /= pinNodes.length;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = idx(i, j) * 3;
    if (warmOk) { pos[k] = warm.pos[k]; pos[k + 1] = warm.pos[k + 1]; pos[k + 2] = warm.pos[k + 2]; }
    else {
      pos[k] = -w / 2 + (i / (nx - 1)) * w + ox;
      pos[k + 1] = h / 2 - (j / (ny - 1)) * h + oy;
      pos[k + 2] = gap + 1.5 + 2.5 * hash(i, j); // 一點點起伏，讓被擠壓的地方往外拱出皺褶
    }
  }
  const start = pinNodes.map(q => [pos[q.k * 3], pos[q.k * 3 + 1], pos[q.k * 3 + 2]]);
  prev.set(pos);

  // 約束：結構（相鄰）、剪切（對角）、彎曲（隔一格）
  const ca = [], cb = [], cr = [], ck = [];
  const add = (a, b, k) => {
    ca.push(a); cb.push(b); ck.push(k);
    cr.push(Math.hypot(...[0, 1, 2].map(d => flat(a, d) - flat(b, d))));
  };
  const flat = (q, d) => { const i = q % nx, j = (q - i) / nx; return d === 0 ? (i / (nx - 1)) * w : d === 1 ? -(j / (ny - 1)) * h : 0; };
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
  const tether = [];
  for (const q of pinNodes) {
    const d = new Float32Array(n);
    for (let k = 0; k < n; k++) d[k] = Math.hypot(flat(k, 0) - flat(q.k, 0), flat(k, 1) - flat(q.k, 1));
    tether.push(d);
  }

  const steps = warmOk ? 60 : 220, iters = warmOk ? 5 : 7, ramp = warmOk ? 1 : Math.round(steps * 0.4);
  const dt = 1 / 60, gStep = G * dt * dt, damp = 0.975;
  const floor = env.floor + gap, boxes = env.boxes;

  const collide = k => {
    const p = k * 3;
    let x = pos[p], y = pos[p + 1], z = pos[p + 2], hitIt = false;
    if (z < gap) { z = gap; hitIt = true; }
    if (y < floor) { y = floor; hitIt = true; }
    for (const [cx, cz, axx, axz, azx, azz, hw, hd, top] of boxes) {
      if (y > top + gap || y < floor - 1) continue;
      const dx = x - cx, dz = z - cz;
      const lx = dx * axx + dz * axz, lz = dx * azx + dz * azz;
      const px = hw + gap - Math.abs(lx), pz = hd + gap - Math.abs(lz), py = top + gap - y;
      if (px <= 0 || pz <= 0) continue;
      if (py < px && py < pz) y = top + gap;
      else if (px < pz) { const s = (lx < 0 ? -1 : 1) * px; x += s * axx; z += s * axz; }
      else { const s = (lz < 0 ? -1 : 1) * pz; x += s * azx; z += s * azz; }
      hitIt = true;
    }
    pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
    return hitIt;
  };

  for (let s = 0; s < steps; s++) {
    const t = Math.min(1, (s + 1) / ramp);
    pinNodes.forEach((q, m) => {
      const p = q.k * 3, [x0, y0, z0] = start[m];
      pos[p] = x0 + (q.tx - x0) * t; pos[p + 1] = y0 + (q.ty - y0) * t; pos[p + 2] = z0 + (gap - z0) * t;
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
      pinNodes.forEach((q, m) => {
        const pq = q.k * 3, qx = pos[pq], qy = pos[pq + 1], qz = pos[pq + 2], d = tether[m];
        for (let k = 0; k < n; k++) {
          if (!inv[k]) continue;
          const p = k * 3, dx = pos[p] - qx, dy = pos[p + 1] - qy, dz = pos[p + 2] - qz;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len <= d[k] || len < 1e-6) continue;
          const f = d[k] / len;
          pos[p] = qx + dx * f; pos[p + 1] = qy + dy * f; pos[p + 2] = qz + dz * f;
        }
      });
      for (let k = 0; k < n; k++) if (inv[k]) collide(k);
    }
    // 碰到東西的點加一點摩擦，布才停得住（披在櫃子上不會一直滑）
    for (let k = 0; k < n; k++) {
      if (!inv[k]) continue;
      const p = k * 3;
      const touching = pos[p + 2] <= gap + 0.3 || pos[p + 1] <= floor + 0.3 || touchesBox(pos, p, boxes, gap);
      if (touching) for (let d = 0; d < 3; d++) prev[p + d] += (pos[p + d] - prev[p + d]) * 0.35;
    }
  }

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = 0;
  for (let k = 0; k < n; k++) {
    const p = k * 3;
    x0 = Math.min(x0, pos[p]); x1 = Math.max(x1, pos[p]);
    y0 = Math.min(y0, pos[p + 1]); y1 = Math.max(y1, pos[p + 1]);
    z1 = Math.max(z1, pos[p + 2]);
  }
  // 釘子拉得比布還開 → 布被拉緊（提醒使用者）
  let tight = false;
  for (let a = 0; a < pinNodes.length; a++) for (let b = a + 1; b < pinNodes.length; b++) {
    const qa = pinNodes[a], qb = pinNodes[b];
    const ia = qa.k % nx, ja = (qa.k - ia) / nx, ib = qb.k % nx, jb = (qb.k - ib) / nx;
    const cloth = Math.hypot(((ia - ib) / (nx - 1)) * w, ((ja - jb) / (ny - 1)) * h);
    if (Math.hypot(qa.tx - qb.tx, qa.ty - qb.ty) > cloth * 1.03 + 5) tight = true;
  }
  return { nx, ny, pos, box: { x0, x1, y0, y1, z1 }, tight, pinNodes: pinNodes.map(q => q.k) };
}

function touchesBox(pos, p, boxes, gap) {
  const x = pos[p], y = pos[p + 1], z = pos[p + 2];
  for (const [cx, cz, axx, axz, azx, azz, hw, hd, top] of boxes) {
    if (y > top + gap + 0.5) continue;
    const dx = x - cx, dz = z - cz;
    const lx = dx * axx + dz * axz, lz = dx * azx + dz * azz;
    if (Math.abs(lx) <= hw + gap + 0.5 && Math.abs(lz) <= hd + gap + 0.5) return true;
  }
  return false;
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
