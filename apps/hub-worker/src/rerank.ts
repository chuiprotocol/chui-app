/** 封閉詞彙重排序引擎——本專案的核心技術。
 *
 * 流程：
 * 1. 把 STT 候選文字轉成音節序列（保留與原字對齊）。
 * 2. 以滑動視窗對菜單詞彙（品項／選項／同義詞）做語音距離比對，
 *    支援「縮寫字首」比對（「奶」→「奶茶」、「中冰奶」→ 中杯＋冰＋奶茶）。
 * 3. 動態規劃挑出不重疊、總分最高的比對組合。
 * 4. 依語段（還有／跟／逗號 切分）把選項與數量掛到品項上。
 * 5. 計算信心度；不足門檻或前二名太接近 → 回澄清問題，絕不猜。
 */

import { sequenceSimilarity, syllableDistance, textToSyllables } from "./phonetics.js";

export const RERANK_CONFIDENCE_THRESHOLD = 0.62;
export const RERANK_AMBIGUITY_MARGIN = 0.08;

// 開頭的客套/贅詞，比對前先剝掉（只剝開頭，避免誤傷品項）
const LEADING_FILLERS = ["老闆", "你好", "妳好", "請給我", "給我", "幫我", "麻煩", "我要", "我想要", "請", "來"];
// 語段分隔詞：一段一個品項，選項掛在同段品項上
const SEPARATORS = ["還有", "然後", "跟", "和", "另外", "以及"];
// 不列入覆蓋率分母的贅音（語助詞、量詞尾音等）
const IGNORABLE_CHARS = new Set("的喔哦啊嗯欸誒了嘛呢吧要點份個杯顆塊謝");

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const MEASURE_WORDS = new Set("杯個份顆塊條片碗");
const isDigitStr = (s: string) => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/** 中文數字（一～九十九）或阿拉伯數字 → 整數；解析不了回 null。 */
function parseCnNumber(chars: string): number | null {
  if (isDigitStr(chars)) return parseInt(chars, 10);
  if (!chars) return null;
  if (chars.includes("十")) {
    const idx = chars.indexOf("十");
    const left = chars.slice(0, idx);
    const right = chars.slice(idx + 1);
    const tens = left ? CN_DIGITS[left] ?? NaN : 1;
    const ones = right ? CN_DIGITS[right] ?? NaN : 0;
    if (Number.isNaN(tens) || Number.isNaN(ones)) return null;
    return tens * 10 + ones;
  }
  let val = 0;
  for (const c of chars) {
    if (!(c in CN_DIGITS)) return null;
    val = val * 10 + CN_DIGITS[c];
  }
  return val;
}

// ---- 菜單型別（協議菜單格式，同 PROTOCOL.md）----

export interface MenuChoice {
  id: string; name: string; synonyms?: string[]; price_delta?: number;
}
export interface MenuOption {
  id: string; name: string; required?: boolean; default?: string; choices: MenuChoice[];
}
export interface MenuItem {
  id: string; name: string; base_price: number; synonyms?: string[]; options?: MenuOption[];
}
export interface Menu {
  menu_version?: string; currency?: string; items: MenuItem[];
}

interface VocabEntry {
  kind: "item" | "choice";
  itemId: string;
  optionId: string;
  choiceId: string;
  surface: string;
  matchedSurface: string;
  syllables: string[];
}

interface Match {
  start: number;
  end: number;
  score: number;
  entry: VocabEntry;
  isPrefix: boolean; // 縮寫字首比對（「奶」→「奶茶」），需鄰接證據才採信
}

export interface ParsedItem {
  item_id: string;
  name: string;
  qty: number;
  options: Record<string, string>; // option_id -> choice_id（含必填預設值）
  score: number;
  // 使用者「明講」的選項（覆誦只唸這些；沒說的預設值靜默套用）
  explicit_options: Record<string, string>;
}

export interface ParseResult {
  ok: boolean;
  items: ParsedItem[];
  confidence: number;
  clarification_question?: string;
  clarification_candidates?: string[];
  source_text: string;
}

type Quantity = [pos: number, num: number, raw: string];

export class RerankEngine {
  private menu: Menu;
  private itemsById: Map<string, MenuItem>;
  private vocab: VocabEntry[] = [];
  // 每個品項的「選項字面 → [option_id, choice_id]」對照表
  private choiceSurfaceByItem: Map<string, Map<string, [string, string]>> = new Map();

