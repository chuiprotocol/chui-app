"""ORM 模型。

金額欄位一律為整數最小單位（新台幣＝元），絕不使用浮點數。
訂單明細只以密文落地；伺服器不儲存加密金鑰。
"""

import time
import uuid

from sqlalchemy import Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def now_s() -> int:
    return int(time.time())


class Merchant(Base):
    __tablename__ = "merchants"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "mch_" + _uuid())
    name: Mapped[str] = mapped_column(String(200))
    # API key 只存 SHA-256 hash；明文只在註冊回應出現一次
    api_key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 店家收款的 Sui 地址
    payout_address: Mapped[str] = mapped_column(String(80), default="")
    # 菜單 JSON（品項、價格、選項、同義詞）；正規化後全文存這裡
    menu_json: Mapped[str] = mapped_column(Text, default="")
    menu_version: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class Consumer(Base):
    __tablename__ = "consumers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "csr_" + _uuid())
    # zkLogin 或一般 ed25519 錢包導出的 Sui 地址；一個地址一個帳號
    sui_address: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class Mandate(Base):
    """消費者授權（鏈上 shared object 的鏈下索引）。"""

    __tablename__ = "mandates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "mnd_" + _uuid())
    consumer_id: Mapped[str] = mapped_column(String(64), index=True)
    # 鏈上 Mandate 物件 ID；建立交易確認後回填
    onchain_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    # 單筆上限與總額上限（元，整數）
    per_tx_limit: Mapped[int] = mapped_column(Integer)
    total_limit: Mapped[int] = mapped_column(Integer, default=0)  # 0 = 未設total上限
    # active | revoked | pending（鏈上交易尚未確認）
    status: Mapped[str] = mapped_column(String(16), default="pending")
    create_tx_digest: Mapped[str] = mapped_column(String(80), default="")
    revoke_tx_digest: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "ord_" + _uuid())
    merchant_id: Mapped[str] = mapped_column(String(64), index=True)
    consumer_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    mandate_id: Mapped[str] = mapped_column(String(64), default="")
    # 明細密文（AES-256-GCM）；金鑰由消費者持有，伺服器不留存
    details_ciphertext: Mapped[str] = mapped_column(Text)
    details_nonce: Mapped[str] = mapped_column(String(24))
    # 上鏈 digest 與其 salt（hex）；salt 對伺服器不保密，用途是防 explorer 字典攻擊
    salt_hex: Mapped[str] = mapped_column(String(64))
    digest_hex: Mapped[str] = mapped_column(String(64), index=True)
    # 總金額（元，整數）。店家記帳需要，明細仍保持加密。
    total_amount: Mapped[int] = mapped_column(Integer)
    # 覆誦文字（不含精確品項之外的資訊，方便 TTS 重播）
    readback_text: Mapped[str] = mapped_column(Text, default="")
    # quoted -> settling -> settled | failed
    status: Mapped[str] = mapped_column(String(16), default="quoted", index=True)
    fail_code: Mapped[str] = mapped_column(String(64), default="")
    settle_tx_digest: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)
    settled_at: Mapped[int] = mapped_column(Integer, default=0)


class Settlement(Base):
    """結算紀錄。order_id 上的 UNIQUE 約束是冪等性的最後一道防線：
    同一筆訂單在資料庫層面不可能出現兩筆結算。"""

    __tablename__ = "settlements"
    __table_args__ = (Index("uq_settlements_order", "order_id", unique=True),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "stl_" + _uuid())
    order_id: Mapped[str] = mapped_column(String(64))
    merchant_id: Mapped[str] = mapped_column(String(64), index=True)
    amount: Mapped[int] = mapped_column(Integer)
    tx_digest: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class UsedNonce(Base):
    """confirm 請求的防重放 nonce。滿 tolerance 時間後可清除。"""

    __tablename__ = "used_nonces"

    nonce: Mapped[str] = mapped_column(String(128), primary_key=True)
    seen_at: Mapped[int] = mapped_column(Integer, default=now_s, index=True)


class WebhookEndpoint(Base):
    __tablename__ = "webhook_endpoints"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "whk_" + _uuid())
    merchant_id: Mapped[str] = mapped_column(String(64), index=True)
    url: Mapped[str] = mapped_column(Text)
    # 簽章密鑰明文儲存（送出時要用來計算 HMAC，無法只存 hash）
    secret: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class WebhookDelivery(Base):
    """webhook 送達紀錄與重試佇列。"""

    __tablename__ = "webhook_deliveries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: "whd_" + _uuid())
    endpoint_id: Mapped[str] = mapped_column(String(64), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[str] = mapped_column(Text)
    # pending | delivered | failed
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[int] = mapped_column(Integer, default=now_s, index=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)


class AuthChallenge(Base):
    """消費者登入用的一次性挑戰字串。"""

    __tablename__ = "auth_challenges"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    challenge: Mapped[str] = mapped_column(String(128), unique=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_s)
    used: Mapped[int] = mapped_column(Integer, default=0)
