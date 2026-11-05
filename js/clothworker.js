// 背景執行緒：跑布料模擬，算完把結果傳回主畫面（不卡拖曳和捲動）
import { simulateSync } from './cloth.js?v=0.12.1';

self.onmessage = e => {
  const { key, id, li, pins, env } = e.data;
  const r = simulateSync(li, pins, env);
  self.postMessage({ key, id, r }, [r.pos.buffer]);
};
