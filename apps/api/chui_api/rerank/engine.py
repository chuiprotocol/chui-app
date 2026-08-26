"""封閉詞彙重排序引擎。

流程：
1. 把 STT 候選文字轉成音節序列（保留與原字對齊）。
2. 以滑動視窗對菜單詞彙（品項／選項／同義詞）做語音距離比對，
   支援「縮寫字首」比對（「奶」→「奶茶」、「中冰奶」→ 中杯＋冰＋奶茶）。
3. 動態規劃挑出不重疊、總分最高的比對組合。
4. 依語段（還有／跟／逗號 切分）把選項與數量掛到品項上。
5. 計算信心度；不足門檻或前二名太接近 → 回澄清問題，絕不猜。
"""

from dataclasses import dataclass, field

from .. import config
from .phonetics import sequence_similarity, syllable_distance, text_to_syllables

# 開頭的客套/贅詞，比對前先剝掉（只剝開頭，避免誤傷品項）
_LEADING_FILLERS = ["老闆", "你好", "妳好", "請給我", "給我", "幫我", "麻煩", "我要", "我想要", "請", "來"]
# 語段分隔詞：一段一個品項，選項掛在同段品項上
_SEPARATORS = ["還有", "然後", "跟", "和", "另外", "以及"]
# 不列入覆蓋率分母的贅音（語助詞、量詞尾音等）
_IGNORABLE_CHARS = set("的喔哦啊嗯欸誒了嘛呢吧要點份個杯顆塊謝")

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
_MEASURE_WORDS = set("杯個份顆塊條片碗")


def _parse_cn_number(chars: str) -> int | None:
    """中文數字（一～九十九）或阿拉伯數字 → 整數。"""
    if chars.isdigit():
        return int(chars)
    if not chars:
        return None
    if "十" in chars:
        left, _, right = chars.partition("十")
        tens = _CN_DIGITS.get(left, 1) if left else 1
        ones = _CN_DIGITS.get(right, 0) if right else 0
        if (left and left not in _CN_DIGITS) or (right and right not in _CN_DIGITS):
            return None
        return tens * 10 + ones
    val = 0
    for c in chars:
        if c not in _CN_DIGITS:
            return None
        val = val * 10 + _CN_DIGITS[c]
    return val


@dataclass
class VocabEntry:
    kind: str          # "item" | "choice"
    item_id: str       # choice 也記所屬 item
    option_id: str     # 僅 choice
    choice_id: str     # 僅 choice
    surface: str       # 顯示用文字（正式名稱）
    matched_surface: str  # 實際比中的字面（可能是同義詞）
    syllables: list[str] = field(default_factory=list)


@dataclass
class Match:
    start: int
    end: int
    score: float
    entry: VocabEntry
    is_prefix: bool = False  # 縮寫字首比對（「奶」→「奶茶」），需鄰接證據才採信


@dataclass
class ParsedItem:
    item_id: str
    name: str
    qty: int
    options: dict[str, str]        # option_id -> choice_id
    score: float


@dataclass
class ParseResult:
    ok: bool
    items: list[ParsedItem]
    confidence: float
    clarification_question: str | None = None
    clarification_candidates: list[str] | None = None
    source_text: str = ""


