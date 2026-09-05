/** 華語語音距離。
 *
 * 把文字轉成逐字拼音序列，再以「聲母／韻母混淆表」計算音節距離。
 * 混淆表收錄台灣華語常見不分的音：ㄓㄗ、ㄔㄘ、ㄕㄙ、ㄋㄌ、ㄈㄏ、
 * 前後鼻音（in/ing、en/eng、an/ang）等，這正是 STT 誤辨識的主要來源。
 *
 * 拼音由 pinyin-pro 提供（純 JS，可跑在 Cloudflare Worker）；多音字取音
 * 以「詞彙表與輸入文字走同一函式」保證引擎內部自我一致，
 * 評估集品質門檻（vitest）守住整體行為。
 */

// pinyin-pro 在模組頂層呼叫 setTimeout（Workers 全域禁用）——
// 改成惰性動態載入：第一個請求進 handler 後才 import（此時合法）。
type PinyinFn = (text: string, opts: { toneType: "none"; type: "array"; v: boolean }) => string[];
let pinyinFn: PinyinFn | null = null;

/** 使用引擎前必須先呼叫一次（在請求處理中，不能在全域）。 */
export async function ensurePinyin(): Promise<void> {
  if (!pinyinFn) {
    const mod = await import("pinyin-pro");
    pinyinFn = mod.pinyin as unknown as PinyinFn;
  }
}

// 聲母表：長的要排前面才能正確切分（zh 要先於 z）
const INITIALS = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l",
  "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w",
];

// 可互相混淆的聲母組（台灣華語常見；同組距離視為很近）
const INITIAL_CONFUSION: string[][] = [
  ["zh", "z"], ["ch", "c"], ["sh", "s"], ["n", "l"], ["f", "h"], ["r", "l"],
];

// 可互相混淆的韻母組（前後鼻音不分等）
const FINAL_CONFUSION: string[][] = [
  ["in", "ing"], ["en", "eng"], ["an", "ang"], ["uan", "uang"], ["o", "uo"], ["e", "o"],
];

function splitSyllable(syl: string): [string, string] {
  for (const ini of INITIALS) {
    if (syl.startsWith(ini) && syl.length > ini.length) return [ini, syl.slice(ini.length)];
  }
  return ["", syl];
}

function inSameGroup(a: string, b: string, groups: string[][]): boolean {
  return groups.some((g) => g.includes(a) && g.includes(b));
}

function levenshtein(a: string, b: string): number {
  const n = a.length, m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i, ...new Array<number>(m).fill(0)];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[m];
}

const distCache = new Map<string, number>();

/** 兩個音節的距離，0.0（相同）～1.0（完全不同）。 */
export function syllableDistance(a: string, b: string): number {
  if (a === b) return 0.0;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const hit = distCache.get(key);
  if (hit !== undefined) return hit;
  const [ia, fa] = splitSyllable(a);
  const [ib, fb] = splitSyllable(b);
  let dist = 0.0;
  if (ia !== ib) dist += inSameGroup(ia, ib, INITIAL_CONFUSION) ? 0.15 : 0.5;
  if (fa !== fb) {
    if (inSameGroup(fa, fb, FINAL_CONFUSION)) {
      dist += 0.15;
    } else {
      // 韻母不同組時退回字元編輯距離（捕捉 ai/an 這類部分相似）
      const denom = Math.max(fa.length, fb.length) || 1;
      dist += 0.5 * (levenshtein(fa, fb) / denom);
    }
  }
  dist = Math.min(dist, 1.0);
  if (distCache.size < 65536) distCache.set(key, dist);
  return dist;
}

const pinyinCache = new Map<string, string>();

function charToPinyin(ch: string): string {
  const hit = pinyinCache.get(ch);
  if (hit !== undefined) return hit;
  if (!pinyinFn) throw new Error("phonetics 未初始化：請先 await ensurePinyin()");
  const py = pinyinFn(ch, { toneType: "none", type: "array", v: true })[0] ?? "";
  const out = py.trim().toLowerCase();
  pinyinCache.set(ch, out);
  return out;
}

const isAsciiAlnum = (ch: string) => /^[A-Za-z0-9]$/.test(ch);

/** 文字 → 逐字拼音序列。中文逐字轉拼音；ASCII 連續段（台語羅馬字等）
 * 以連字號切分後原樣保留。 */
export function textToSyllables(text: string): string[] {
  const out: string[] = [];
  let buf = ""; // 暫存 ASCII 連續段
  for (const ch of text) {
    const ascii = ch.charCodeAt(0) < 128;
    if (ascii && (isAsciiAlnum(ch) || ch === "-")) {
      buf += ch;
      continue;
    }
    if (buf) {
      for (const p of buf.toLowerCase().split("-")) if (p) out.push(p);
      buf = "";
    }
    if (!ascii) {
      const py = charToPinyin(ch);
      if (py) out.push(py);
    }
  }
  if (buf) for (const p of buf.toLowerCase().split("-")) if (p) out.push(p);
  return out;
}

/** 兩個音節序列的相似度 0.0～1.0。以音節距離做加權編輯距離後正規化。 */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0.0;
  const n = a.length, m = b.length;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i, ...new Array<number>(m).fill(0)];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        prev[j] + 1.0,
        cur[j - 1] + 1.0,
        prev[j - 1] + syllableDistance(a[i - 1], b[j - 1]),
      );
    }
    prev = cur;
  }
  return 1.0 - prev[m] / Math.max(n, m);
}
