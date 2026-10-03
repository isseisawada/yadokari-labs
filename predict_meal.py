"""
会議費・接待交際費の「参加者」と「社内/社外」を過去の申請実績から推定する。

データ: history/meal_history.json（build_meal_history.py が freee の承認済み申請から生成）
  [{"date": "2026-08-24", "vendor": "銀座ルノアール", "kind": "社内会議", "amt": 2010, "people": ["うえすぎせいた"]}, ...]
  kind = 社内会議 / 社外会議 / 接待≦1万 / 接待>1万

推定の考え方（空白にせず「これだと思うもの」を入れる。必ずドライランで確認する前提）:
  1. 同じ店に過去行っていれば → その店で直近に同席した人・社内/社外の多数派
  2. 初めての店なら金額で決める
     - ¥5,000 以下（会議費）: 社内扱い（実績 社内205 / 社外85）。直近半年でいちばん多く一緒に打ち合わせた社内メンバー1名
     - ¥5,000 超（接待交際費）: 直近の接待でよく同席した人を、金額から見た人数ぶん
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from collections import Counter
from datetime import date, timedelta
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(HERE, "history", "meal_history.json")

MEETING_LIMIT = 5000
RECENT_DAYS = 60
AVG_PER_PERSON = 4000   # 接待の一人あたり目安（人数推定用。実績中央値 ¥12,430 / 3〜4名）


def norm_vendor(v: str) -> str:
    v = unicodedata.normalize("NFKC", v or "")
    v = re.sub(r"(株式会社|有限会社|合同会社|\(株\)|\(有\)|本社)", "", v)
    return re.sub(r"[\s・･/／\-]", "", v).lower()


def load_history() -> list[dict]:
    if not os.path.exists(HISTORY_PATH):
        return []
    with open(HISTORY_PATH, encoding="utf-8") as f:
        return json.load(f)


def internal_roster(history: list[dict]) -> set[str]:
    """社内会議に2回以上出てくる人 = 社内メンバーとみなす"""
    c = Counter(p for h in history if h["kind"] == "社内会議" for p in h["people"])
    return {p for p, n in c.items() if n >= 2}


def _vendor_matches(vendor: str, history: list[dict]) -> list[dict]:
    """店名が一致する実績。完全一致 > 包含 > 類似 の順で、いちばん強い一致のグループだけ返す
    （「スタバ葉山店」が「スターバックスコーヒージャパン」に寄らないように）"""
    nv = norm_vendor(vendor)
    if len(nv) < 2:
        return []
    tiers: dict[int, list[dict]] = {3: [], 2: [], 1: []}
    for h in history:
        hv = norm_vendor(h.get("vendor", ""))
        if not hv:
            continue
        if nv == hv:
            tiers[3].append(h)
        elif nv in hv or hv in nv:
            tiers[2].append(h)
        elif SequenceMatcher(None, nv, hv).ratio() >= 0.8:
            tiers[1].append(h)
    for t in (3, 2, 1):
        if tiers[t]:
            return tiers[t]
    return []


def _recent(history: list[dict], ref: date) -> list[dict]:
    """ref の直近 RECENT_DAYS 日。足りなければ直近 40 件（古い時期の人が出ないように）"""
    cutoff = (ref - timedelta(days=RECENT_DAYS)).isoformat()
    r = [h for h in history if cutoff <= h["date"] <= ref.isoformat()]
    if len(r) < 10:
        r = sorted([h for h in history if h["date"] <= ref.isoformat()], key=lambda h: h["date"], reverse=True)[:40]
    return r


def predict(entry: dict, history: list[dict] | None = None) -> dict | None:
    """会議費/接待交際費のエントリに対し {participants, external, basis} を返す。対象外なら None"""
    if entry.get("kind") == "suica" or entry.get("account") not in ("会議費", "接待交際費"):
        return None
    history = history if history is not None else load_history()
    if not history:
        return None
    amount = int(entry.get("amount", 0))
    is_meeting = amount <= MEETING_LIMIT and entry.get("account") == "会議費"
    try:
        ref = date.fromisoformat(entry["date"])
    except Exception:
        ref = date.today()
    roster = internal_roster(history)

    # 1. 同じ店の実績
    same = [h for h in _vendor_matches(entry.get("vendor", ""), history) if h["people"]]
    if same:
        same.sort(key=lambda h: h["date"], reverse=True)
        kinds = Counter(h["kind"] for h in same)
        external = kinds["社外会議"] > kinds["社内会議"] if is_meeting else any(
            p not in roster for p in same[0]["people"])
        return {
            "participants": same[0]["people"],
            "external": bool(external),
            "basis": f"同じ店の実績{len(same)}件（直近 {same[0]['date']}・{same[0]['vendor']}）",
        }

    recent = _recent(history, ref)
    if is_meeting:
        # 2a. 初めての店・会議費 → 社内。直近半年でいちばん多く一緒に打ち合わせた社内メンバー
        c = Counter(p for h in recent if h["kind"] == "社内会議" for p in h["people"] if p in roster)
        if not c:
            return None
        top = c.most_common(1)[0][0]
        return {"participants": [top], "external": False,
                "basis": f"初めての店。会議費は社内が多い／直近の打ち合わせ相手で最多（{c[top]}回）"}

    # 2b. 初めての店・接待交際費 → 直近の接待でよく同席した人を金額相当の人数ぶん
    c = Counter(p for h in recent if h["kind"].startswith("接待") for p in h["people"])
    if not c:
        return None
    n = max(1, min(5, round(amount / AVG_PER_PERSON) - 1))
    people = [p for p, _ in c.most_common(n)]
    return {"participants": people, "external": any(p not in roster for p in people),
            "basis": f"初めての店。直近の接待でよく同席した人を {n} 名（金額から人数を推定）"}
