// 圓角方塊：R＝俯視圓角（4 條垂直邊）、r＝邊緣圓角（頂面一圈，both＝上下都圓）
// 材質分組與 UV 跟 THREE.BoxGeometry 一樣（+x, -x, +y, -y, +z, -z；每面 0–1），既有的貼圖不用改
import * as THREE from 'three';

const N = 8; // 每 90° 的分段數

export function roundedLimits(w, d, h, both) {
  const R = Math.min(w, d) / 2;
  return { R, r: Math.min(R, both ? h / 2 : h) };
}

export function roundedBoxGeometry(w, h, d, R = 0, r = 0, both = false) {
  const lim = roundedLimits(w, d, h, both);
  R = Math.max(0, Math.min(R, lim.R));
  r = Math.max(0, Math.min(r, lim.r));
  const hw = w / 2, hd = d / 2, hh = h / 2;

  // 由下往上的截面：δ＝往內縮多少、y＝高度、t＝法線仰角
  const rings = [];
  const arc = (y0, from, to) => {
    for (let i = 0; i <= N; i++) {
      const t = from + ((to - from) * i) / N;
      rings.push({ dl: r * (1 - Math.cos(t)), y: y0 + r * Math.sin(t), t });
    }
  };
  if (both && r > 0) arc(-hh + r, -Math.PI / 2, 0);
  else rings.push({ dl: 0, y: -hh, t: 0 });
  if (r > 0) arc(hh - r, 0, Math.PI / 2);
  else rings.push({ dl: 0, y: hh, t: 0 });

  // 每一圈：四個角各 N+1 個點（俯視逆時針；角半徑 0 時點重合）
  const corners = [[1, 1, 0], [-1, 1, 0.5], [-1, -1, 1], [1, -1, 1.5]];
  const ring = ({ dl, y, t }) => {
    const c = Math.max(R - dl, 0), ax = hw - dl - c, az = hd - dl - c, ct = Math.cos(t), st = Math.sin(t);
    const pts = [];
    for (const [sx, sz, a0] of corners) {
      for (let i = 0; i <= N; i++) {
        const a = (a0 + i / N / 2) * Math.PI;
        const nx = Math.cos(a), nz = Math.sin(a);
        pts.push({ p: [sx * ax + c * nx, y, sz * az + c * nz], n: [nx * ct, st, nz * ct] });
      }
    }
    return pts;
  };
  const rs = rings.map(ring);

  // 依法線決定屬於哪一面；UV 照 BoxGeometry 的方向
  const faceOf = n => {
    if (n[1] > 0.7071) return 2;
    if (n[1] < -0.7071) return 3;
    return Math.abs(n[0]) >= Math.abs(n[2]) ? (n[0] > 0 ? 0 : 1) : n[2] > 0 ? 4 : 5;
  };
  const uvOf = (f, [x, y, z]) => [
    [(hd - z) / d, (y + hh) / h], [(z + hd) / d, (y + hh) / h],
    [(x + hw) / w, (hd - z) / d], [(x + hw) / w, (z + hd) / d],
    [(x + hw) / w, (y + hh) / h], [(hw - x) / w, (y + hh) / h],
  ][f];
  const tris = [[], [], [], [], [], []];
  const tri = (a, b, c, nf) => {
    const f = faceOf(nf || [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]]);
    const v = (q, s) => [q.p[0] - s.p[0], q.p[1] - s.p[1], q.p[2] - s.p[2]];
    const e1 = v(b, a), e2 = v(c, a);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const n = a.n[0] + b.n[0] + c.n[0], m = a.n[1] + b.n[1] + c.n[1], k = a.n[2] + b.n[2] + c.n[2];
    if (cr[0] * n + cr[1] * m + cr[2] * k < 0) [b, c] = [c, b]; // 統一朝外
    tris[f].push(a, b, c);
  };
  for (let j = 0; j + 1 < rs.length; j++) {
    const A = rs[j], B = rs[j + 1], L = A.length;
    for (let i = 0; i < L; i++) {
      const i2 = (i + 1) % L;
      tri(A[i], A[i2], B[i2]);
      tri(A[i], B[i2], B[i]);
    }
  }
  // 頂、底蓋：從中心扇形填滿（截面是凸的）
  const cap = (pts, up) => {
    const n = [0, up ? 1 : -1, 0];
    const ctr = { p: [0, pts[0].p[1], 0], n };
    for (let i = 0; i < pts.length; i++) tri(ctr, { p: pts[i].p, n }, { p: pts[(i + 1) % pts.length].p, n }, n);
  };
  cap(rs[0], false);
  cap(rs[rs.length - 1], true);

  const pos = [], nor = [], uv = [];
  const g = new THREE.BufferGeometry();
  let start = 0;
  tris.forEach((list, f) => {
    for (const q of list) { pos.push(...q.p); nor.push(...q.n); uv.push(...uvOf(f, q.p)); }
    g.addGroup(start, list.length, f);
    start += list.length;
  });
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