  constructor(menu: Menu) {
    this.menu = menu;
    this.itemsById = new Map(menu.items.map((it) => [it.id, it]));
    for (const it of menu.items) {
      for (const surf of [it.name, ...(it.synonyms ?? [])]) {
        this.vocab.push({
          kind: "item", itemId: it.id, optionId: "", choiceId: "",
          surface: it.name, matchedSurface: surf, syllables: textToSyllables(surf),
        });
      }
      for (const opt of it.options ?? []) {
        for (const ch of opt.choices) {
          for (const surf of [ch.name, ...(ch.synonyms ?? [])]) {
            this.vocab.push({
              kind: "choice", itemId: it.id, optionId: opt.id, choiceId: ch.id,
              surface: ch.name, matchedSurface: surf, syllables: textToSyllables(surf),
            });
          }
        }
      }
    }
    for (const e of this.vocab) {
      if (e.kind === "choice") {
        let m = this.choiceSurfaceByItem.get(e.itemId);
        if (!m) { m = new Map(); this.choiceSurfaceByItem.set(e.itemId, m); }
        m.set(e.matchedSurface, [e.optionId, e.choiceId]);
      }
    }
  }

  /** 對每個 STT 候選各跑一次，回傳信心度最高者。 */
  parse(sttCandidates: string[]): ParseResult {
    let best: ParseResult | null = null;
    for (const text of sttCandidates) {
      if (!text || !text.trim()) continue;
      const result = this.parseOne(text.trim());
      if (best === null || result.confidence > best.confidence) best = result;
    }
    if (best === null) {
      return {
        ok: false, items: [], confidence: 0.0, source_text: "",
        clarification_question: "不好意思，我沒有聽清楚，請再說一次您要點什麼。",
      };
    }
    return best;
  }

  private parseOne(rawText: string): ParseResult {
    const text = this.stripLeadingFillers(rawText);
    const [chars, quantities] = this.extractQuantities(text);
    const segments = this.segment(chars);

    const allItems: ParsedItem[] = [];
    let ambiguity: [string, string] | null = null;
    let covered = 0;
    let denom = 0;

    for (const [segChars, segOffset] of segments) {
      const syls = this.charSyllables(segChars).map(([s]) => s);
      if (!syls.length) continue;
      const matches = this.findMatches(syls);
      let chosen = this.selectNonOverlapping(matches);
      chosen = this.filterPrefixMatches(chosen, quantities, segChars, segOffset);
      const amb = this.detectAmbiguity(matches, chosen);
      if (amb && ambiguity === null) ambiguity = amb;
      allItems.push(...this.assemble(chosen, quantities, segChars, segOffset));
      denom += [...segChars].filter((c) => !IGNORABLE_CHARS.has(c)).length;
      covered += chosen.reduce((sum, m) => sum + this.windowCharLen(segChars, m.start, m.end), 0);
    }

    if (!allItems.length) {
      return {
        ok: false, items: [], confidence: 0.0, source_text: text,
        clarification_question: "不好意思，我沒有對到菜單上的品項，請再說一次您要點什麼。",
      };
    }

    const coverage = denom ? Math.min(1.0, covered / denom) : 0.0;
    const meanScore = allItems.reduce((s, i) => s + i.score, 0) / allItems.length;
    const confidence = meanScore * (0.6 + 0.4 * coverage);

    if (ambiguity !== null) {
      const [a, b] = ambiguity;
      return {
        ok: false, items: allItems, confidence, source_text: text,
        clarification_question: `請問您是要「${a}」還是「${b}」呢？`,
        clarification_candidates: [a, b],
      };
    }

    if (confidence < RERANK_CONFIDENCE_THRESHOLD) {
      const guess = allItems.map((i) => this.describeItem(i)).join("、");
      return {
        ok: false, items: allItems, confidence, source_text: text,
        clarification_question: `我不太確定有沒有聽對：您是要點「${guess}」嗎？請回答「對」或再說一次。`,
        clarification_candidates: [guess],
      };
    }

    return { ok: true, items: allItems, confidence, source_text: text };
  }

  // ---- 前處理 ----

