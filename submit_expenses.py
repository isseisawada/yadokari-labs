"""
月次 経費精算 一括登録スクリプト（freee API / 明細テンプレート形式）

使い方:
  python3 submit_expenses.py --month 8 --dry-run   # プレビュー（送信・アップロードなし）
  python3 submit_expenses.py --month 8             # freee に下書き登録

入力: inputs_2026MM/entries.json（merge_entries.py が生成）

申請の分け方（2026年8月分以降のルール）:
  - Suica（kind="suica"）は独立した申請にまとめる（30件ずつ）
  - 領収書系（それ以外）は別の申請にまとめる（30件ずつ）
  - タイトルは通しで「経費精算申請X/N」
  - Suica 一覧（inputs_2026MM/suica/ のファイル）は Suica 申請の1行目に補足資料として添付
  - 領収書申請の備考に「電車交通費は申請Xにまとめています。」を記載

entries.json の領収書エントリで使えるフィールド:
  participants: ["きたもと", "えんどう"]   参加者（澤田を除く）。内容欄の末尾に「・」区切りで付与
  people:       3                         参加人数（澤田含む）。省略時 len(participants)+1
  external:     true                      社外含む（¥5,000以下の会議費を「会議費（社外）」にする）
  shareholder:  "たにじりまこと"           株主同席時。内容欄末尾に「　株主XX親睦のため」を付与
  description:  任意                      省略時は「打ち合わせ（店名）」
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import date
from math import ceil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from dotenv import load_dotenv
load_dotenv(os.path.join(HERE, ".env"), override=True)

from freee_expense.client import FreeeClient, ExpenseLine, ExpenseApplication

# ------------------------------------------------------------------------- #
# 設定
# ------------------------------------------------------------------------- #
APPROVAL_FLOW_ROUTE_ID = 1469199   # 経費精算_API用（さわだ指定）
DEFAULT_BATCH_SIZE     = 30

# 明細テンプレート ID（freee 側で定義されているもの）
T_SUICA        = 289807  # 交通費（電車在来線・バス）
T_SHINKANSEN   = 300519  # 交通費（特急・新幹線）
T_TAXI         = 300520  # 交通費（タクシー）
T_FLIGHT       = 300521  # 交通費（飛行機・船舶）
T_TOLL         = 300523  # 高速・有料道路料金
T_GAS          = 300524  # ガソリン代
T_PARKING      = 300525  # 駐車場代
T_HOTEL        = 300527  # 宿泊費
T_MEETING_IN   = 300528  # 会議費（社内）
T_MEETING_EXT  = 300529  # 会議費（社外）
T_ENT_LOW      = 337299  # 接待交際費（一人税込10,000円以下）※300530 は【使わない】5,000円版
T_ENT_HIGH     = 337300  # 接待交際費（一人税込10,000円超）※300531 は【使わない】5,000円版
T_GIFT         = 300532  # 取引先への贈答・手土産代（税込3,000円以内）
T_RENTACAR     = 300522  # レンタカー料金
T_SUPPLY       = 300535  # 備品消耗品（事務用品等）※ 名前解決できないときのフォールバック用

# 勘定科目 ID（テンプレート既定を上書きしたい場合に使う）
A_MISC         = 134321784  # 雑費
# 名前で指定した勘定科目は実行時に /api/1/account_items から ID を解決する
KNOWN_ACCOUNT_IDS: dict[str, int] = {"雑費": A_MISC}

GIFT_LIMIT     = 3000    # 贈答・手土産テンプレートの上限（超えたら ⚠）
BOOK_KEYWORDS  = ["書店", "書籍", "ブックス", "BOOKS", "BOOK", "紀伊國屋", "有隣堂", "ジュンク堂", "丸善", "蔦屋",
                  "TSUTAYA", "文教堂", "くまざわ", "ttc lifestyle"]
GIFT_KEYWORDS  = ["ASORA", "エアポートサービス", "JAL PLAZA", "PLUSTA", "リテイリング", "手土産", "土産", "ギフト"]
COMM_KEYWORDS  = ["google cloud", "anthropic", "aws", "amazon web", "openai", "microsoft", "azure", "vercel",
                  "github", "ntt", "docomo", "softbank", "kddi", "通信"]
RENTACAR_KEYWORDS = ["レンタカー", "rent a car", "rentacar", "カーシェア", "times car", "ニッポンレンタカー", "オリックスレンタカー"]
FLIGHT_KEYWORDS = ["flight", "airline", "航空", "qunar", "peach", "jetstar", "skymark", "solaseed", "スカイマーク", "ジェットスター", "ソラシド"]
TOLL_KEYWORDS  = ["高速道路", "nexco", "etc", "有料道路", "首都高", "阪神高速"]
HOTEL_KEYWORDS = ["hotel", "ホテル", "宿泊", "旅館", " inn"]

MEETING_LIMIT      = 5000    # 飲食代がこれ以下なら会議費、超えたら接待交際費
PER_PERSON_LIMIT   = 10000   # 接待交際費の一人あたり閾値
# ------------------------------------------------------------------------- #


class Decision:
    """1エントリの判定結果。
    account_override: ID(int) または勘定科目名(str: 実行時解決)
    template_name:    指定時は実行時に freee のテンプレート一覧から名前で ID を解決し tid を差し替える
                      （見つからなければ tid + account_override のフォールバックを使う）"""
    def __init__(self, tid: int, label: str, account_override: int | str | None = None,
                 warn: str | None = None, template_name: str | None = None):
        self.tid = tid
        self.label = label
        self.account_override = account_override
        self.warn = warn
        self.template_name = template_name


def decide(entry: dict) -> Decision:
    kind    = entry.get("kind", "suica")
    vendor  = (entry.get("vendor") or "")
    vl      = vendor.lower()
    account = entry.get("account") or ""
    amount  = int(entry.get("amount", 0))
    fname   = os.path.basename(entry.get("receipt_path") or "").lower()

    if kind == "suica":
        return Decision(T_SUICA, "電車・バス")
    if kind == "taxi":
        return Decision(T_TAXI, "タクシー")

    # --- 取引先への贈答・手土産（空港・駅の土産物店など）: 空港系より先に判定 ---
    if "贈答" in account or "手土産" in account or any(k.lower() in vl for k in GIFT_KEYWORDS):
        warn = f"税込{GIFT_LIMIT:,}円超（贈答テンプレの上限を超過・要確認）" if amount > GIFT_LIMIT else None
        return Decision(T_GIFT, "贈答・手土産(3000円以内)", None, warn)

    # --- 通信費（クラウド・API・通信サービス）---
    if "通信費" in account or any(k in vl for k in COMM_KEYWORDS):
        return Decision(T_SUPPLY, "通信費", "通信費", template_name="通信費")

    # --- 新聞図書費（書店・書籍・電子書籍・情報サービス）---
    if "新聞図書費" in account or "図書" in account or any(k.lower() in vl for k in BOOK_KEYWORDS):
        return Decision(T_SUPPLY, "新聞図書費", "新聞図書費", template_name="新聞図書費")

    # --- 交通系（ベンダー名で判定） ---
    if "飛行機" in account or any(k in vl for k in FLIGHT_KEYWORDS):
        return Decision(T_FLIGHT, "飛行機・船舶")
    if "レンタカー" in account or any(k in vl for k in RENTACAR_KEYWORDS):
        return Decision(T_RENTACAR, "レンタカー料金")
    if "go株式会社" in vl or vl == "go" or vl.startswith("go ") or "タクシー" in account or "タクシー" in vendor:
        return Decision(T_TAXI, "タクシー")
    if "高速" in account or any(k in vl for k in TOLL_KEYWORDS):
        return Decision(T_TOLL, "高速・有料道路")
    if "東日本旅客" in vendor or "jr" in vl or "新幹線" in vendor or "特急" in account or "新幹線" in account:
        return Decision(T_SHINKANSEN, "特急・新幹線")
    if "石油" in vendor or "ガソリン" in vendor or "ガソリン" in account or vl.endswith("ss"):
        return Decision(T_GAS, "ガソリン代")
    if any(k in vendor for k in ["パーク", "駐車場", "パーキング", "アイペック", "ナビパーク"]) or "駐車" in account:
        return Decision(T_PARKING, "駐車場代")
    if "電車" in account or "バス" in account:
        return Decision(T_SUICA, "電車・バス")
    if "宿泊" in account or any(k in vl for k in HOTEL_KEYWORDS):
        return Decision(T_HOTEL, "宿泊費")

    # --- STATION WORK は オフィスブース利用 → 会議費（社内）固定 ---
    if "station work" in vl:
        return Decision(T_MEETING_IN, "会議費(社内)")

    # --- 消耗品（ドラッグストア・文具など） → 備品消耗品（事務用品等） ---
    if "消耗品" in account:
        return Decision(T_SUPPLY, "備品消耗品")

    # --- 会議費 / 接待交際費（飲食）---
    if account in ("会議費", "接待交際費"):
        participants = entry.get("participants") or []
        people = entry.get("people") or (len(participants) + 1 if participants else None)
        external = bool(entry.get("external"))

        if amount <= MEETING_LIMIT:
            tid = T_MEETING_EXT if external else T_MEETING_IN
            label = "会議費(社外)" if external else "会議費(社内)"
            if not participants:
                warn = "参加者未記入"
            elif "external" not in entry:
                warn = "社内/社外の指定なし（会議費（社内）で登録）"
            else:
                warn = None
            return Decision(tid, label, None, warn)

        # ¥5,000 超はすべて接待交際費。一人あたり金額で 10,000 以下/超 を分ける
        if people:
            per = amount / people
            if per > PER_PERSON_LIMIT:
                return Decision(T_ENT_HIGH, f"接待交際費(一人¥{per:,.0f}・10000超)", None,
                                None if participants else "参加者未記入")
            return Decision(T_ENT_LOW, f"接待交際費(一人¥{per:,.0f}・10000以下)", None,
                            None if participants else "参加者未記入")
        # 人数不明: 合計 ¥30,000 以上なら 10,000超 と仮置き（要確認）
        tid = T_ENT_HIGH if amount >= 30000 else T_ENT_LOW
        return Decision(tid, "接待交際費(人数不明・要確認)", None, "参加者/人数未記入 → 一人あたり判定不可")

    # --- サブスク・その他 → 雑費（テンプレートを名前で解決。無ければ消耗品テンプレ + 勘定科目上書き）---
    return Decision(T_SUPPLY, "雑費", "雑費", template_name="雑費")


def build_description(entry: dict, dec: Decision) -> str:
    kind = entry.get("kind", "suica")
    if kind == "suica":
        from_st = entry.get("from", "")
        to_st   = entry.get("to", "")
        route   = f"{from_st} → {to_st}" if to_st else from_st
        return f"打ち合わせ（{route}）"

    # 内容欄のハウススタイル（2026年8月分の実績に合わせる）:
    #   - 店名・ベンダー名は書かない。「何のためか」だけを書く
    #   - 参加者がいれば 全角スペース + 「、」区切りのフルネーム
    #   例: 「打ち合わせ　うえすぎせいた」「親睦のため　やましたまさき、くどうたろう」「駐車場利用」「消耗品」
    purpose_by_label = {
        "タクシー":            "タクシー利用",
        "駐車場代":            "駐車場利用",
        "高速・有料道路":      "高速道路利用",
        "ガソリン代":          "打ち合わせ",      # 移動目的として「打ち合わせ」と書く運用
        "備品消耗品":          "消耗品",
        "新聞図書費":          "知識獲得のため",
        "宿泊費":              entry.get("trip") or "出張",
        "レンタカー料金":      entry.get("trip") or "出張利用",
        "飛行機・船舶":        entry.get("trip") or "出張",
        "特急・新幹線":        entry.get("trip") or "出張",
        "贈答・手土産(3000円以内)": "親睦のため",
    }
    label = dec.label.split("(")[0] if dec.label.startswith("接待交際費") else dec.label
    # 優先順位: 人が指定した description（overrides.json）> ハウススタイル > OCR が読んだ説明
    desc = entry.get("description")
    if not desc:
        if label.startswith("接待交際費"):
            desc = "親睦のため"
        elif label.startswith("会議費"):
            desc = "打ち合わせ"
        elif label in ("通信費", "雑費"):
            # サブスク・クラウド系はサービス名を残したいので OCR の説明を使う
            desc = entry.get("ocr_description") or f"{vendor} 利用料"
        else:
            desc = purpose_by_label.get(dec.label) or purpose_by_label.get(label) or "打ち合わせ"

    # 参加者フルネームを付与（会議費・接待交際費・贈答）
    if label.startswith("会議費") or label.startswith("接待交際費") or dec.tid == T_GIFT:
        from predict_meal import clean_names
        participants = clean_names(entry.get("participants") or [], set())
        if participants and not any(p in desc for p in participants):
            desc = f"{desc}　{'、'.join(participants)}"
    if entry.get("shareholder"):
        tail = f"株主{entry['shareholder']}親睦のため"
        if tail not in desc:
            desc = f"{desc}　{tail}"
    return desc


def resolve_template_ids(client: FreeeClient | None, names: set[str]) -> dict[str, int]:
    """明細テンプレート名 → ID を freee から解決（dry-run 時は解決しない）"""
    if not names or client is None:
        return {}
    data = client._get("/api/1/expense_application_line_templates",
                       {"company_id": client.get_company_id(), "limit": 100})
    templates = data.get("expense_application_line_templates", [])
    print(f"  明細テンプレート {len(templates)} 件を取得")
    resolved: dict[str, int] = {}
    for n in names:
        exact = [t for t in templates if t["name"] == n]
        partial = [t for t in templates if n in t["name"]]
        hit = (exact or partial)[:1]
        if hit:
            resolved[n] = hit[0]["id"]
            print(f"  テンプレート「{n}」→ ID={hit[0]['id']} ({hit[0]['name']} / {hit[0].get('account_item_name','')})")
        else:
            print(f"  ⚠ テンプレート「{n}」が見つからないためフォールバック（消耗品テンプレ + 勘定科目上書き）")
    return resolved


def resolve_account_ids(client: FreeeClient | None, names: set[str]) -> dict[str, int]:
    """勘定科目名 → ID。既知のものは KNOWN_ACCOUNT_IDS、それ以外は API で解決（dry-run 時は解決しない）"""
    resolved = {n: KNOWN_ACCOUNT_IDS[n] for n in names if n in KNOWN_ACCOUNT_IDS}
    missing = [n for n in names if n not in resolved]
    if missing and client is not None:
        items = client.get_account_items()
        for n in missing:
            exact = [a for a in items if a["name"] == n]
            partial = [a for a in items if n in a["name"]]
            hit = (exact or partial)[:1]
            if hit:
                resolved[n] = hit[0]["id"]
                print(f"  勘定科目「{n}」→ ID={hit[0]['id']} ({hit[0]['name']})")
    return resolved


def to_line(entry: dict, dec: Decision, receipt_id: int | None, sub_receipt_ids: list[int] | None = None,
            account_ids: dict[str, int] | None = None) -> ExpenseLine:
    override = dec.account_override
    if isinstance(override, str):
        override = (account_ids or {}).get(override)
    return ExpenseLine(
        amount=int(entry["amount"]),
        description=build_description(entry, dec),
        expense_date=date.fromisoformat(entry["date"]),
        line_template_id=dec.tid,
        account_item_id=override,
        receipt_ids=[receipt_id] if receipt_id else [],
        sub_receipt_ids=sub_receipt_ids or [],
    )


def upload_files(client: FreeeClient, paths: list[str], what: str) -> dict[str, int]:
    """path → receipt_id（同一パスは1回だけ）"""
    cache: dict[str, int] = {}
    if not paths:
        return cache
    print(f"{what}アップロード中（{len(paths)} 件）...")
    for p in paths:
        full = p if os.path.isabs(p) else os.path.join(HERE, p)
        if not os.path.exists(full):
            print(f"  ⚠ ファイル未検出: {p}")
            continue
        try:
            cache[p] = client.upload_receipt(full)
        except Exception as e:
            print(f"  ⚠ アップロード失敗 {p}: {e}")
    print()
    return cache


def chunks(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", type=int, required=True, help="対象月（例: 8）")
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true", help="freee に送信・アップロードせずプレビューのみ")
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="領収書系の1申請あたり件数（既定 30）")
    ap.add_argument("--suica-batch-size", type=int, default=0, help="Suica の1申請あたり件数。0 = 分割せず1申請にまとめる（既定）")
    ap.add_argument("--no-suica-attach", action="store_true", help="Suica 一覧ファイルを補足資料として添付しない")
    args = ap.parse_args()

    base       = os.path.join(HERE, f"inputs_{args.year}{args.month:02d}")
    input_file = os.path.join(base, "entries.json")
    suica_dir  = os.path.join(base, "suica")

    if not os.path.exists(input_file):
        print(f"エラー: {input_file} がありません。先に merge_entries.py --month {args.month} を実行してください。")
        sys.exit(1)
    with open(input_file, encoding="utf-8") as f:
        entries: list[dict] = json.load(f)
    if not entries:
        print("明細が空です。")
        sys.exit(1)

    # overrides.json を直した後に merge を回し忘れると、古い entries.json のまま登録されてしまう
    ov_path = os.path.join(base, "overrides.json")
    if os.path.exists(ov_path) and os.path.getmtime(ov_path) > os.path.getmtime(input_file):
        print(f"エラー: overrides.json が entries.json より新しいです（修正が反映されていません）。")
        print(f"  先に実行してください: python3 merge_entries.py --month {args.month}")
        sys.exit(1)

    # 対象月外チェック
    prefix = f"{args.year}-{args.month:02d}-"
    outside = [e for e in entries if not str(e.get("date", "")).startswith(prefix)]

    suica_entries   = [e for e in entries if e.get("kind") == "suica"]
    receipt_entries = [e for e in entries if e.get("kind") != "suica"]
    suica_batches   = chunks(suica_entries, args.suica_batch_size) if args.suica_batch_size > 0 \
                      else ([suica_entries] if suica_entries else [])
    receipt_batches = chunks(receipt_entries, args.batch_size)
    total_batches   = len(suica_batches) + len(receipt_batches)

    # Suica 一覧ファイル（補足資料）
    suica_files: list[str] = []
    if not args.no_suica_attach and os.path.isdir(suica_dir):
        for e in ("png", "jpg", "jpeg", "pdf", "PNG", "JPG", "JPEG", "PDF"):
            suica_files += glob.glob(os.path.join(suica_dir, f"*.{e}"))
        suica_files = sorted(set(os.path.relpath(p, HERE) for p in suica_files))

    total = sum(int(e["amount"]) for e in entries)
    n_with_receipt = sum(1 for e in receipt_entries if e.get("receipt_path"))
    print(f"=== {args.year}年{args.month}月分 経費精算 ===")
    print(f"総件数: {len(entries)} 件 / ¥{total:,}   (Suica {len(suica_entries)} 件 / 領収書系 {len(receipt_entries)} 件)")
    print(f"領収書ファイルあり: {n_with_receipt} 件 / Suica一覧ファイル: {len(suica_files)} 件")
    print(f"申請数: {total_batches}（Suica {len(suica_batches)} + 領収書系 {len(receipt_batches)}）  バッチ {args.batch_size} 件")
    if outside:
        print(f"⚠ 対象月外の日付が {len(outside)} 件あります（entries.json を確認）")
    if args.dry_run:
        print("モード: ドライラン（freee には送信・アップロードしません）")
    print()

    # 判定を先に全件実施（警告収集）
    decisions: dict[int, Decision] = {id(e): decide(e) for e in entries}
    warnings: list[str] = []
    for e in entries:
        d = decisions[id(e)]
        if d.warn:
            warnings.append(f"{e['date']}  {e.get('vendor','')}  ¥{int(e['amount']):,}  → {d.warn}")
    for e in entries:
        if e.get("guessed") and int(e.get("amount", 0)) >= 20000:
            warnings.append(f"{e['date']}  {e.get('vendor','')}  ¥{int(e['amount']):,}  → 人数が推定のため"
                            f"「一人1万円以下/超」の判定を確認（実人数は overrides.json の people で指定）")
    for e in outside:
        warnings.append(f"{e['date']}  {e.get('vendor','')}  ¥{int(e['amount']):,}  "
                        f"→ 対象月外の日付（{args.year}年{args.month}月以外）。利用日に直すか overrides.json で上書きを")

    # 名前指定の勘定科目（新聞図書費など）を解決
    client: FreeeClient | None = None
    receipt_ids: dict[str, int] = {}
    suica_file_ids: list[int] = []
    if not args.dry_run:
        client = FreeeClient()
    # 名前指定のテンプレート（新聞図書費など）を解決して tid を差し替え
    template_ids = resolve_template_ids(client, {d.template_name for d in decisions.values() if d.template_name})
    for d in decisions.values():
        if d.template_name and d.template_name in template_ids:
            d.tid = template_ids[d.template_name]
            d.account_override = None   # テンプレート自身の勘定科目を使う
    if args.dry_run:
        pending = sorted({d.template_name for d in decisions.values() if d.template_name})
        if pending:
            print(f"  ※ テンプレートID（{', '.join(pending)}）は本番実行時に freee から解決します\n")
    named_accounts = {d.account_override for d in decisions.values() if isinstance(d.account_override, str)}
    account_ids = resolve_account_ids(client, named_accounts)
    unresolved = [n for n in named_accounts if n not in account_ids]
    if unresolved and not args.dry_run:
        print(f"エラー: 勘定科目 ID を解決できません: {unresolved}。freee の勘定科目名を確認してください。")
        sys.exit(1)

    # アップロード（実行モードのみ）
    if not args.dry_run:
        receipt_ids = upload_files(client, sorted({e["receipt_path"] for e in receipt_entries if e.get("receipt_path")}), "領収書")
        if suica_batches and suica_files:
            m = upload_files(client, suica_files, "Suica一覧（補足資料）")
            suica_file_ids = [m[p] for p in suica_files if p in m]

    # 申請の組み立て
    plan: list[tuple[str, str, list[dict], bool]] = []   # (title, description, batch, is_suica)
    n = 0
    suica_app_numbers: list[int] = []
    for b in suica_batches:
        n += 1
        suica_app_numbers.append(n)
        plan.append((f"経費精算申請{n}/{total_batches}",
                     f"{args.year}年{args.month}月分 電車交通費（Suica）{len(b)}件 合計¥{sum(int(e['amount']) for e in b):,}。"
                     f"Suica乗車一覧を申請行1の補足資料として添付。",
                     b, True))
    suica_ref = "・".join(str(x) for x in suica_app_numbers)
    for b in receipt_batches:
        n += 1
        note = f"電車交通費は申請{suica_ref}にまとめています。" if suica_app_numbers else ""
        plan.append((f"経費精算申請{n}/{total_batches}",
                     f"{args.year}年{args.month}月分 経費精算 {len(b)}件 合計¥{sum(int(e['amount']) for e in b):,}。{note}",
                     b, False))

    created: list[tuple[str, int]] = []
    for idx, (title, app_desc, batch, is_suica) in enumerate(plan):
        batch_total = sum(int(e["amount"]) for e in batch)
        print(f"--- {title}  {'[Suica]' if is_suica else '[領収書系]'}  ({len(batch)}件 / ¥{batch_total:,}) ---")
        lines: list[ExpenseLine] = []
        for i, e in enumerate(batch):
            d = decisions[id(e)]
            rid = receipt_ids.get(e.get("receipt_path", ""))
            subs = suica_file_ids if (is_suica and i == 0 and idx == 0) else None
            ln = to_line(e, d, rid, subs, account_ids)
            lines.append(ln)
            marks = ""
            if e.get("receipt_path"):
                marks += " 📎" if rid else " 📎(要UP)"
            if subs:
                marks += f" 📄補足資料x{len(subs)}"
            elif is_suica and i == 0 and idx == 0 and suica_files:
                marks += f" 📄補足資料x{len(suica_files)}(要UP)"
            if e.get("guessed"):
                marks += f"  🔮推定（{e.get('guess_basis','')}）"
            if d.warn:
                marks += f"  ⚠{d.warn}"
            print(f"  {ln.expense_date}  [{d.label}]  {ln.description}  ¥{ln.amount:,}{marks}")
        print(f"  備考: {app_desc}\n")

        if args.dry_run:
            continue
        app = ExpenseApplication(title=title, lines=lines, description=app_desc,
                                 approval_flow_route_id=APPROVAL_FLOW_ROUTE_ID)
        result = client.create_expense_application(app)
        created.append((title, result["id"]))
        print(f"  → 申請ID: {result['id']}\n")

    guessed = [e for e in entries if e.get("guessed")]
    if guessed:
        print("=" * 60)
        print(f"🔮 参加者・社内/社外を過去実績から推定した行 {len(guessed)} 件（違うものだけ overrides.json で直す）")
        for e in guessed:
            print(f"  {e['date']}  {e.get('vendor','')}  ¥{int(e['amount']):,}  → "
                  f"{'、'.join(e['participants'])}（{'社外' if e.get('external') else '社内'}）  …{e.get('guess_basis','')}")
    if warnings:
        print("=" * 60)
        print(f"⚠ 要確認 {len(warnings)} 件（entries.json の participants / people を埋めてください）")
        for w in warnings:
            print("  " + w)
        print("=" * 60)

    if created:
        print("\n=== 作成した申請 ===")
        for title, app_id in created:
            print(f"  {title}: https://secure.freee.co.jp/expense_applications_v2/{app_id}")
        print("\nfreee UI で内容を確認し、問題なければ各申請の「申請」ボタンを押してください。")


if __name__ == "__main__":
    main()
