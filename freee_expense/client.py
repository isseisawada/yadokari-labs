"""
freee API クライアント

経費申請の作成・勘定科目取得・領収書添付などを行う。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import requests
from dotenv import load_dotenv

from .auth import load_token, run_auth_flow

load_dotenv()

BASE_URL = "https://api.freee.co.jp"


@dataclass
class ExpenseLine:
    """経費申請の明細 1 件"""
    amount: int                          # 金額（円）
    description: str                     # 内容・目的
    expense_date: date                   # 経費発生日
    account_item_id: int | None = None   # 勘定科目 ID（新形式ではテンプレート既定の上書き）
    line_template_id: int | None = None  # 明細テンプレート ID（新API形式）
    receipt_ids: list[int] = field(default_factory=list)      # 添付領収書 ID（先頭のみ使用）
    sub_receipt_ids: list[int] = field(default_factory=list)  # 補足資料 ID（Suica一覧など）


@dataclass
class ExpenseApplication:
    """経費申請"""
    title: str
    lines: list[ExpenseLine]
    description: str = ""
    approval_flow_route_id: int | None = None


class FreeeClient:
    def __init__(self):
        token = load_token()
        if not token:
            print("freee 認証が必要です。")
            token = run_auth_flow()
        self._access_token = token["access_token"]
        self._company_id: int | None = None

    # ------------------------------------------------------------------ #
    # 内部ユーティリティ
    # ------------------------------------------------------------------ #

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }

    def _get(self, path: str, params: dict | None = None) -> Any:
        resp = requests.get(
            BASE_URL + path,
            headers=self._headers(),
            params=params or {},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, body: dict) -> Any:
        resp = requests.post(
            BASE_URL + path,
            headers=self._headers(),
            json=body,
            timeout=30,
        )
        if not resp.ok:
            print(f"[API エラー] {resp.status_code} {path}")
            print(resp.text[:600])
        resp.raise_for_status()
        return resp.json()

    def _post_multipart(self, path: str, files: dict, data: dict | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self._access_token}"}
        resp = requests.post(
            BASE_URL + path,
            headers=headers,
            files=files,
            data=data or {},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # 会社情報
    # ------------------------------------------------------------------ #

    def get_company_id(self) -> int:
        if self._company_id is not None:
            return self._company_id

        env_id = os.getenv("FREEE_COMPANY_ID")
        if env_id:
            self._company_id = int(env_id)
            return self._company_id

        data = self._get("/api/1/companies")
        companies = data.get("companies", [])
        if not companies:
            raise RuntimeError("freee に所属している事業所が見つかりません。")
        if len(companies) == 1:
            self._company_id = companies[0]["id"]
        else:
            print("事業所を選択してください:")
            for i, c in enumerate(companies):
                print(f"  {i + 1}. {c['display_name']} (ID: {c['id']})")
            idx = int(input("番号: ")) - 1
            self._company_id = companies[idx]["id"]

        return self._company_id

    # ------------------------------------------------------------------ #
    # 勘定科目
    # ------------------------------------------------------------------ #

    def get_account_items(self) -> list[dict]:
        """勘定科目一覧を取得する"""
        company_id = self.get_company_id()
        data = self._get("/api/1/account_items", {"company_id": company_id})
        return data.get("account_items", [])

    def find_account_item(self, name: str) -> dict | None:
        """名前で勘定科目を検索する（部分一致）"""
        for item in self.get_account_items():
            if name in item["name"]:
                return item
        return None

    def get_expense_account_items(self) -> list[dict]:
        """経費に使う勘定科目（費用系）だけを返す"""
        return [
            a for a in self.get_account_items()
            if a.get("account_category") == "expense"
        ]

    # ------------------------------------------------------------------ #
    # 領収書アップロード
    # ------------------------------------------------------------------ #

    def upload_receipt(self, file_path: str) -> int:
        """領収書画像を freee にアップロードし、receipt_id を返す"""
        company_id = self.get_company_id()
        with open(file_path, "rb") as f:
            ext = os.path.splitext(file_path)[1].lower()
            mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png" if ext == ".png" else "application/pdf"
            result = self._post_multipart(
                "/api/1/receipts",
                files={"receipt": (os.path.basename(file_path), f, mime)},
                data={"company_id": str(company_id)},
            )
        receipt_id = result["receipt"]["id"]
        print(f"  領収書アップロード完了: ID={receipt_id}")
        return receipt_id

    # ------------------------------------------------------------------ #
    # 経費申請
    # ------------------------------------------------------------------ #

    def create_expense_application(self, application: ExpenseApplication) -> dict:
        """経費申請を作成して申請データを返す"""
        company_id = self.get_company_id()

        lines = []
        for line in application.lines:
            if line.line_template_id:
                # 新形式: ネスト構造 + line_template_id
                eal: dict = {
                    "description": line.description,
                    "amount": line.amount,
                    "expense_application_line_template_id": line.line_template_id,
                }
                # テンプレート既定の勘定科目を上書きしたい場合
                if line.account_item_id:
                    eal["account_item_id"] = line.account_item_id
                purchase_line: dict = {
                    "transaction_date": line.expense_date.isoformat(),
                    "expense_application_lines": [eal],
                }
                if line.receipt_ids:
                    purchase_line["receipt_id"] = line.receipt_ids[0]
                if line.sub_receipt_ids:
                    purchase_line["sub_receipt_ids"] = list(line.sub_receipt_ids)
                lines.append(purchase_line)
            else:
                # 旧形式（互換性用）
                entry: dict = {
                    "amount": line.amount,
                    "description": line.description,
                    "transaction_date": line.expense_date.isoformat(),
                }
                if line.account_item_id:
                    entry["account_item_id"] = line.account_item_id
                if line.receipt_ids:
                    entry["receipt_ids"] = line.receipt_ids
                lines.append(entry)

        body = {
            "company_id": company_id,
            "title": application.title,
            "description": application.description,
            "purchase_lines": lines,
        }

        # 承認経路 ID（コーポレートが API 用に発行）
        if application.approval_flow_route_id:
            body["approval_flow_route_id"] = application.approval_flow_route_id
            print(f"  承認経路 ID: {application.approval_flow_route_id}")

        # 部門(section) は付けない（承認経路 1469199 で決まる。以前は sections[0]=「BETTARA（使わない）」を付けていた）

        result = self._post("/api/1/expense_applications", body)
        app = result["expense_application"]
        print(f"経費申請を作成しました: ID={app['id']}  タイトル={app['title']}")
        return app

    def list_expense_applications(self, status: str = "draft") -> list[dict]:
        """経費申請一覧を取得する（status: draft / in_progress / approved / rejected）"""
        company_id = self.get_company_id()
        data = self._get(
            "/api/1/expense_applications",
            {"company_id": company_id, "status": status},
        )
        return data.get("expense_applications", [])