  private stripLeadingFillers(text: string): string {
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of LEADING_FILLERS) {
        if (text.startsWith(f)) {
          text = text.slice(f.length);
          changed = true;
        }
      }
    }
    return text;
  }

  /** 抽出「兩杯」「3個」等數量詞。
   * 回傳（移除數量詞後的字串, [(位置, 數量, 原始字面)]）。
   * 「十顆」在「鍋貼十顆」裡其實是規格選項而不是數量，原始字面保留供組裝還原。 */
  private extractQuantities(text: string): [string, Quantity[]] {
    const chars = [...text];
    const out: string[] = [];
    const quantities: Quantity[] = [];
    let i = 0;
    while (i < chars.length) {
      let j = i;
      while (j < chars.length &&
             (chars[j] in CN_DIGITS || chars[j] === "十" || isDigitStr(chars[j]))) {
        j += 1;
      }
      if (j > i) {
        const numStr = chars.slice(i, j).join("");
        const num = parseCnNumber(numStr);
        const hasMeasure = j < chars.length && MEASURE_WORDS.has(chars[j]);
        // 中文數字必須跟著量詞（一「杯」）才算數量——
        // 否則「四」季春青茶的「四」會被搶去當 4 份。
        // 阿拉伯數字（「3 鹽酥雞」）辨識度夠，量詞可省。
        const isCn = [...numStr].some((ch) => !isDigitStr(ch));
        if (num !== null && num > 0 && (hasMeasure || !isCn)) {
          if (hasMeasure) j += 1; // 連量詞一起吃掉
          quantities.push([out.length, num, chars.slice(i, j).join("")]);
          i = j;
          continue;
        }
      }
      out.push(chars[i]);
      i += 1;
    }
    return [out.join(""), quantities];
  }

  /** 依分隔詞與標點切語段。回傳 [(語段字串, 在全文中的起始位移)]。 */
  private segment(charsStr: string): Array<[string, number]> {
    const chars = [...charsStr];
    let i = 0;
    const cuts: Array<[number, number]> = [];
    while (i < chars.length) {
      if ("，。！？、,.!?;；".includes(chars[i])) {
        cuts.push([i, i + 1]);
        i += 1;
        continue;
      }
      const rest = chars.slice(i).join("");
      const hit = SEPARATORS.find((s) => rest.startsWith(s));
      if (hit) {
        // 單字分隔詞（跟／和）可能是詞彙的一部分（「培『跟』蛋餅」是
        // 培根的誤辨字），只有兩側都至少 2 個字才視為分隔
        const prevCutEnd = cuts.length ? cuts[cuts.length - 1][1] : 0;
        const leftLen = i - prevCutEnd;
        const rightLen = chars.length - (i + hit.length);
        if (hit.length === 1 && (leftLen < 2 || rightLen < 2)) {
          i += 1;
          continue;
        }
        cuts.push([i, i + hit.length]);
        i += hit.length;
      } else {
        i += 1;
      }
    }
    const segments: Array<[string, number]> = [];
    let prev = 0;
    for (const [s, e] of [...cuts, [chars.length, chars.length] as [number, number]]) {
      if (s > prev) segments.push([chars.slice(prev, s).join(""), prev]);
      prev = e;
    }
    return segments.filter(([seg]) => seg.trim());
  }

  /** 回傳 [(音節, 對應原始字元數)]。ASCII 段算一個音節但佔多個字元。 */
  private charSyllables(charsStr: string): Array<[string, number]> {
    const result: Array<[string, number]> = [];
    let buf = "";
    for (const ch of charsStr) {
      const ascii = ch.charCodeAt(0) < 128;
      if (ascii && (/^[A-Za-z0-9]$/.test(ch) || ch === "-")) {
        buf += ch;
        continue;
      }
      if (buf) {
        for (const part of buf.toLowerCase().split("-")) {
          if (part) result.push([part, part.length]);
        }
        buf = "";
      }
      const syl = textToSyllables(ch);
      if (syl.length) result.push([syl[0], 1]);
      else result.push(["", 1]); // 佔位，維持對齊
    }
    if (buf) {
      for (const part of buf.toLowerCase().split("-")) {
        if (part) result.push([part, part.length]);
      }
    }
    return result;
  }

  private windowCharLen(segChars: string, start: number, end: number): number {
    const cs = this.charSyllables(segChars);
    return cs.slice(start, end).reduce((sum, [, n]) => sum + n, 0);
  }

  // ---- 比對 ----

  private findMatches(syls: string[]): Match[] {
    const matches: Match[] = [];
    const n = syls.length;
    for (const entry of this.vocab) {
      const elen = entry.syllables.length;
      if (elen === 0) continue;
      // 完整比對：視窗長度 elen-1 ～ elen+1（容許 STT 掉字/多字）
      for (const wlen of new Set([Math.max(1, elen - 1), elen, elen + 1])) {
        if (wlen > n) continue;
        for (let st = 0; st <= n - wlen; st++) {
          const window = syls.slice(st, st + wlen);
          if (window.includes("")) continue;
          const sim = sequenceSimilarity(window, entry.syllables);
          // 單音節詞彙容易誤觸，要求更高相似度
          const minScore = elen === 1 ? 0.85 : 0.60;
          if (sim >= minScore) {
            matches.push({ start: st, end: st + wlen, score: sim, entry, isPrefix: false });
          }
        }
      }
      // 縮寫字首比對：只對品項「正式名稱」做（「奶」→「奶茶」），
      // 同義詞不做字首展開，避免亂句誤收
      if (entry.kind === "item" && elen >= 2 && entry.matchedSurface === entry.surface) {
        for (let plen = 1; plen < elen; plen++) {
          if (plen > n) break;
          const prefix = entry.syllables.slice(0, plen);
          for (let st = 0; st <= n - plen; st++) {
            const window = syls.slice(st, st + plen);
            if (window.includes("")) continue;
            const sims = window.map((a, k) => 1.0 - syllableDistance(a, prefix[k]));
            const mean = sims.reduce((s, v) => s + v, 0) / sims.length;
            if (mean >= 0.85) {
              // 字首縮寫給固定折扣，避免壓過完整比對
              matches.push({ start: st, end: st + plen, score: 0.75 * mean, entry, isPrefix: true });
            }
          }
        }
      }
    }
    return matches;
  }

  /** 加權區間排程：挑不重疊、總分最高的組合（分數乘視窗長度，偏好長比對）。 */
  private selectNonOverlapping(matchesIn: Match[]): Match[] {
    if (!matchesIn.length) return [];
    const matches = [...matchesIn].sort((a, b) => a.end - b.end || a.start - b.start);
    const n = matches.length;
    // 權重 = (分數 − 底線) × 長度：讓「短而準」贏過「長而勉強」的比對。
    // 每段再扣一點固定成本：完整比對與「同義詞拆兩段」打平時
    // （「四季春青茶」 vs 「四季春」＋「青茶」），偏好單一長比對。
    const weight = matches.map((m) => Math.max(m.score - 0.55, 0.01) * (m.end - m.start) - 0.02);
    const best: number[] = new Array(n + 1).fill(0.0);
    const take: boolean[] = new Array(n).fill(false);
    const prevIdx: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const m = matches[i];
      let p = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (matches[j].end <= m.start) { p = j + 1; break; }
      }
      prevIdx[i] = p;
      if (best[p] + weight[i] > best[i]) {
        best[i + 1] = best[p] + weight[i];
        take[i] = true;
      } else {
        best[i + 1] = best[i];
      }
    }
    const chosen: Match[] = [];
    let i = n;
    while (i > 0) {
      if (take[i - 1]) {
        chosen.push(matches[i - 1]);
        i = prevIdx[i - 1];
      } else {
        i -= 1;
      }
    }
    return chosen.sort((a, b) => a.start - b.start);
  }

  /** 單音節的字首縮寫比對需要「鄰接證據」才採信：
   * 旁邊要緊貼著該品項自己的選項（「中冰『奶』」的冰）或數量詞
   * （「兩杯『奶』」），否則視為亂句誤觸而丟棄。 */
  private filterPrefixMatches(chosen: Match[], quantities: Quantity[],
                              segChars: string, segOffset: number): Match[] {
    const result: Match[] = [];
    for (const m of chosen) {
      if (!(m.isPrefix && m.end - m.start === 1)) {
        result.push(m);
        continue;
      }
      const surfMap = this.choiceSurfaceByItem.get(m.entry.itemId) ?? new Map<string, [string, string]>();
      const hasAdjacentChoice = chosen.some(
        (c) => c.entry.kind === "choice" && (c.end === m.start || c.start === m.end)
          && surfMap.has(c.entry.matchedSurface),
      );
      const charStart = segOffset + this.sylsToCharOffset(segChars, m.start);
      const hasAdjacentQty = quantities.some(([pos]) => pos === charStart);
      if (hasAdjacentChoice || hasAdjacentQty) result.push(m);
    }
    return result;
  }

  /** 被選中的品項比對，若有「不同品項」在同視窗分數貼近 → 模糊，需澄清。 */
  private detectAmbiguity(allMatches: Match[], chosen: Match[]): [string, string] | null {
    for (const c of chosen) {
      if (c.entry.kind !== "item") continue;
      for (const m of allMatches) {
        if (m.entry.kind !== "item" || m.entry.itemId === c.entry.itemId) continue;
        const overlap = Math.min(c.end, m.end) - Math.max(c.start, m.start);
        if (overlap <= 0) continue;
        // 被選中比對「完整包含」且更長的情況（「珍珠奶茶」涵蓋「奶茶」）
        // 不構成歧義：更長、更特定的品項名勝出
        if (m.start >= c.start && m.end <= c.end && m.end - m.start < c.end - c.start) continue;
        if (Math.abs(m.score - c.score) < RERANK_AMBIGUITY_MARGIN && m.score >= 0.60) {
          return [c.entry.surface, m.entry.surface];
        }
      }
    }
    return null;
  }

  // ---- 組裝 ----

  private assemble(chosen: Match[], quantities: Quantity[],
                   segChars: string, segOffset: number): ParsedItem[] {
    const itemMatches = chosen.filter((m) => m.entry.kind === "item");
    if (!itemMatches.length) return [];
    const items: ParsedItem[] = [];
    for (const im of itemMatches) {
      const menuItem = this.itemsById.get(im.entry.itemId)!;
      const options: Record<string, string> = {};
      // 這個語段中的選項比對：同一個字面（如「加蛋」）可能被 DP 歸到
      // 別的品項名下，用字面對照表掛回實際在場的品項
      const surfMap = this.choiceSurfaceByItem.get(im.entry.itemId) ?? new Map<string, [string, string]>();
      for (const cm of chosen) {
        if (cm.entry.kind !== "choice") continue;
        const mapping = surfMap.get(cm.entry.matchedSurface);
        if (mapping) options[mapping[0]] = mapping[1];
      }
      const explicit = { ...options }; // 到這裡為止都是使用者明講的
      // 補上必填選項的預設值（靜默套用，覆誦不唸）
      for (const opt of menuItem.options ?? []) {
        if (opt.required && !(opt.id in options)) {
          options[opt.id] = opt.default ?? opt.choices[0].id;
        }
      }
      // 數量：只看「同語段內、品項之前」的數量標記。
      // 品項之後的數字（「鍋貼十顆」）若字面對得上該品項的選項，
      // 視為規格選項而不是數量。
      let qty = 1;
      const imGlobalStart = segOffset + this.sylsToCharOffset(segChars, im.start);
      const segEnd = segOffset + [...segChars].length;
      for (const [pos, num, raw] of quantities) {
        if (segOffset <= pos && pos <= imGlobalStart) {
          qty = num;
        } else if (imGlobalStart < pos && pos <= segEnd) {
          const mapping = surfMap.get(raw);
          if (mapping) {
            options[mapping[0]] = mapping[1];
            explicit[mapping[0]] = mapping[1];
          }
        }
      }
      items.push({
        item_id: menuItem.id, name: menuItem.name, qty, options,
        score: im.score, explicit_options: explicit,
      });
    }
    return items;
  }

  private sylsToCharOffset(segChars: string, sylIndex: number): number {
    const cs = this.charSyllables(segChars);
    return cs.slice(0, sylIndex).reduce((sum, [, n]) => sum + n, 0);
  }

  // ---- 顯示 ----

  /** 組出人話描述：「半糖去冰奶茶」——只唸使用者明講的選項。 */
  private describeItem(item: ParsedItem): string {
    const menuItem = this.itemsById.get(item.item_id)!;
    const parts: string[] = [];
    for (const opt of menuItem.options ?? []) {
      const cid = item.explicit_options[opt.id];
      if (!cid) continue;
      const choice = opt.choices.find((c) => c.id === cid);
      if (choice) parts.push(choice.name);
    }
    parts.push(menuItem.name);
    const label = parts.join("");
    return item.qty > 1 ? `${item.qty} 份 ${label}` : label;
  }
}
