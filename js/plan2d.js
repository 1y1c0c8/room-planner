// 2D 平面編輯器：擺放、旋轉、以任意邊為基準設定距離、量測線
import { S, P, L, lib, isRug, isRound, isWall, selItem, checkpoint, changed, emit, getImg } from './state.js';
import { Elev } from './elev.js';
import { V, segDist, cm, uid, clamp, normDeg } from './util.js';
import { buildRoom, wallEdges, itemEdges, itemCorners, doorGeom, refEdges, refKey, isParallel, measureGeom, cornerName, WALL_T, isInterior, winDepth, nm, beamGeom, skirtSegs } from './geom.js';

const C = {
  bg: '#f4f1ec', grid: 'rgba(70,55,40,.06)', gridMaj: 'rgba(70,55,40,.14)',
  wall: '#3b3631', ink: '#2b2824', accent: '#2f7d76', hot: '#d0612a',
  item: '#d9cfc2', itemStroke: '#6b5f52', dim: '#2f7d76', measure: '#7a4fb0',
};
const MIN_S = 0.02, MAX_S = 3;
const ROT_GAP = 30; // 旋轉把手與物件的距離（px）

export class Plan2D {
  constructor(canvas, ui) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.ui = ui;
    this.scale = 0.15; this.ox = 40; this.oy = 40; this.dpr = 1; this.w = 0; this.h = 0;
    this.mode = 'select';   // 'select' | 'measure'
    this.pick = null;       // { itemId, edge } 正在選基準邊
    this.pickTarget = null; // 已選的基準邊（等待輸入數字）
    this.mpick = null;      // 量測模式的第一條邊
    this.drag = null; this.pinch = null; this.pointers = new Map();
    this.hover = null; this.snapHits = []; this.measureHits = [];
    this.active = true; this.needFit = true;
    this.ev = null;        // 牆面立面圖（開啟時取代平面圖）
    this.beamLabels = [];
    this.viewRot = 0;      // 平面圖旋轉（弧度）；正北朝上時＝ -north
    this.northUp = false;
    this.wallHits = [];    // 牆名標籤的點擊範圍
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e, false));
    canvas.addEventListener('pointercancel', e => this.up(e, true));
    canvas.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.draw(); } });
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  // ---------- 視圖 ----------
  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * this.dpr);
    this.c.height = Math.round(r.height * this.dpr);
    if (this.ev?.needFit) { this.ev.fit(); this.ev.needFit = false; }
    else if (this.needFit) this.fit();
    this.draw();
  }
  fit() {
    if (this.ev) { this.ev.fit(); this.draw(); return; }
    const p = P();
    if (!p || !this.w) return;
    const poly = buildRoom(p.room).poly.map(q => V.rot(q, this.viewRot));
    const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const m = this.w < 600 ? 70 : 96;
    const right = this.w > 760 ? 290 : 0; // 桌機右側留給物件面板，避免擋住
    const aw = this.w - right;
    const s = clamp(Math.min((aw - 2 * m) / (x1 - x0 || 1), (this.h - 2 * m) / (y1 - y0 || 1)), MIN_S, MAX_S);
    this.scale = s;
    this.ox = aw / 2 - ((x0 + x1) / 2) * s;
    this.oy = this.h / 2 - ((y0 + y1) / 2) * s;
    this.needFit = false;
    this.draw();
  }
  zoomAt(px, py, k) {
    if (this.ev) return this.ev.zoomAt(px, py, k);
    const ns = clamp(this.scale * k, MIN_S, MAX_S);
    const wx = (px - this.ox) / this.scale, wy = (py - this.oy) / this.scale;
    this.scale = ns; this.ox = px - wx * ns; this.oy = py - wy * ns;
    this.draw();
  }
  toS(p) { const q = V.rot(p, this.viewRot); return { x: q.x * this.scale + this.ox, y: q.y * this.scale + this.oy }; }
  toW(x, y) { return V.rot({ x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale }, -this.viewRot); }
  // 螢幕上的位移 → 平面圖座標的位移
  toWDelta(dx, dy) { return V.rot({ x: dx / this.scale, y: dy / this.scale }, -this.viewRot); }

  // 指北針：房間擺正 ⇄ 正北朝上（像 Google 地圖）
  toggleNorthUp() {
    const north = ((P()?.room.north || 0) * Math.PI) / 180;
    this.northUp = !this.northUp;
    const from = this.viewRot, to = this.northUp ? -north : 0;
    let diff = to - from;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const t0 = performance.now(), dur = 350;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
      this.viewRot = from + diff * e;
      this.fit();
      if (k < 1) requestAnimationFrame(step);
      else this.ui.toast(this.northUp ? '正北朝上（再點指北針回到房間擺正）' : '房間擺正');
    };
    requestAnimationFrame(step);
  }
  // 北方角度改了之後，正北朝上模式要跟著轉
  syncNorth() {
    if (!this.northUp) return;
    const r = -((P()?.room.north || 0) * Math.PI) / 180;
    if (Math.abs(r - this.viewRot) < 1e-6) return;
    this.viewRot = r;
    this.fit();
  }
  hitCompass(pos) { return Math.hypot(pos.x - 44, pos.y - (this.h - 44)) < 30; }
  evPos(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  openWall(i, selId = null) {
    this.pick = null; this.pickTarget = null; this.mpick = null; this.mode = 'select';
    this.ui.hideDistance();
    this.ev = new Elev(this, i);
    this.ev.fit();
    S.sel = selId;
    emit('selection');
    this.ui.onViewChange();
    this.draw();
  }
  closeWall() {
    if (!this.ev) return;
    this.ev = null;
    this.c.style.cursor = 'default';
    this.ui.hideDistance();
    if (S.sel && !selItem()) S.sel = null;
    else if (selItem() && isWall(lib(selItem().libId))) S.sel = null;
    emit('selection');
    this.ui.onViewChange();
    this.draw();
  }

  setMode(m) {
    this.mode = m; this.pick = null; this.pickTarget = null; this.mpick = null;
    this.ui.hideDistance();
    this.ui.updateHint();
    this.draw();
  }

  data() {
    const p = P();
    if (!p) return null;
    const lay = L(p);
    const poly = buildRoom(p.room).poly;
    const walls = wallEdges(poly);
    return { p, lay, poly, walls, refs: refEdges(p, lay, lib, walls) };
  }

  // ---------- 繪製 ----------
  draw() {
    if (!this.active || !this.w) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.ev) { this.ev.draw(); return; }
    const D = this.data();
    this.D = D;
    if (!D) return;
    this.drawGrid(ctx);
    const { p, lay, poly, walls } = D;
    const s = this.scale;

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.rotate(this.viewRot);
    ctx.scale(s, s);
    // 牆（畫粗線，內側一半被地板蓋掉 → 露出外側牆厚）
    this.polyPath(ctx, poly);
    ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
    ctx.lineWidth = WALL_T * 2; ctx.strokeStyle = C.wall; ctx.stroke();
    // 內牆（外面是走道或其他房間）用淺色，和外牆區分
    for (const W of walls) if (isInterior(p.room, W.i)) {
      ctx.beginPath(); ctx.moveTo(W.a.x, W.a.y); ctx.lineTo(W.b.x, W.b.y);
      ctx.lineWidth = WALL_T * 2 - 2 / s; ctx.lineCap = 'butt'; ctx.strokeStyle = '#a69c90'; ctx.stroke();
    }
    const floor = this.floorStyle(ctx, p.room);
    this.polyPath(ctx, poly);
    ctx.fillStyle = floor; ctx.fill();
    // 門
    for (const d of p.room.doors || []) {
      const g = doorGeom(d, walls);
      if (!g) continue;
      const o1 = V.add(g.a, V.scale(g.n, -WALL_T / 2)), o2 = V.add(g.b, V.scale(g.n, -WALL_T / 2));
      ctx.beginPath(); ctx.moveTo(o1.x, o1.y); ctx.lineTo(o2.x, o2.y);
      ctx.lineCap = 'butt'; ctx.lineWidth = WALL_T + 2 / s; ctx.strokeStyle = floor; ctx.stroke();
    }
    // 踢腳線：沿牆的細條（門洞處斷開）
    const sk = p.room.skirting;
    if (sk?.on) for (const W of walls) for (const [t0, t1] of skirtSegs(p.room, W.i, W)) {
      const q = [V.add(W.a, V.scale(W.u, t0)), V.add(W.a, V.scale(W.u, t1))];
      const r = [V.add(q[1], V.scale(W.n, Math.max(sk.t, 2 / s))), V.add(q[0], V.scale(W.n, Math.max(sk.t, 2 / s)))];
      ctx.beginPath(); [...q, ...r].forEach((pt, k) => (k ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath();
      ctx.fillStyle = sk.color; ctx.fill();
      ctx.strokeStyle = 'rgba(60,50,40,.35)'; ctx.lineWidth = 0.8 / s; ctx.stroke();
    }
    // 物件：地毯在下、傢俱在上；選到地毯時傢俱半透明，方便看被壓住的部分
    const items = lay.items.filter(it => lib(it.libId) && !isWall(lib(it.libId)));
    const sel = selItem();
    const selRug = sel && isRug(lib(sel.libId));
    for (const it of items) if (isRug(lib(it.libId))) this.drawItem(ctx, it, 1);
    if (this.sun && this.sun.alt > 0) this.drawSunPatches(ctx, D);
    for (const it of items) if (!isRug(lib(it.libId))) this.drawItem(ctx, it, selRug ? 0.4 : 1);
    if (this.sun && this.sun.alt > 0) this.drawSunPatches(ctx, D, true); // 傢俱上再描一次外框，看得出被蓋住的範圍
    // 門框、門片與開門範圍畫在物件上面，才看得出會不會撞到
    for (const d of p.room.doors || []) {
      const g = doorGeom(d, walls);
      if (!g) continue;
      // 門框：門洞兩側的框（固定不動）
      ctx.fillStyle = d.frameColor || '#8b7b6b';
      for (const t0 of [d.off, d.off + d.w - g.fw]) {
        const q0 = V.add(g.W.a, V.scale(g.u, t0)), q1 = V.add(q0, V.scale(g.u, g.fw));
        ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y);
        ctx.lineTo(q1.x - g.n.x * WALL_T, q1.y - g.n.y * WALL_T); ctx.lineTo(q0.x - g.n.x * WALL_T, q0.y - g.n.y * WALL_T); ctx.closePath();
        ctx.fill();
      }
      // 開門範圍（完整 90°）與目前的門片角度
      const a1 = Math.atan2(g.open.y, g.open.x), a0 = Math.atan2(g.close.y, g.close.x);
      let diff = a0 - a1;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      ctx.beginPath(); ctx.moveTo(g.hinge.x, g.hinge.y); ctx.arc(g.hinge.x, g.hinge.y, g.leafW, a1, a1 + diff, diff < 0); ctx.closePath();
      ctx.fillStyle = 'rgba(59,54,49,.07)'; ctx.fill();
      ctx.beginPath(); ctx.arc(g.hinge.x, g.hinge.y, g.leafW, a1, a1 + diff, diff < 0);
      ctx.setLineDash([6 / s, 5 / s]); ctx.lineWidth = 1.2 / s; ctx.strokeStyle = C.wall; ctx.stroke(); ctx.setLineDash([]);
      const th = (g.angle * Math.PI) / 180;
      const dir = V.add(V.scale(g.close, Math.cos(th)), V.scale(g.open, Math.sin(th)));
      const tip = V.add(g.hinge, V.scale(dir, g.leafW));
      ctx.beginPath(); ctx.moveTo(g.hinge.x, g.hinge.y); ctx.lineTo(tip.x, tip.y);
      ctx.lineWidth = Math.max(3 / s, d.ft || 40); ctx.lineCap = 'butt'; ctx.strokeStyle = d.leafColor || C.wall; ctx.stroke();
      ctx.lineWidth = 1 / s; ctx.strokeStyle = C.wall; ctx.stroke();
    }
    this.drawWallThings(ctx, D);
    (p.room.beams || []).forEach((bm, j) => {
      const g = beamGeom(bm, walls);
      if (!g) return;
      ctx.beginPath(); g.quad.forEach((pt, k) => (k ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath();
      ctx.fillStyle = 'rgba(90,80,70,.10)'; ctx.fill();
      ctx.setLineDash([10 / s, 5 / s, 2 / s, 5 / s]); ctx.strokeStyle = 'rgba(70,60,50,.7)'; ctx.lineWidth = 1.3 / s; ctx.stroke(); ctx.setLineDash([]);
      this.beamLabels.push({ at: V.mid(g.quad[0], g.quad[2]), text: `${nm(bm, `樑 ${j + 1}`)}（下垂 ${cm(bm.drop)}）` });
    });
    ctx.restore();
    for (const b of this.beamLabels.splice(0)) { const c = this.toS(b.at); ctx.font = '600 11px -apple-system, "PingFang TC", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; this.pill(ctx, c.x, c.y, b.text, 'rgba(255,253,249,.85)', '#6b5f52'); }

    this.drawWallLabels(ctx, D);
    this.drawItemLabels(ctx, items);
    this.drawCompass(ctx, p.room);
    this.drawMeasures(ctx, D);
    if (sel) this.drawSelection(ctx, sel, D);
    if (this.pick) this.drawPick(ctx, D);
    if (this.mode === 'measure') this.drawMeasurePick(ctx, D);
    for (const r of this.snapHits) this.seg(ctx, r.a, r.b, C.hot, 3);
  }

  // 陽光穿過窗戶落在地板上的範圍（不計傢俱遮擋；照到牆上的部分不畫）
  drawSunPatches(ctx, D, outline = false) {
    const { d, alt } = this.sun;
    const cot = 1 / Math.tan((alt * Math.PI) / 180);
    const H = D.p.room.height;
    ctx.save();
    this.polyPath(ctx, D.poly);
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 205, 70, .42)';
    ctx.strokeStyle = 'rgba(230, 160, 20, .8)';
    ctx.lineWidth = 1.2 / this.scale;
    for (const w of D.p.room.windows || []) {
      const W = D.walls[w.wall];
      if (!W || isInterior(D.p.room, w.wall) || V.dot(d, W.n) >= 0) continue; // 內牆、或太陽在室內側＝照不進來
      const lo = Math.max(0, w.sill), hi = Math.min(H, w.sill + w.h);
      if (hi <= lo) continue;
      const base = V.scale(W.n, winDepth(D.p.room, w));
      const P = (t, z) => V.sub(V.add(V.add(W.a, V.scale(W.u, t)), base), V.scale(d, z * cot));
      const q = [P(w.off, lo), P(w.off + w.w, lo), P(w.off + w.w, hi), P(w.off, hi)];
      ctx.beginPath(); q.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath();
      if (w.glass === 'frosted') {
        // 霧面玻璃：光會擴散，沒有清楚的光斑，只畫一圈淡淡的亮區
        if (outline) continue;
        ctx.save();
        if ('filter' in ctx) ctx.filter = `blur(${Math.max(4, 160 * this.scale)}px)`;
        ctx.fillStyle = 'rgba(255, 215, 110, .28)'; ctx.fill();
        ctx.restore();
        continue;
      }
      if (outline) { ctx.setLineDash([6 / this.scale, 4 / this.scale]); ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }

  // 指北針（日照模式時加上太陽方向）
  drawCompass(ctx, room) {
    const cx = 44, cy = this.h - 44, r = 24;
    const t = ((room.north || 0) * Math.PI) / 180 + this.viewRot;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,253,249,.92)'; ctx.fill();
    ctx.strokeStyle = this.northUp ? '#c4572a' : '#d6cfc4'; ctx.lineWidth = this.northUp ? 2 : 1; ctx.stroke();
    const dir = (ang, len) => ({ x: cx + Math.sin(ang) * len, y: cy - Math.cos(ang) * len });
    const tip = dir(t, r - 5), tail = dir(t + Math.PI, r - 9), l = dir(t - Math.PI / 2, 5), rr = dir(t + Math.PI / 2, 5);
    ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(l.x, l.y); ctx.lineTo(rr.x, rr.y); ctx.closePath();
    ctx.fillStyle = '#c4572a'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(l.x, l.y); ctx.lineTo(rr.x, rr.y); ctx.closePath();
    ctx.fillStyle = '#9a9086'; ctx.fill();
    const n = dir(t, r + 9);
    ctx.font = '700 11px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c4572a'; ctx.fillText('N', n.x, n.y);
    if (this.sun) {
      const sd = V.rot(this.sun.d, this.viewRot);
      const sp = { x: cx + sd.x * (r + 10), y: cy + sd.y * (r + 10) };
      ctx.font = '14px sans-serif';
      ctx.globalAlpha = this.sun.alt > 0 ? 1 : 0.35;
      ctx.fillText('☀️', sp.x, sp.y);
    }
    ctx.restore();
  }

  // 平面圖上的窗戶（牆上的玻璃符號）與牆面物件（貼牆的細條）
  wallThings(D) {
    const out = [];
    const T = WALL_T, s = this.scale;
    (D.p.room.boxes || []).forEach((bx, j) => {
      const W = D.walls[bx.wall];
      if (!W) return;
      const a = V.add(W.a, V.scale(W.u, bx.off)), b = V.add(W.a, V.scale(W.u, bx.off + bx.w));
      out.push({ kind: 'box', id: bx.id, wall: bx.wall, label: nm(bx, `量體 ${j + 1}`), quad: [a, b, V.add(b, V.scale(W.n, bx.depth)), V.add(a, V.scale(W.n, bx.depth))], a, b, W });
    });
    (D.p.room.windows || []).forEach((w, j) => {
      const W = D.walls[w.wall];
      if (!W) return;
      const dp = winDepth(D.p.room, w), o = V.scale(W.n, dp);
      const a = V.add(V.add(W.a, V.scale(W.u, w.off)), o), b = V.add(V.add(W.a, V.scale(W.u, w.off + w.w)), o);
      out.push({ kind: 'win', id: w.id, wall: w.wall, label: nm(w, `窗 ${j + 1}`), frosted: w.glass === 'frosted', quad: [a, b, V.add(b, V.scale(W.n, -T)), V.add(a, V.scale(W.n, -T))], a, b, W });
    });
    for (const it of D.lay.items) {
      const li = lib(it.libId);
      if (!li || !isWall(li) || it.host) continue; // 貼在門上的物件跟著門片，不畫在牆上
      const W = D.walls[it.wall];
      if (!W) continue;
      const th = Math.max(li.d, 7 / s);
      const a = V.add(W.a, V.scale(W.u, it.off - li.w / 2)), b = V.add(W.a, V.scale(W.u, it.off + li.w / 2));
      out.push({ kind: 'art', id: it.id, wall: it.wall, label: li.name, li, quad: [a, b, V.add(b, V.scale(W.n, th)), V.add(a, V.scale(W.n, th))], a, b, W });
    }
    return out;
  }
  drawWallThings(ctx, D) {
    const s = this.scale;
    for (const t of this.wallThings(D)) {
      ctx.beginPath(); t.quad.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
      if (t.kind === 'box') {
        ctx.fillStyle = 'rgba(120,110,100,.12)'; ctx.fill();
        ctx.setLineDash([6 / s, 4 / s]); ctx.strokeStyle = '#6b5f52'; ctx.lineWidth = 1.3 / s; ctx.stroke(); ctx.setLineDash([]);
      } else if (t.kind === 'win') {
        ctx.fillStyle = t.frosted ? '#eef0ee' : '#e3eef2'; ctx.fill();
        ctx.strokeStyle = '#6f858f'; ctx.lineWidth = 1.2 / s; ctx.stroke();
        for (const f of [0.35, 0.65]) {
          const p1 = V.add(t.a, V.scale(t.W.n, -WALL_T * f)), p2 = V.add(t.b, V.scale(t.W.n, -WALL_T * f));
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        }
      } else {
        ctx.fillStyle = t.li.color; ctx.fill();
        ctx.strokeStyle = '#6b5f52'; ctx.lineWidth = 1.2 / s; ctx.stroke();
      }
    }
  }
  hitWallThing(w, tol) {
    if (!this.D) return null;
    for (const t of this.wallThings(this.D).reverse()) {
      const mid = V.mid(t.quad[0], t.quad[2]);
      const l = { x: V.dot(V.sub(w, mid), t.W.u), y: V.dot(V.sub(w, mid), t.W.n) };
      const hw = V.len(V.sub(t.b, t.a)) / 2, hd = Math.abs(V.dot(V.sub(t.quad[2], t.quad[1]), t.W.n)) / 2;
      if (Math.abs(l.x) <= hw + tol && Math.abs(l.y) <= hd + tol) return t;
    }
    return null;
  }
  // 點到牆（牆的外側厚度帶）
  hitWallBand(w, tol) {
    if (!this.D) return -1;
    let best = -1, bd = WALL_T + tol;
    this.D.walls.forEach((W, i) => {
      const t = V.dot(V.sub(w, W.a), W.u), d = -V.dot(V.sub(w, W.a), W.n);
      if (t < 0 || t > W.len || d < -tol) return;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  polyPath(ctx, poly) {
    ctx.beginPath();
    poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
  }

  floorStyle(ctx, room) {
    const img = room.floorTex ? getImg(room.floorTex) : null;
    if (!img) return room.floorColor || '#c9a985';
    const pat = ctx.createPattern(img, 'repeat');
    const t = room.floorTile || 300;
    pat.setTransform(new DOMMatrix().scale(t / img.naturalWidth, t / img.naturalHeight));
    return pat;
  }

  drawGrid(ctx) {
    const s = this.scale;
    const cs = [this.toW(0, 0), this.toW(this.w, 0), this.toW(0, this.h), this.toW(this.w, this.h)];
    const x0 = Math.min(...cs.map(c => c.x)), x1 = Math.max(...cs.map(c => c.x));
    const y0 = Math.min(...cs.map(c => c.y)), y1 = Math.max(...cs.map(c => c.y));
    const minor = s * 100 >= 9 ? 100 : s * 500 >= 9 ? 500 : 0;
    ctx.save();
    ctx.translate(this.ox, this.oy); ctx.rotate(this.viewRot); ctx.scale(s, s);
    ctx.lineWidth = 1 / s;
    for (const [st, col] of [[minor, C.grid], [1000, C.gridMaj]]) {
      if (!st) continue;
      ctx.beginPath();
      for (let x = Math.floor(x0 / st) * st; x <= x1; x += st) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let y = Math.floor(y0 / st) * st; y <= y1; y += st) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.strokeStyle = col; ctx.stroke();
    }
    ctx.restore();
  }

  drawItem(ctx, it, alpha) {
    const li = lib(it.libId);
    const w = li.w, d = li.d, rug = isRug(li);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(it.x, it.y);
    ctx.rotate((it.rot * Math.PI) / 180);
    ctx.beginPath();
    if (isRound(li)) ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2);
    else ctx.rect(-w / 2, -d / 2, w, d);
    ctx.fillStyle = li.color || C.item;
    ctx.fill();
    const img = li.tex && li.texMode && li.texMode !== 'none' ? getImg(li.tex) : null;
    if (img) {
      ctx.save();
      ctx.clip();
      if (li.texMode === 'fit') ctx.drawImage(img, -w / 2, -d / 2, w, d);
      else {
        const pat = ctx.createPattern(img, 'repeat');
        pat.setTransform(new DOMMatrix().translate(-w / 2, -d / 2).scale((li.tileW || 300) / img.naturalWidth, (li.tileH || 300) / img.naturalHeight));
        ctx.fillStyle = pat;
        ctx.fillRect(-w / 2, -d / 2, w, d);
      }
      ctx.restore();
    }
    ctx.lineWidth = (rug ? 1 : 1.6) / this.scale;
    ctx.strokeStyle = rug ? 'rgba(80,60,40,.5)' : C.itemStroke;
    if (rug) ctx.setLineDash([5 / this.scale, 4 / this.scale]);
    ctx.stroke();
    ctx.restore();
  }

  drawWallLabels(ctx, D) {
    const n = D.walls.length;
    this.wallHits = [];
    ctx.font = '600 11px -apple-system, "PingFang TC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    D.walls.forEach((e, i) => {
      const pos = this.toS(V.sub(e.mid, V.scale(e.n, WALL_T + 16 / this.scale)));
      this.wallHits[i] = this.pill(ctx, pos.x, pos.y, `牆${i + 1}　${cm(e.len)}`, 'rgba(255,253,249,.92)', '#5b524a');
    });
    D.walls.forEach((e, i) => {
      const prev = D.walls[(i - 1 + n) % n];
      const out = V.norm(V.scale(V.add(prev.n, e.n), -1));
      const pos = this.toS(V.add(e.a, V.scale(out, WALL_T * 1.4 + 12 / this.scale)));
      ctx.fillStyle = '#8a8076';
      ctx.font = '700 12px -apple-system, sans-serif';
      ctx.fillText(cornerName(i), pos.x, pos.y);
    });
  }

  drawItemLabels(ctx, items) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const it of items) {
      const li = lib(it.libId);
      const c = this.toS(it);
      const minPx = Math.min(li.w, li.d) * this.scale;
      const name = (it.locked ? '🔒 ' : '') + li.name;
      ctx.font = '600 12px -apple-system, "PingFang TC", sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.fillStyle = C.ink;
      const showDim = minPx > 46;
      const y = showDim ? c.y - 7 : c.y;
      ctx.strokeText(name, c.x, y); ctx.fillText(name, c.x, y);
      if (showDim) {
        ctx.font = '11px -apple-system, sans-serif';
        const t = `${cm(li.w)}×${cm(li.d)}`;
        ctx.strokeText(t, c.x, c.y + 8); ctx.fillStyle = '#5b524a'; ctx.fillText(t, c.x, c.y + 8);
      }
    }
  }

  pill(ctx, x, y, text, bg, fg) {
    const w = ctx.measureText(text).width + 12, h = 18;
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 9); ctx.fill();
    ctx.fillStyle = fg; ctx.fillText(text, x, y + 0.5);
    return { x, y, w, h };
  }

  seg(ctx, a, b, color, width, dash) {
    const A = this.toS(a), B = this.toS(b);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.stroke(); ctx.setLineDash([]);
  }

  dimLine(ctx, p1, p2, text, color) {
    const A = this.toS(p1), B = this.toS(p2);
    const d = V.norm(V.sub(B, A)), nn = { x: -d.y * 5, y: d.x * 5 };
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.moveTo(A.x - nn.x, A.y - nn.y); ctx.lineTo(A.x + nn.x, A.y + nn.y);
    ctx.moveTo(B.x - nn.x, B.y - nn.y); ctx.lineTo(B.x + nn.x, B.y + nn.y);
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const m = V.mid(A, B);
    return this.pill(ctx, m.x, m.y, text, color, '#fff');
  }

  drawMeasures(ctx, D) {
    this.measureHits = [];
    const map = new Map(D.refs.map(r => [r.key, r]));
    const key = refKey;
    for (const m of D.lay.measures) {
      const e1 = map.get(key(m.a)), e2 = map.get(key(m.b));
      if (!e1 || !e2) continue;
      if (!isParallel(e1, e2)) {
        const h = this.dimLine(ctx, e1.mid, e2.mid, '不平行', '#999');
        this.measureHits.push({ ...h, id: m.id });
        continue;
      }
      const g = measureGeom(e1, e2);
      const h = this.dimLine(ctx, g.p1, g.p2, cm(g.dist), C.measure);
      this.measureHits.push({ ...h, id: m.id });
    }
  }

  autoDims(it, D) {
    const li = lib(it.libId);
    const out = [];
    for (const e of itemEdges(it, li)) {
      let best = null;
      for (const r of D.refs) {
        if (r.owner === it.id || r.kind === 'door' || r.kind === 'beam' || r.kind === 'box' || !isParallel(e, r)) continue;
        const s = V.dot(V.sub(r.a, e.mid), e.n);
        if (s < -0.5) continue;
        const ta = V.dot(V.sub(r.a, e.a), e.u), tb = V.dot(V.sub(r.b, e.a), e.u);
        const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(e.len, Math.max(ta, tb));
        if (hi - lo < 1) continue;
        if (!best || s < best.s) best = { s, t: (lo + hi) / 2 };
      }
      if (best && best.s < 8000) {
        const p1 = V.add(e.a, V.scale(e.u, best.t));
        out.push({ p1, p2: V.add(p1, V.scale(e.n, best.s)), d: best.s });
      }
    }
    return out;
  }

  rotHandle(it) {
    const li = lib(it.libId);
    return V.add(it, V.rot({ x: 0, y: -li.d / 2 - ROT_GAP / this.scale }, (it.rot * Math.PI) / 180));
  }

  drawSelection(ctx, it, D) {
    const li = lib(it.libId);
    if (!li) return;
    const cs = itemCorners(it, li).map(q => this.toS(q));
    ctx.beginPath(); cs.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    if (isRound(li)) ctx.setLineDash([5, 4]);
    ctx.stroke(); ctx.setLineDash([]);
    if (this.pick) return;
    if (!this.drag || this.drag.type !== 'rot')
      for (const dm of this.autoDims(it, D)) this.dimLine(ctx, dm.p1, dm.p2, cm(dm.d), C.dim);
    // 可點的邊
    const edges = itemEdges(it, li);
    edges.forEach((e, i) => {
      const hot = this.hover && this.hover.type === 'edge' && this.hover.i === i;
      if (hot) this.seg(ctx, e.a, e.b, C.hot, 5);
      const m = this.toS(e.mid);
      ctx.beginPath(); ctx.arc(m.x, m.y, hot ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = hot ? C.hot : C.accent; ctx.lineWidth = 2; ctx.stroke();
    });
    if (!it.locked) {
      const top = this.toS(edges[0].mid), h = this.toS(this.rotHandle(it));
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(h.x, h.y);
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(h.x, h.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = this.hover?.type === 'rot' ? C.hot : C.accent; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('↻', h.x, h.y + 1);
    }
  }

  drawPick(ctx, D) {
    const it = L().items.find(x => x.id === this.pick.itemId);
    if (!it) return;
    const src = itemEdges(it, lib(it.libId))[this.pick.edge];
    for (const r of D.refs) {
      if (r.owner === it.id) continue;
      const par = isParallel(src, r);
      const hot = (this.hover?.type === 'ref' && this.hover.key === r.key) || this.pickTarget?.key === r.key;
      this.seg(ctx, r.a, r.b, hot ? C.hot : par ? 'rgba(47,125,118,.75)' : 'rgba(47,125,118,.22)', hot ? 6 : par ? 4 : 2.5);
    }
    this.seg(ctx, src.a, src.b, C.hot, 6);
  }

  drawMeasurePick(ctx, D) {
    for (const r of D.refs) {
      const hot = this.hover?.type === 'ref' && this.hover.key === r.key;
      const par = this.mpick && isParallel(this.mpick, r);
      const col = hot ? C.measure : this.mpick ? (par ? 'rgba(122,79,176,.7)' : 'rgba(122,79,176,.15)') : 'rgba(122,79,176,.35)';
      this.seg(ctx, r.a, r.b, col, hot ? 6 : par ? 4 : 2.5);
    }
    if (this.mpick) this.seg(ctx, this.mpick.a, this.mpick.b, C.hot, 6);
  }

  // ---------- 命中判定 ----------
  hitRef(w, tol, filter) {
    let best = null, bd = tol;
    for (const r of this.D?.refs || []) {
      if (filter && !filter(r)) continue;
      const d = segDist(w, r.a, r.b);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }
  hitOwnEdge(it, w, tol) {
    const li = lib(it.libId);
    let best = -1, bd = tol;
    itemEdges(it, li).forEach((e, i) => { const d = segDist(w, e.a, e.b); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  hitRot(it, pos, touch) {
    const h = this.toS(this.rotHandle(it));
    return Math.hypot(pos.x - h.x, pos.y - h.y) < (touch ? 22 : 13);
  }
  inside(it, w, pad) {
    const li = lib(it.libId);
    const l = V.rot(V.sub(w, it), (-it.rot * Math.PI) / 180);
    const a = li.w / 2 + pad, b = li.d / 2 + pad;
    return isRound(li) ? (l.x / a) ** 2 + (l.y / b) ** 2 <= 1 : Math.abs(l.x) <= a && Math.abs(l.y) <= b;
  }
  hitItem(w, pad) {
    const items = L().items.filter(it => lib(it.libId) && !isWall(lib(it.libId)));
    const furn = items.filter(it => !isRug(lib(it.libId))).reverse();
    const rugs = items.filter(it => isRug(lib(it.libId))).reverse();
    return furn.find(it => this.inside(it, w, pad)) || rugs.find(it => this.inside(it, w, pad)) || null;
  }

  // ---------- 指標事件 ----------
  down(e) {
    if (e.button === 2) return;
    const pos = this.evPos(e);
    try { this.c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.ev) return this.ev.down(e, pos);
    this.pointers.set(e.pointerId, pos);
    if (this.pointers.size === 2) {
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, scale: this.scale, ox: this.ox, oy: this.oy };
      return;
    }
    if (this.pointers.size > 2 || !this.D) return;
    if (this.hitCompass(pos)) { this.drag = null; this.toggleNorthUp(); return; }
    const touch = e.pointerType === 'touch';
    const w = this.toW(pos.x, pos.y);
    const tol = (touch ? 22 : 10) / this.scale;
    const base = { pos, w, tol, ox: this.ox, oy: this.oy, moved: false };
    if (this.mode === 'measure') { this.drag = { ...base, type: 'tapMeasure' }; return; }
    if (this.pick) { this.drag = { ...base, type: 'tapPick' }; return; }
    const sel = selItem();
    if (sel) {
      if (!sel.locked && this.hitRot(sel, pos, touch)) { this.drag = { ...base, type: 'rot', item: sel }; return; }
      const ei = this.hitOwnEdge(sel, w, tol);
      if (ei >= 0) { this.drag = { ...base, type: 'item', item: sel, edge: ei, orig: { x: sel.x, y: sel.y } }; return; }
    }
    const lh = this.wallHits.findIndex(h => h && Math.abs(pos.x - h.x) < h.w / 2 + 4 && Math.abs(pos.y - h.y) < h.h / 2 + 4);
    if (lh >= 0) { this.drag = { ...base, type: 'pan', wallTap: lh }; return; }
    const wt = this.hitWallThing(w, (touch ? 10 : 4) / this.scale);
    if (wt) { this.drag = { ...base, type: 'pan', wallTap: wt.wall, wallSel: wt.id }; return; }
    const hit = this.hitItem(w, touch ? 6 / this.scale : 0);
    if (hit) {
      if (S.sel !== hit.id) { S.sel = hit.id; emit('selection'); }
      this.drag = { ...base, type: 'item', item: hit, edge: -1, orig: { x: hit.x, y: hit.y } };
      this.draw();
      return;
    }
    const wb = this.hitWallBand(w, tol * 0.5);
    this.drag = { ...base, type: 'pan', wallTap: wb >= 0 ? wb : null };
  }

  move(e) {
    const pos = this.evPos(e);
    if (this.ev) return this.ev.move(e, pos);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const pc = this.pinch;
      const ns = clamp(pc.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pc.d), MIN_S, MAX_S);
      const wx = (pc.cx - pc.ox) / pc.scale, wy = (pc.cy - pc.oy) / pc.scale;
      this.scale = ns;
      this.ox = (a.x + b.x) / 2 - wx * ns;
      this.oy = (a.y + b.y) / 2 - wy * ns;
      this.draw();
      return;
    }
    const dr = this.drag;
    if (!dr) { if (e.pointerType === 'mouse') this.updateHover(pos); return; }
    const dx = pos.x - dr.pos.x, dy = pos.y - dr.pos.y;
    if (!dr.moved && Math.hypot(dx, dy) < 5) return;
    const first = !dr.moved;
    dr.moved = true;
    if (dr.type === 'item' && dr.item.locked) {
      if (first) this.ui.toast('這個物件已鎖定（在右側面板可以解鎖）');
      dr.type = 'pan';
    }
    if (dr.type === 'pan' || dr.type === 'tapPick' || dr.type === 'tapMeasure') {
      this.ox = dr.ox + dx; this.oy = dr.oy + dy;
      this.draw();
      return;
    }
    if (dr.type === 'item') {
      if (first) checkpoint();
      const it = dr.item;
      const fine = e.shiftKey;
      const step = fine ? 1 : 10; // 預設 1 cm，按住 Shift 0.1 cm
      const wd = this.toWDelta(dx, dy);
      it.x = dr.orig.x + Math.round(wd.x / step) * step;
      it.y = dr.orig.y + Math.round(wd.y / step) * step;
      this.snapHits = [];
      if (!fine) this.edgeSnap(it, (e.pointerType === 'touch' ? 14 : 8) / this.scale);
      this.draw();
      return;
    }
    if (dr.type === 'rot') {
      if (first) checkpoint();
      const it = dr.item, c = this.toS(it);
      let ang = ((Math.atan2(pos.y - c.y, pos.x - c.x) - this.viewRot) * 180) / Math.PI + 90;
      ang = e.shiftKey ? Math.round(ang) : Math.round(ang / 15) * 15;
      it.rot = normDeg(ang);
      this.draw();
      this.ui.refreshInspector();
    }
  }

  up(e, cancel) {
    if (this.ev) return this.ev.up(e, cancel);
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    const dr = this.drag;
    this.drag = null;
    this.snapHits = [];
    if (!dr) return;
    if (cancel) { this.draw(); return; }
    if (dr.moved) {
      if (dr.type === 'item' || dr.type === 'rot') changed();
      this.draw();
      return;
    }
    switch (dr.type) {
      case 'pan':
        if (dr.wallTap != null) { this.openWall(dr.wallTap, dr.wallSel || null); return; }
        if (S.sel) { S.sel = null; emit('selection'); }
        break;
      case 'item':
        if (dr.edge >= 0) {
          if (dr.item.locked) this.ui.toast('這個物件已鎖定，解鎖後才能用距離移動它');
          else this.startPick(dr.item, dr.edge);
        }
        break;
      case 'tapPick': {
        const r = this.hitRef(dr.w, dr.tol, x => x.owner !== this.pick.itemId);
        if (r) this.finishPick(r); else this.cancelPick();
        break;
      }
      case 'tapMeasure': this.measureTap(dr.pos, dr.w, dr.tol); break;
    }
    this.draw();
  }

  wheel(e) {
    e.preventDefault();
    const pos = this.evPos(e);
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 100);
    if (e.ctrlKey || mouseWheel) this.zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else if (this.ev) { this.ev.ox -= e.deltaX; this.ev.oy -= e.deltaY; this.draw(); }
    else { this.ox -= e.deltaX; this.oy -= e.deltaY; this.draw(); }
  }

  updateHover(pos) {
    if (!this.D) return;
    const w = this.toW(pos.x, pos.y), tol = 10 / this.scale;
    let h = null, cursor = 'default';
    if (this.mode === 'measure' || this.pick) {
      const r = this.hitRef(w, tol, this.pick ? x => x.owner !== this.pick.itemId : null);
      if (r) { h = { type: 'ref', key: r.key }; cursor = 'pointer'; }
    } else {
      const sel = selItem();
      if (this.hitCompass(pos)) cursor = 'pointer';
      else if (sel && !sel.locked && this.hitRot(sel, pos, false)) { h = { type: 'rot' }; cursor = 'grab'; }
      else if (sel && this.hitOwnEdge(sel, w, tol) >= 0) { h = { type: 'edge', i: this.hitOwnEdge(sel, w, tol) }; cursor = 'pointer'; }
      else if (this.hitItem(w, 0)) cursor = 'move';
      else if (this.wallHits.some(hh => hh && Math.abs(pos.x - hh.x) < hh.w / 2 + 4 && Math.abs(pos.y - hh.y) < hh.h / 2 + 4) || this.hitWallThing(w, 4 / this.scale) || this.hitWallBand(w, 0) >= 0) cursor = 'pointer';
    }
    this.c.style.cursor = cursor;
    if (JSON.stringify(h) !== JSON.stringify(this.hover)) { this.hover = h; this.draw(); }
  }

  // 拖曳時貼齊平行邊（貼平）
  edgeSnap(it, tolW) {
    const li = lib(it.libId);
    const refs = this.D.refs.filter(r => r.owner !== it.id && r.kind !== 'beam' && r.kind !== 'box');
    const pass = exclN => {
      let b = null;
      for (const e of itemEdges(it, li)) for (const r of refs) {
        if (!isParallel(e, r)) continue;
        if (exclN && Math.abs(V.dot(r.n, exclN)) > 0.5) continue;
        const ta = V.dot(V.sub(r.a, e.a), e.u), tb = V.dot(V.sub(r.b, e.a), e.u);
        if (Math.min(e.len, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) < -tolW) continue;
        const s = V.dot(V.sub(e.mid, r.a), r.n);
        if (Math.abs(s) < tolW && (!b || Math.abs(s) < Math.abs(b.s))) b = { s, r };
      }
      return b;
    };
    const b1 = pass(null);
    if (!b1) return;
    it.x -= b1.r.n.x * b1.s; it.y -= b1.r.n.y * b1.s;
    this.snapHits.push(b1.r);
    const b2 = pass(b1.r.n);
    if (b2) { it.x -= b2.r.n.x * b2.s; it.y -= b2.r.n.y * b2.s; this.snapHits.push(b2.r); }
  }

  // ---------- 以邊設定距離 ----------
  startPick(it, edge) {
    this.pick = { itemId: it.id, edge };
    this.pickTarget = null;
    this.ui.updateHint();
  }
  cancelPick() {
    if (this.ev) return this.ev.cancelPick();
    this.pick = null; this.pickTarget = null;
    this.ui.hideDistance();
    this.ui.updateHint();
    this.draw();
  }
  finishPick(r) {
    const { itemId, edge } = this.pick;
    const it = L().items.find(x => x.id === itemId);
    if (!it) return this.cancelPick();
    const li = lib(it.libId);
    let e = itemEdges(it, li)[edge];
    let dRot = 0;
    if (!isParallel(e, r)) {
      let d = ((Math.atan2(r.u.y, r.u.x) - Math.atan2(e.u.y, e.u.x)) * 180) / Math.PI;
      d = ((d % 180) + 180) % 180;
      if (d > 90) d -= 180;
      dRot = d;
      e = itemEdges({ ...it, rot: it.rot + dRot }, li)[edge];
    }
    const s0 = V.dot(V.sub(e.mid, r.a), r.n);
    this.pickTarget = r;
    this.ui.showDistance({
      current: Math.abs(s0), rot: dRot, from: li.name, to: r.label,
      onApply: (dmm, pin, flip) => {
        checkpoint();
        const cur = L().items.find(x => x.id === itemId);
        if (!cur) return;
        cur.rot = normDeg(cur.rot + dRot);
        const e2 = itemEdges(cur, li)[edge];
        const s2 = V.dot(V.sub(e2.mid, r.a), r.n);
        let side = Math.sign(s2) || Math.sign(V.dot(V.sub(cur, r.a), r.n)) || 1;
        if (flip) side = -side;
        const mv = side * dmm - s2;
        cur.x += r.n.x * mv; cur.y += r.n.y * mv;
        if (pin) L().measures.push({ id: uid(), a: { k: 'item', id: cur.id, e: edge }, b: r.ref });
        changed();
        this.cancelPick();
      },
      onCancel: () => this.cancelPick(),
    });
    this.draw();
  }

  // ---------- 量測線 ----------
  measureTap(pos, w, tol) {
    const mh = this.measureHits.find(h => Math.abs(pos.x - h.x) < h.w / 2 + 4 && Math.abs(pos.y - h.y) < h.h / 2 + 4);
    if (mh) {
      checkpoint();
      L().measures = L().measures.filter(m => m.id !== mh.id);
      changed();
      this.ui.toast('已刪除量測線');
      return;
    }
    const r = this.hitRef(w, tol);
    if (!r) { this.mpick = null; this.ui.updateHint(); return; }
    if (!this.mpick || this.mpick.key === r.key) { this.mpick = this.mpick ? null : r; this.ui.updateHint(); return; }
    if (!isParallel(r, this.mpick)) { this.ui.toast('兩條邊需要互相平行才能量距離'); return; }
    checkpoint();
    L().measures.push({ id: uid(), a: this.mpick.ref, b: r.ref });
    this.mpick = null;
    changed();
    this.ui.updateHint();
  }
}
