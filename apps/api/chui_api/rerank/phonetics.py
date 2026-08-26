"""華語語音距離。

把文字轉成逐字拼音序列，再以「聲母／韻母混淆表」計算音節距離。
混淆表收錄台灣華語常見不分的音：ㄓㄗ、ㄔㄘ、ㄕㄙ、ㄋㄌ、ㄈㄏ、
前後鼻音（in/ing、en/eng、an/ang）等，這正是 STT 誤辨識的主要來源。
"""

from functools import lru_cache

from pypinyin import lazy_pinyin
from rapidfuzz.distance import Levenshtein

# 聲母表：長的要排前面才能正確切分（zh 要先於 z）
_INITIALS = [
    "zh", "ch", "sh",
    "b", "p", "m", "f", "d", "t", "n", "l",
    "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w",
]

# 可互相混淆的聲母組（台灣華語常見；同組距離視為很近）
_INITIAL_CONFUSION = [
    {"zh", "z"},
    {"ch", "c"},
    {"sh", "s"},
    {"n", "l"},
    {"f", "h"},
    {"r", "l"},
]

# 可互相混淆的韻母組（前後鼻音不分等）
_FINAL_CONFUSION = [
    {"in", "ing"},
    {"en", "eng"},
    {"an", "ang"},
    {"uan", "uang"},
    {"o", "uo"},
    {"e", "o"},
]


def _split_syllable(syl: str) -> tuple[str, str]:
    """把一個拼音音節切成（聲母, 韻母）。無聲母（如 an）時聲母為空字串。"""
    for ini in _INITIALS:
        if syl.startswith(ini) and len(syl) > len(ini):
            return ini, syl[len(ini):]
    return "", syl


def _in_same_group(a: str, b: str, groups: list[set[str]]) -> bool:
    return any(a in g and b in g for g in groups)


@lru_cache(maxsize=65536)
def syllable_distance(a: str, b: str) -> float:
    """兩個音節的距離，0.0（相同）～1.0（完全不同）。"""
    if a == b:
        return 0.0
    ia, fa = _split_syllable(a)
    ib, fb = _split_syllable(b)
    dist = 0.0
    if ia != ib:
        dist += 0.15 if _in_same_group(ia, ib, _INITIAL_CONFUSION) else 0.5
    if fa != fb:
        if _in_same_group(fa, fb, _FINAL_CONFUSION):
            dist += 0.15
        else:
            # 韻母不同組時退回字元編輯距離（捕捉 ai/an 這類部分相似）
            denom = max(len(fa), len(fb)) or 1
            dist += 0.5 * (Levenshtein.distance(fa, fb) / denom)
    return min(dist, 1.0)


def text_to_syllables(text: str) -> list[str]:
    """文字 → 逐字拼音序列。中文逐字轉拼音；ASCII 連續段（台語羅馬字等）
    以連字號切分後原樣保留。"""
    out: list[str] = []
    buf = ""  # 暫存 ASCII 連續段
    for ch in text:
        if ch.isascii():
            if ch.isalnum() or ch == "-":
                buf += ch
                continue
            ch_is_sep = True
        else:
            ch_is_sep = False
        if buf:
            out.extend(p for p in buf.lower().split("-") if p)
            buf = ""
        if not ch_is_sep:
            py = lazy_pinyin(ch)
            if py and py[0].strip():
                out.append(py[0].lower())
    if buf:
        out.extend(p for p in buf.lower().split("-") if p)
    return out


def sequence_similarity(a: list[str], b: list[str]) -> float:
    """兩個音節序列的相似度 0.0～1.0。以音節距離做加權編輯距離後正規化。"""
    if not a or not b:
        return 0.0
    n, m = len(a), len(b)
    # DP 加權編輯距離：插入/刪除成本 1，取代成本為音節距離
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0.0] * m
        for j in range(1, m + 1):
            cur[j] = min(
                prev[j] + 1.0,
                cur[j - 1] + 1.0,
                prev[j - 1] + syllable_distance(a[i - 1], b[j - 1]),
            )
        prev = cur
    return 1.0 - prev[m] / max(n, m)
