"""
Gmail から取得したメール（RAW 形式の JSON）から、添付の領収書 PDF を取り出して保存する。

Aルート（メールで届く領収書）用。Claude が Gmail コネクタで
get_message(messageFormat=RAW) を呼ぶと、結果が JSON ファイルとして保存されるので、
そのファイルを渡す。

使い方:
  python3 save_mail_receipts.py --month 10 <RAWのJSON> [<RAWのJSON> ...]

保存先: inputs_2026MM/web_receipts/
  - 同じ内容のファイル（SHA-256 が同じ）は保存しない（二重取り込み防止）
  - Stripe 系（Anthropic 等）は Invoice と Receipt の2つが付くので、Receipt だけ残す
  - 取り込んだメールは inputs_2026MM/mail_receipts.json に記録（message_id で重複を防ぐ）
"""
from __future__ import annotations

import argparse
import base64
import email
import email.header
import email.policy
import email.utils
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def decode_header(v: str | None) -> str:
    if not v:
        return ""
    return str(email.header.make_header(email.header.decode_header(v)))


def safe_name(name: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", name).strip()
    return name or "attachment.pdf"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", type=int, required=True)
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("raw_json", nargs="+")
    args = ap.parse_args()

    base = os.path.join(HERE, f"inputs_{args.year}{args.month:02d}")
    out_dir = os.path.join(base, "web_receipts")
    os.makedirs(out_dir, exist_ok=True)
    log_path = os.path.join(base, "mail_receipts.json")
    log = json.load(open(log_path, encoding="utf-8")) if os.path.exists(log_path) else []
    seen_ids = {r["message_id"] for r in log}

    existing_hashes = set()
    for fn in os.listdir(out_dir):
        p = os.path.join(out_dir, fn)
        if os.path.isfile(p):
            existing_hashes.add(hashlib.sha256(open(p, "rb").read()).hexdigest())

    for path in args.raw_json:
        d = json.load(open(path, encoding="utf-8"))
        mid = d.get("id", "")
        if mid in seen_ids:
            print(f"skip（取り込み済み）: {mid}")
            continue
        raw = d["raw"]
        msg = email.message_from_bytes(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)), policy=email.policy.default)
        subject = decode_header(msg.get("Subject"))
        sender = email.utils.parseaddr(msg.get("From", ""))[1]
        date = email.utils.parsedate_to_datetime(msg.get("Date")).date().isoformat() if msg.get("Date") else ""

        # 本文に埋め込まれた画像（ロゴ等、Content-ID 付き / inline）は領収書ではないので除く
        atts = [(p.get_filename(), p.get_payload(decode=True)) for p in msg.walk()
                if p.get_filename() and not (p.get_content_maintype() == "image"
                                             and (p["Content-ID"] or p.get_content_disposition() == "inline"))]
        atts = [(decode_header(fn), data) for fn, data in atts if data]
        # Stripe（Anthropic / OpenAI 等）は Invoice-*.pdf と Receipt-*.pdf の両方が付く → Receipt を優先
        if any(fn.lower().startswith("receipt") for fn, _ in atts):
            atts = [(fn, data) for fn, data in atts if not fn.lower().startswith("invoice")]

        saved = []
        for fn, data in atts:
            h = hashlib.sha256(data).hexdigest()
            if h in existing_hashes:
                print(f"skip（同じファイルあり）: {fn}")
                continue
            name = safe_name(fn)
            dst = os.path.join(out_dir, name)
            if os.path.exists(dst):
                stem, ext = os.path.splitext(name)
                dst = os.path.join(out_dir, f"{stem}_{mid[-6:]}{ext}")
            open(dst, "wb").write(data)
            existing_hashes.add(h)
            saved.append(os.path.relpath(dst, HERE))
            print(f"保存: {os.path.relpath(dst, HERE)}  ← {date} {sender}「{subject}」")

        log.append({"message_id": mid, "date": date, "from": sender, "subject": subject, "files": saved})
        seen_ids.add(mid)

    json.dump(log, open(log_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n記録: {os.path.relpath(log_path, HERE)}（{len(log)} 通）")


if __name__ == "__main__":
    main()
