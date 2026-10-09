// 太陽位置（SunCalc 同款天文公式，不需要網路）
const rad = Math.PI / 180, dayMs = 86400000, J1970 = 2440588, J2000 = 2451545, OB = rad * 23.4397;
const toDays = date => date.valueOf() / dayMs - 0.5 + J1970 - J2000;

// 回傳 bearing：方位角（從正北順時針，度）；alt：仰角（度）
export function sunPos(date, lat, lng) {
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OB) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OB), Math.cos(L));
  const H = rad * (280.16 + 360.9856235 * d) - lw - ra;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  return { bearing: (((az / rad + 180) % 360) + 360) % 360, alt: alt / rad };
}

// 當地時間（以 UTC 時差表示）→ Date
export const localDate = (year, doy, minutes, tz) => new Date(Date.UTC(year, 0, 1) + (doy - 1) * dayMs + minutes * 60000 - tz * 3600000);

export function dayInfo(year, doy, lat, lng, tz) {
  let rise = null, set = null, prev = null, noon = { alt: -90, m: 720 };
  for (let m = 0; m <= 1440; m += 5) {
    const a = sunPos(localDate(year, doy, m, tz), lat, lng).alt;
    if (prev != null) {
      if (prev < 0 && a >= 0 && rise == null) rise = m;
      if (prev >= 0 && a < 0) set = m;
    }
    if (a > noon.alt) noon = { alt: a, m };
    prev = a;
  }
  return { rise, set, noon };
}

export const doyOf = d => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / dayMs) + 1;
export const mdOf = (year, doy) => { const d = new Date(Date.UTC(year, 0, doy)); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
export const bearingName = b => ['北', '東北', '東', '東南', '南', '西南', '西', '西北'][Math.round(b / 45) % 8];

// 平面圖上「朝向太陽」的水平單位向量。north＝北方相對平面圖上方的順時針角度
export function sunDir2(bearing, north) {
  const t = ((north + bearing) * Math.PI) / 180;
  return { x: Math.sin(t), y: -Math.cos(t) };
}
