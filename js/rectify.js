// 照片透視校正：拖四個角 → 拉正成「你量的尺寸比例」的貼圖
import { esc } from './util.js';

function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

// 單位正方形 → 照片上的四邊形
function homography(to) {
  const from = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i], [x, y] = to[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve(A, b);
}

function warp(src, pts, aspect) {
  const maxO = 1024;
  const ow = aspect >= 1 ? maxO : Math.max(8, Math.round(maxO * aspect));
  const oh = aspect >= 1 ? Math.max(8, Math.round(maxO / aspect)) : maxO;
  const H = homography(pts);
  const SW = src.width, SH = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, SW, SH).data;
  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const octx = out.getContext('2d');
  const od = octx.createImageData(ow, oh), o = od.data;
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow;
      const den = H[6] * u + H[7] * v + 1;
      const sx = (H[0] * u + H[1] * v + H[2]) / den - 0.5, sy = (H[3] * u + H[4] * v + H[5]) / den - 0.5;
      const x0 = Math.max(0, Math.min(SW - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(SH - 1, Math.floor(sy)));
      const x1 = Math.min(SW - 1, x0 + 1), y1 = Math.min(SH - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
      const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4, i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
      const oi = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        o[oi + c] = top * (1 - fy) + bot * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

const toBlob = cv => new Promise(res => cv.toBlob(res, 'image/jpeg', 0.88));

// aspect = 寬/深（俯視）；回傳 JPEG Blob 或 null（取消）
export async function rectify(file, { aspect, title }) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { alert('無法讀取這張照片。若是 HEIC 格式，請用 Safari 開啟本網站，或先轉成 JPG。'); return null; }
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const src = document.createElement('canvas');
  src.width = Math.round(bmp.width * k); src.height = Math.round(bmp.height * k);
  src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
  const SW = src.width, SH = src.height;

  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'rectify';
    ov.innerHTML = `
      <div class="rx-top"><b>${esc(title)}</b>
        <span>把四個點拖到物體表面的四個角：<i>1 左上</i> → <i>2 右上</i> → <i>3 右下</i> → <i>4 左下</i>（以 2D 俯視圖的方向為準）。方向不對就按「轉 90°」。</span></div>
      <div class="rx-stage"><canvas></canvas></div>
      <div class="rx-bar">
        <button data-a="rot">轉 90°</button>
        <button data-a="whole">不校正，整張使用</button>
        <span class="sp"></span>
        <button data-a="cancel">取消</button>
        <button data-a="ok" class="primary">套用</button>
      </div>`;
    document.body.appendChild(ov);
    const stage = ov.querySelector('.rx-stage'), cv = ov.querySelector('canvas'), ctx = cv.getContext('2d');
    let pts = [[0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85]].map(([x, y]) => [x * SW, y * SH]);
    let ds = 1, dx = 0, dy = 0, cw = 0, ch = 0, dpr = 1, dragI = -1;

    const layout = () => {
      const r = stage.getBoundingClientRect();
      dpr = devicePixelRatio || 1; cw = r.width; ch = r.height;
      cv.width = cw * dpr; cv.height = ch * dpr;
      ds = Math.min((cw - 40) / SW, (ch - 40) / SH);
      dx = (cw - SW * ds) / 2; dy = (ch - SH * ds) / 2;
      draw();
    };
    const toD = ([x, y]) => [x * ds + dx, y * ds + dy];
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#1d1b19'; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, dx, dy, SW * ds, SH * ds);
      const d = pts.map(toD);
      ctx.beginPath(); d.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = 'rgba(47,125,118,.18)'; ctx.fill();
      ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 2; ctx.stroke();
      d.forEach(([x, y], i) => {
        ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2);
        ctx.fillStyle = i === dragI ? '#d0612a' : 'rgba(47,125,118,.95)'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '700 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x, y + 1);
      });
      // 放大鏡：手指會擋住角點，所以在角落顯示放大畫面
      if (dragI >= 0) {
        const [sx, sy] = pts[dragI], R = 64, Z = 3;
        const lx = d[dragI][0] < cw / 2 ? cw - R - 12 : R + 12, ly = R + 12;
        ctx.save();
        ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#000'; ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
        const sz = (2 * R) / (ds * Z);
        ctx.drawImage(src, sx - sz / 2, sy - sz / 2, sz, sz, lx - R, ly - R, 2 * R, 2 * R);
        ctx.strokeStyle = '#d0612a'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly); ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10); ctx.stroke();
        ctx.restore();
        ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    };
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      const [x, y] = pos(e);
      let best = -1, bd = e.pointerType === 'touch' ? 44 : 26;
      pts.map(toD).forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      dragI = best; cv.setPointerCapture(e.pointerId); draw();
    });
    cv.addEventListener('pointermove', e => {
      if (dragI < 0) return;
      const [x, y] = pos(e);
      pts[dragI] = [Math.max(0, Math.min(SW, (x - dx) / ds)), Math.max(0, Math.min(SH, (y - dy) / ds))];
      draw();
    });
    const end = () => { dragI = -1; draw(); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    const ro = new ResizeObserver(layout);
    ro.observe(stage);

    const done = v => { ro.disconnect(); ov.remove(); resolve(v); };
    ov.querySelector('.rx-bar').addEventListener('click', async e => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'cancel') return done(null);
      if (a === 'rot') { pts = [pts[3], pts[0], pts[1], pts[2]]; draw(); return; }
      if (a === 'whole') {
        const m = Math.min(1, 1024 / Math.max(SW, SH));
        const c = document.createElement('canvas');
        c.width = Math.round(SW * m); c.height = Math.round(SH * m);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return done(await toBlob(c));
      }
      // 粗略檢查：四邊形大致比例和量的尺寸差太多，多半是角點順序轉了 90°
      const L = (i, j) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      const quadAspect = (L(0, 1) + L(3, 2)) / (L(1, 2) + L(0, 3));
      const ratio = quadAspect / aspect;
      if ((ratio > 2 || ratio < 0.5) && !confirm('框出來的形狀和你量的長寬比例差很多，可能是角點順序轉了 90°。仍要套用嗎？')) return;
      e.target.disabled = true;
      e.target.textContent = '處理中…';
      await new Promise(r => setTimeout(r, 30));
      done(await toBlob(warp(src, pts, aspect)));
    });
  });
}
