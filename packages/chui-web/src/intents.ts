/** 口語意圖判讀（指令詞）：確認／取消／結束對話。
 *
 * 關鍵原則：指令詞永遠優先於菜單比對——封閉詞彙引擎只認識菜單，
 * 會把「結束對話」硬配成「地瓜薯條」（0.62 信心）之類；所以前端
 * 拿到 STT 原文必須先過這裡，才能決定要不要接受引擎的報價。 */

// 確認詞連同「STT 常見同音誤辨」一起收——短句（像「確認」兩個字）
// 的辨識錯誤率遠高於整句點餐，所以同音容錯要夠寬
export const YES_WORDS = [
  "確認", "確定", "確任", "雀認", "雀任", "缺人", "確人", "卻認", "全人",
  "沒錯", "下單", "下彈", "付款", "可以", "好的", "好啊", "好喔", "行",
  "對", "好", "是", "嗯", "恩", "ok", "OK", "Ok", "okay",
];
export const NO_WORDS = [
  "取消", "娶消", "去消", "曲消", "取笑", "驅消", "不要", "不用", "算了",
  "不對", "錯了", "重來", "重新", "不下單", "別下單",
];
export const EXIT_WORDS = [
  "結束對話", "結束", "結速", "傑束", "節束", "介束", "離開", "再見",
  "掰掰", "拜拜", "先這樣", "先醬", "不點了", "關閉", "關掉",
];

export function normalize(raw: string): string {
  return raw.replace(/[\s。，！？!?.,]/g, "");
}

/** 口頭確認判讀：明確肯定 / 明確否定 / 都不是（可能是新的點餐內容） */
export function confirmIntent(raw: string): "yes" | "no" | "other" {
  const text = normalize(raw);
  if (!text) return "other";
  if (NO_WORDS.some((w) => text.includes(w))) return "no";
  if (YES_WORDS.some((w) => text.includes(w))) return "yes";
  // 只要出現「確」字（確認/確定的任何殘片）就當肯定——否定詞已先擋掉
  if (text.includes("確")) return "yes";
  return "other";
}

/** 想離開的語意（「結束對話」等） */
export function exitIntent(raw: string): boolean {
  const text = normalize(raw);
  return text.length > 0 && EXIT_WORDS.some((w) => text.includes(w));
}
