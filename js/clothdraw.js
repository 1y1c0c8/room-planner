// 在 2D 畫布上畫模擬出來的布：逐個三角形貼圖（遠的先畫），依皺褶角度加陰影
// 立面圖（正對牆看，axis＝2）和平面圖（從上往下看，axis＝1）共用
import { getImg } from './state.js?v=0.12.0';
import { resolveFace, } from './faces.js?v=0.12.0';
import { sheet } from './cloth.js?v=0.12.0';

const LIGHT = { 2: [-0.35, 0.55, 0.76], 1: [-0.35, 0.8, -0.45] }; // 光從畫面左上方來

// toScreen(k)＝第 k 個格點在目前畫布座標的位置；px＝目前座標的 1 像素有多大
export function drawClothMesh(ctx, res, li, showBack, toScreen, axis, px) {
  const { nx, ny, pos } = res, { w, len } = sheet(li);
  const scr = new Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) scr[k] = toScreen(k);
  const sides = [resolveFace(li, showBack ? 'back' : 'front'), resolveFace(li, showBack ? 'front' : 'back')].map(fc => {
    const img = fc.tex ? getImg(fc.tex) : null;
    return { fc, img: img ? smallImg(img) : null, pat: null };
  });
  const L = LIGHT[axis], Ln = Math.hypot(...L), La = L[axis] / Ln;
  const tris = [];
  const P3 = k => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = j * nx + i, b = a + nx, c = a + 1, d = b + 1;
    for (const t of [[a, b, c], [c, b, d]]) {
      const [p0, p1, p2] = t.map(P3);
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nl = Math.hypot(...nn) || 1;
      const lit = Math.abs((nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2]) / nl / Ln);
      tris.push({ t, z: p0[axis] + p1[axis] + p2[axis], side: nn[axis] >= 0 ? 0 : 1, shade: Math.min(1, 0.45 + (0.55 * lit) / La) });
    }
  }
  tris.sort((x, y) => x.z - y.z);
  const base = ctx.getTransform();
  for (const { t, side, shade } of tris) {
    const S3 = t.map(k => scr[k]);
    const cx = (S3[0].x + S3[1].x + S3[2].x) / 3, cy = (S3[0].y + S3[1].y + S3[2].y) / 3;
    ctx.beginPath();
    S3.forEach((q, m) => { const dx = q.x - cx, dy = q.y - cy, l = Math.hypot(dx, dy) || 1, g = (0.8 * px) / l; (m ? ctx.lineTo : ctx.moveTo).call(ctx, q.x + dx * g, q.y + dy * g); });
    ctx.closePath();
    const sd = sides[side], fc = sd.fc;
    if (sd.img) {
      // 貼圖座標：照片＝像素；材質重複＝以框選區域為一格；看到的是背面就左右反過來
      const iw = sd.img.width, ih = sd.img.height, flip = !!fc.flip !== (side === 1);
      const UV = t.map(k => {
        const i = k % nx, j = (k - i) / nx;
        let u = i / (nx - 1); const v = j / (ny - 1);
        if (flip) u = 1 - u;
        return fc.kind === 'tile' ? [((u * w) / fc.tileW) * iw, ((v * len) / fc.tileH) * ih] : [u * iw, v * ih];
      });
      const m = affine(UV, S3);
      if (m) {
        ctx.save(); ctx.clip();
        ctx.setTransform(base.multiply(m));
        if (fc.kind === 'tile') {
          sd.pat ||= ctx.createPattern(sd.img, 'repeat');
          const us = UV.map(q => q[0]), vs = UV.map(q => q[1]);
          const x0 = Math.min(...us) - 2, y0 = Math.min(...vs) - 2;
          ctx.fillStyle = sd.pat; ctx.fillRect(x0, y0, Math.max(...us) - x0 + 4, Math.max(...vs) - y0 + 4);
        } else ctx.drawImage(sd.img, 0, 0);
        ctx.restore();
      } else { ctx.fillStyle = li.color; ctx.fill(); }
    } else { ctx.fillStyle = fc.kind === 'color' ? fc.color : li.color; ctx.fill(); }
    const dk = (1 - shade) * 0.55 + (side ? 0.08 : 0);
    if (dk > 0.01) { ctx.fillStyle = `rgba(30,22,14,${dk.toFixed(3)})`; ctx.fill(); }
  }
  // 布邊
  ctx.beginPath();
  const edge = [];
  for (let i = 0; i < nx; i++) edge.push(i);
  for (let j = 1; j < ny; j++) edge.push(j * nx + nx - 1);
  for (let i = nx - 2; i >= 0; i--) edge.push((ny - 1) * nx + i);
  for (let j = ny - 2; j > 0; j--) edge.push(j * nx);
  edge.forEach((k, m) => (m ? ctx.lineTo(scr[k].x, scr[k].y) : ctx.moveTo(scr[k].x, scr[k].y)));
  ctx.closePath();
  ctx.strokeStyle = 'rgba(40,30,20,.45)'; ctx.lineWidth = px; ctx.stroke();
}

// 貼圖用的縮小版照片（逐個三角形畫，原圖太大會慢）
const smallCache = new WeakMap();
function smallImg(img) {
  let c = smallCache.get(img);
  if (c) return c;
  const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  smallCache.set(img, c);
  return c;
}
// 把貼圖座標的三角形對到畫布上的三角形（仿射）
function affine(U, S3) {
  const [[u0, v0], [u1, v1], [u2, v2]] = U, [p0, p1, p2] = S3;
  const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(den) < 1e-9) return null;
  const a = ((p1.x - p0.x) * (v2 - v0) - (p2.x - p0.x) * (v1 - v0)) / den;
  const c = ((p2.x - p0.x) * (u1 - u0) - (p1.x - p0.x) * (u2 - u0)) / den;
  const b = ((p1.y - p0.y) * (v2 - v0) - (p2.y - p0.y) * (v1 - v0)) / den;
  const d = ((p2.y - p0.y) * (u1 - u0) - (p1.y - p0.y) * (u2 - u0)) / den;
  return new DOMMatrix([a, b, c, d, p0.x - a * u0 - c * v0, p0.y - b * u0 - d * v0]);
}
