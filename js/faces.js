// 各面外觀：li.faces[key] = { mode, color, tex, tileW, tileH, src, flip }
// mode：inherit（跟整體）、color、photo、tile、same（同另一面，可左右反轉）、extend（牆面物件的邊：延伸正面照片）
// 前＝2D 俯視、沒旋轉時朝下的那一面；右＝站在前面看過去的右手邊

export const FACE_SETS = {
  box: [['top', '頂'], ['front', '前'], ['right', '右'], ['back', '後'], ['left', '左'], ['bottom', '底']],
  cyl: [['top', '頂'], ['side', '側面'], ['bottom', '底']],
  wall: [['front', '正面'], ['top', '上緣'], ['right', '右緣'], ['back', '背面'], ['bottom', '下緣'], ['left', '左緣']],
};
export const faceSet = li => FACE_SETS[li.shape === 'wall' ? 'wall' : li.shape === 'cyl' ? 'cyl' : li.shape === 'box' ? 'box' : ''] || null;
export const faceName = (li, key) => (faceSet(li) || []).find(([k]) => k === key)?.[1] || key;

// 這一面的實際尺寸 [寬, 高]（mm），照片校正比例與材質鋪貼用
export function faceDims(li, key) {
  const { w, d, h } = li;
  if (key === 'top' || key === 'bottom') return li.shape === 'wall' ? [w, d] : [w, d];
  if (key === 'side') return [(Math.PI * (w + d)) / 2, h];
  if (key === 'left' || key === 'right') return [d, h];
  return [w, h]; // front、back
}

// 照片的方向提示
export function faceOrient(li, key) {
  if (li.shape === 'wall') {
    if (key === 'front') return '正對著拍，照片上方＝物件上方';
    if (key === 'back') return '翻到背面正對著拍，照片上方＝物件上方';
    if (key === 'top') return '照片上方＝靠牆那側';
    if (key === 'bottom') return '照片上方＝朝房內那側';
    return '照片上方＝物件上方';
  }
  if (key === 'top') return '以 2D 俯視圖的方向為準：照片上方＝物件的「後」';
  if (key === 'bottom') return '照片上方＝物件的「前」';
  if (key === 'side') return '繞一圈的展開圖，照片上方＝物件上方';
  return '正對著這一面拍，照片上方＝物件上方';
}

const mainFace = li => (li.shape === 'wall' ? 'front' : 'top');
const plain = li => ({ kind: 'color', color: li.color || '#cbbfae' });

// 算出某一面最後長什麼樣子：{ kind:'color', color } | { kind:'photo'|'tile'|'extend', tex, tileW, tileH, edge, flip }
export function resolveFace(li, key, depth = 0) {
  const f = li.faces?.[key];
  const mode = f?.mode || 'inherit';
  if (mode === 'inherit') {
    if (li.tex && li.texMode === 'fit' && key === mainFace(li)) return { kind: 'photo', tex: li.tex };
    if (li.tex && li.texMode === 'tile' && key !== (li.shape === 'wall' ? 'back' : 'bottom'))
      return { kind: 'tile', tex: li.tex, tileW: li.tileW || 300, tileH: li.tileH || 300 };
    return plain(li);
  }
  if (mode === 'color') return { kind: 'color', color: f.color || li.color || '#cbbfae' };
  if (mode === 'photo') return f.tex ? { kind: 'photo', tex: f.tex } : plain(li);
  if (mode === 'tile') return f.tex ? { kind: 'tile', tex: f.tex, tileW: f.tileW || 300, tileH: f.tileH || 300 } : plain(li);
  if (mode === 'same') {
    if (depth > 4 || !f.src || f.src === key) return plain(li);
    const r = resolveFace(li, f.src, depth + 1);
    return r.kind === 'color' ? r : { ...r, flip: !!f.flip !== !!r.flip };
  }
  if (mode === 'extend') {
    const r = resolveFace(li, 'front', depth + 1);
    return r.kind === 'photo' ? { kind: 'extend', tex: r.tex, edge: key, flip: r.flip } : r;
  }
  return plain(li);
}

// 這件物品用到的所有圖片 id（刪除物品時一起刪）
export const faceTexIds = li => [li.tex, ...Object.values(li.faces || {}).map(f => f?.tex)].filter(Boolean);

// 在 2D 俯視圖上，物件面向某方向（平面向量 n）的是哪一面；對不太齊（斜放）回傳 null
export function faceToward(it, n) {
  const r = (it.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dirs = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] };
  for (const [k, [x, y]] of Object.entries(dirs)) {
    const v = { x: x * c - y * s, y: x * s + y * c };
    if (v.x * n.x + v.y * n.y > 0.97) return k;
  }
  return null;
}
