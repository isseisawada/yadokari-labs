"""
GO の「一括発行」領収書PDF（1ページに複数の領収書が並ぶ）を、1件ずつの画像に切り分ける。
freee は1つの証憑を複数の明細に付けられないので、明細ごとに別ファイルが必要。

使い方（pdfplumber が入っている python で）:
  /usr/bin/python3 split_go_receipts.py inputs_202610/web_receipts/GO領収書_20261002_1843.pdf
→ 同じフォルダに GO領収書_YYYYMMDD_金額.png を作り、元のPDFは inputs_2026MM/originals/ へ移す
"""
import os
import re
import shutil
import sys
import unicodedata

import pdfplumber


def split(path: str) -> list[str]:
    out = []
    folder = os.path.dirname(path)
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            anchors = [w for w in page.extract_words() if w["text"].startswith("YADOKARI")]
            xs = sorted({round(a["x0"]) for a in anchors})
            for a in anchors:
                x0 = max(0, a["x0"] - 12)
                nxt = [x for x in xs if x > a["x0"] + 5]
                x1 = min(page.width, (nxt[0] - 8) if nxt else page.width)
                y0 = max(0, a["top"] - 12)
                y1 = min(page.height, y0 + 205)
                cell = page.crop((x0, y0, x1, y1))
                text = unicodedata.normalize("NFKC", cell.extract_text() or "")
                d = re.search(r"利用日:(\d{4})/(\d{2})/(\d{2})", text)
                amt = re.search(r"([\d,]+)\(内税", text)
                if not d or not amt:
                    continue
                base = f"GO領収書_{''.join(d.groups())}_{amt.group(1).replace(',', '')}"
                dst = os.path.join(folder, base + ".png")
                n = 2
                while os.path.exists(dst) or dst in out:
                    dst = os.path.join(folder, f"{base}_{n}.png"); n += 1
                cell.to_image(resolution=200).save(dst)
                out.append(dst)
    orig = os.path.join(os.path.dirname(folder), "originals")
    os.makedirs(orig, exist_ok=True)
    shutil.move(path, os.path.join(orig, os.path.basename(path)))
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        for f in split(p):
            print("作成:", f)