class RerankEngine:
    def __init__(self, menu: dict):
        self.menu = menu
        self.items_by_id = {it["id"]: it for it in menu["items"]}
        self.vocab: list[VocabEntry] = []
        for it in menu["items"]:
            for surf in [it["name"], *it.get("synonyms", [])]:
                self.vocab.append(VocabEntry(
                    kind="item", item_id=it["id"], option_id="", choice_id="",
                    surface=it["name"], matched_surface=surf,
                    syllables=text_to_syllables(surf),
                ))
            for opt in it.get("options", []):
                for ch in opt["choices"]:
                    for surf in [ch["name"], *ch.get("synonyms", [])]:
                        self.vocab.append(VocabEntry(
                            kind="choice", item_id=it["id"], option_id=opt["id"],
                            choice_id=ch["id"], surface=ch["name"], matched_surface=surf,
                            syllables=text_to_syllables(surf),
                        ))
        # 每個品項的「選項字面 → (option_id, choice_id)」對照表。
        # 同一個字面（如「加蛋」）可能屬於多個品項，DP 只會留一個歸屬，
        # 組裝時用這張表把選項掛回「實際出現在語段裡」的品項。
        self.choice_surface_by_item: dict[str, dict[str, tuple[str, str]]] = {}
        for e in self.vocab:
            if e.kind == "choice":
                self.choice_surface_by_item.setdefault(e.item_id, {})[e.matched_surface] = (
                    e.option_id, e.choice_id,
                )

    # ---- 主入口 ----

    def parse(self, stt_candidates: list[str]) -> ParseResult:
        """對每個 STT 候選各跑一次，回傳信心度最高者。"""
        best: ParseResult | None = None
        for text in stt_candidates:
            if not text or not text.strip():
                continue
            result = self._parse_one(text.strip())
            if best is None or result.confidence > best.confidence:
                best = result
        if best is None:
            return ParseResult(
                ok=False, items=[], confidence=0.0,
                clarification_question="不好意思，我沒有聽清楚，請再說一次您要點什麼。",
            )
        return best

    # ---- 單一候選解析 ----

    def _parse_one(self, text: str) -> ParseResult:
        text = self._strip_leading_fillers(text)
        chars, quantities = self._extract_quantities(text)
        segments = self._segment(chars)

        all_items: list[ParsedItem] = []
        ambiguity: tuple[str, str] | None = None
        covered = 0
        denom = 0

        for seg_chars, seg_offset in segments:
            syls = [s for s, _ in (self._char_syllables(seg_chars))]
            if not syls:
                continue
            matches = self._find_matches(syls)
            chosen = self._select_non_overlapping(matches)
            chosen = self._filter_prefix_matches(chosen, quantities, seg_chars, seg_offset)
            amb = self._detect_ambiguity(matches, chosen)
            if amb and ambiguity is None:
                ambiguity = amb
            seg_items = self._assemble(chosen, quantities, seg_chars, seg_offset)
            all_items.extend(seg_items)
            denom += sum(1 for c in seg_chars if c not in _IGNORABLE_CHARS)
            covered += sum(
                self._window_char_len(seg_chars, m.start, m.end) for m in chosen
            )

        if not all_items:
            return ParseResult(
                ok=False, items=[], confidence=0.0, source_text=text,
                clarification_question="不好意思，我沒有對到菜單上的品項，請再說一次您要點什麼。",
            )

        coverage = min(1.0, covered / denom) if denom else 0.0
        mean_score = sum(i.score for i in all_items) / len(all_items)
        confidence = mean_score * (0.6 + 0.4 * coverage)

        if ambiguity is not None:
            a, b = ambiguity
            return ParseResult(
                ok=False, items=all_items, confidence=confidence, source_text=text,
                clarification_question=f"請問您是要「{a}」還是「{b}」呢？",
                clarification_candidates=[a, b],
            )

        if confidence < config.RERANK_CONFIDENCE_THRESHOLD:
            guess = "、".join(self._describe_item(i) for i in all_items)
            return ParseResult(
                ok=False, items=all_items, confidence=confidence, source_text=text,
                clarification_question=f"我不太確定有沒有聽對：您是要點「{guess}」嗎？請回答「對」或再說一次。",
                clarification_candidates=[guess],
            )

        return ParseResult(ok=True, items=all_items, confidence=confidence, source_text=text)

    # ---- 前處理 ----

    def _strip_leading_fillers(self, text: str) -> str:
        # 去掉常見標點
        for p in "，。！？、,.!? 　":
            pass  # 標點在 _segment 處理，這裡只剝開頭贅詞
        changed = True
        while changed:
            changed = False
            for f in _LEADING_FILLERS:
                if text.startswith(f):
                    text = text[len(f):]
                    changed = True
        return text

    def _extract_quantities(self, text: str) -> tuple[str, list[tuple[int, int, str]]]:
        """抽出「兩杯」「3個」等數量詞。

        回傳（移除數量詞後的字串, [(位置, 數量, 原始字面)]）。
        位置是移除後字串中的索引。原始字面保留下來，因為「十顆」在
        「鍋貼十顆」裡其實是規格選項而不是數量，組裝時要能還原判斷。
        """
        out: list[str] = []
        quantities: list[tuple[int, int, str]] = []
        i = 0
        while i < len(text):
            j = i
            while j < len(text) and (text[j] in _CN_DIGITS or text[j] == "十" or text[j].isdigit()):
                j += 1
            if j > i:
                num = _parse_cn_number(text[i:j])
                if num is not None and num > 0:
                    if j < len(text) and text[j] in _MEASURE_WORDS:
                        j += 1  # 連量詞一起吃掉
                    quantities.append((len(out), num, text[i:j]))
                    i = j
                    continue
            out.append(text[i])
            i += 1
        return "".join(out), quantities

    def _segment(self, chars: str) -> list[tuple[str, int]]:
        """依分隔詞與標點切語段。回傳 [(語段字串, 在全文中的起始位移)]。"""
        boundaries = [0]
        i = 0
        cuts: list[tuple[int, int]] = []  # (start, end) 要移除的分隔片段
        while i < len(chars):
            if chars[i] in "，。！？、,.!?;；":
                cuts.append((i, i + 1))
                i += 1
                continue
            hit = next((s for s in _SEPARATORS if chars.startswith(s, i)), None)
            if hit:
                # 單字分隔詞（跟／和）可能是詞彙的一部分（「培『跟』蛋餅」是
                # 培根的誤辨字），只有兩側都至少 2 個字才視為分隔
                prev_cut_end = cuts[-1][1] if cuts else 0
                left_len = i - prev_cut_end
                right_len = len(chars) - (i + len(hit))
                if len(hit) == 1 and (left_len < 2 or right_len < 2):
                    i += 1
                    continue
                cuts.append((i, i + len(hit)))
                i += len(hit)
            else:
                i += 1
        segments: list[tuple[str, int]] = []
        prev = 0
        for s, e in [*cuts, (len(chars), len(chars))]:
            if s > prev:
                segments.append((chars[prev:s], prev))
            prev = e
        del boundaries
        return [seg for seg in segments if seg[0].strip()]

    def _char_syllables(self, chars: str) -> list[tuple[str, int]]:
        """回傳 [(音節, 對應原始字元數)]。ASCII 段算一個音節但佔多個字元。"""
        result: list[tuple[str, int]] = []
        buf = ""
        for ch in chars:
            if ch.isascii() and (ch.isalnum() or ch == "-"):
                buf += ch
                continue
            if buf:
                for part in buf.lower().split("-"):
                    if part:
                        result.append((part, len(part)))
                buf = ""
            syl = text_to_syllables(ch)
            if syl:
                result.append((syl[0], 1))
            else:
                result.append(("", 1))  # 佔位，維持對齊
        if buf:
            for part in buf.lower().split("-"):
                if part:
                    result.append((part, len(part)))
        return result

    def _window_char_len(self, seg_chars: str, start: int, end: int) -> int:
        cs = self._char_syllables(seg_chars)
        return sum(n for _, n in cs[start:end])

    # ---- 比對 ----

    def _find_matches(self, syls: list[str]) -> list[Match]:
        matches: list[Match] = []
        n = len(syls)
        for entry in self.vocab:
            elen = len(entry.syllables)
            if elen == 0:
                continue
            # 完整比對：視窗長度 elen-1 ～ elen+1（容許 STT 掉字/多字）
            for wlen in {max(1, elen - 1), elen, elen + 1}:
                if wlen > n:
                    continue
                for st in range(0, n - wlen + 1):
                    window = syls[st:st + wlen]
                    if "" in window:
                        continue
                    sim = sequence_similarity(window, entry.syllables)
                    # 單音節詞彙容易誤觸，要求更高相似度
                    min_score = 0.85 if elen == 1 else 0.60
                    if sim >= min_score:
                        matches.append(Match(st, st + wlen, sim, entry))
            # 縮寫字首比對：只對品項「正式名稱」做（「奶」→「奶茶」），
            # 同義詞不做字首展開，避免亂句誤收
            if entry.kind == "item" and elen >= 2 and entry.matched_surface == entry.surface:
                for plen in range(1, elen):
                    if plen > n:
                        break
                    prefix = entry.syllables[:plen]
                    for st in range(0, n - plen + 1):
                        window = syls[st:st + plen]
                        if "" in window:
                            continue
                        sims = [1.0 - syllable_distance(a, b) for a, b in zip(window, prefix)]
                        mean = sum(sims) / len(sims)
                        if mean >= 0.85:
                            # 字首縮寫給固定折扣，避免壓過完整比對
                            matches.append(Match(st, st + plen, 0.75 * mean, entry, is_prefix=True))
        return matches

    def _select_non_overlapping(self, matches: list[Match]) -> list[Match]:
        """加權區間排程：挑不重疊、總分最高的組合（分數乘視窗長度，偏好長比對）。"""
        if not matches:
            return []
        matches = sorted(matches, key=lambda m: (m.end, m.start))
        n = len(matches)
        # 權重 = (分數 − 底線) × 長度：讓「短而準」贏過「長而勉強」的比對
        weight = [max(m.score - 0.55, 0.01) * (m.end - m.start) for m in matches]
        best: list[float] = [0.0] * (n + 1)
        take: list[bool] = [False] * n
        prev_idx: list[int] = [0] * n
        for i, m in enumerate(matches):
            # 找到最後一個不與 m 重疊的比對
            p = 0
            for j in range(i - 1, -1, -1):
                if matches[j].end <= m.start:
                    p = j + 1
                    break
            prev_idx[i] = p
            if best[p] + weight[i] > best[i]:
                best[i + 1] = best[p] + weight[i]
                take[i] = True
            else:
                best[i + 1] = best[i]
        chosen: list[Match] = []
        i = n
        while i > 0:
            if take[i - 1]:
                chosen.append(matches[i - 1])
                i = prev_idx[i - 1]
            else:
                i -= 1
        return sorted(chosen, key=lambda m: m.start)

    def _filter_prefix_matches(self, chosen: list[Match], quantities: list[tuple[int, int, str]],
                               seg_chars: str, seg_offset: int) -> list[Match]:
        """單音節的字首縮寫比對需要「鄰接證據」才採信：

        旁邊要緊貼著該品項自己的選項（「中冰『奶』」的冰）或數量詞
        （「兩杯『奶』」），否則視為亂句誤觸而丟棄。兩音節以上的字首
        （「卡拉雞」）辨識度已足夠，不需額外證據。
        """
        result: list[Match] = []
        for m in chosen:
            if not (m.is_prefix and (m.end - m.start) == 1):
                result.append(m)
                continue
            surf_map = self.choice_surface_by_item.get(m.entry.item_id, {})
            has_adjacent_choice = any(
                c.entry.kind == "choice" and (c.end == m.start or c.start == m.end)
                and c.entry.matched_surface in surf_map
                for c in chosen
            )
            char_start = seg_offset + self._syls_to_char_offset(seg_chars, m.start)
            has_adjacent_qty = any(pos == char_start for pos, _, _ in quantities)
            if has_adjacent_choice or has_adjacent_qty:
                result.append(m)
        return result

    def _detect_ambiguity(self, all_matches: list[Match], chosen: list[Match]) -> tuple[str, str] | None:
        """被選中的品項比對，若有「不同品項」在同視窗分數貼近 → 模糊，需澄清。"""
        for c in chosen:
            if c.entry.kind != "item":
                continue
            for m in all_matches:
                if m.entry.kind != "item" or m.entry.item_id == c.entry.item_id:
                    continue
                overlap = min(c.end, m.end) - max(c.start, m.start)
                if overlap <= 0:
                    continue
                if abs(m.score - c.score) < config.RERANK_AMBIGUITY_MARGIN and m.score >= 0.60:
                    return (c.entry.surface, m.entry.surface)
        return None

    # ---- 組裝 ----

    def _assemble(self, chosen: list[Match], quantities: list[tuple[int, int, str]],
                  seg_chars: str, seg_offset: int) -> list[ParsedItem]:
        item_matches = [m for m in chosen if m.entry.kind == "item"]
        if not item_matches:
            return []
        items: list[ParsedItem] = []
        for im in item_matches:
            menu_item = self.items_by_id[im.entry.item_id]
            options: dict[str, str] = {}
            # 這個語段中的選項比對：同一個字面（如「加蛋」）可能被 DP 歸到
            # 別的品項名下，用字面對照表掛回實際在場的品項
            surf_map = self.choice_surface_by_item.get(im.entry.item_id, {})
            for cm in chosen:
                if cm.entry.kind != "choice":
                    continue
                mapping = surf_map.get(cm.entry.matched_surface)
                if mapping:
                    options[mapping[0]] = mapping[1]
            # 補上必填選項的預設值
            for opt in menu_item.get("options", []):
                if opt.get("required") and opt["id"] not in options:
                    options[opt["id"]] = opt.get("default", opt["choices"][0]["id"])
            # 數量：只看「同語段內、品項之前」的數量標記。
            # 品項之後的數字（「鍋貼十顆」）若字面對得上該品項的選項，
            # 視為規格選項而不是數量。
            qty = 1
            im_global_start = seg_offset + self._syls_to_char_offset(seg_chars, im.start)
            seg_end = seg_offset + len(seg_chars)
            for pos, num, raw in quantities:
                if seg_offset <= pos <= im_global_start:
                    qty = num
                elif im_global_start < pos <= seg_end:
                    mapping = surf_map.get(raw)
                    if mapping:
                        options[mapping[0]] = mapping[1]
            items.append(ParsedItem(
                item_id=menu_item["id"], name=menu_item["name"],
                qty=qty, options=options, score=im.score,
            ))
        return items

    def _syls_to_char_offset(self, seg_chars: str, syl_index: int) -> int:
        cs = self._char_syllables(seg_chars)
        return sum(n for _, n in cs[:syl_index])

    # ---- 顯示 ----

    def _describe_item(self, item: ParsedItem) -> str:
        """組出人話描述：「中杯 冰 奶茶」。"""
        menu_item = self.items_by_id[item.item_id]
        parts: list[str] = []
        for opt in menu_item.get("options", []):
            cid = item.options.get(opt["id"])
            if not cid:
                continue
            choice = next((c for c in opt["choices"] if c["id"] == cid), None)
            # 非必填且是預設值就不唸出來，覆誦才不會又臭又長
            if choice and (opt.get("required") or cid != opt.get("default")):
                parts.append(choice["name"])
        parts.append(menu_item["name"])
        label = "".join(parts)
        return f"{item.qty} 份 {label}" if item.qty > 1 else label
