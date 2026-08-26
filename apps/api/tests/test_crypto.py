"""加解密往返、digest 決定性、salt 唯一性、webhook 簽章。"""

from chui_api.crypto import (
    canonical_json,
    decrypt_order_details,
    encrypt_order_details,
    generate_api_key,
    hash_api_key,
    new_salt,
    order_digest,
    sign_session,
    sign_webhook_payload,
    verify_session,
    verify_webhook_signature,
)


def test_encrypt_decrypt_roundtrip():
    details = {"total": 65, "lines": [{"name": "奶茶", "qty": 2}], "note": "台灣中文測試"}
    ct, nonce, key = encrypt_order_details(details)
    assert decrypt_order_details(ct, nonce, key) == details


def test_decrypt_with_wrong_key_fails():
    details = {"total": 25}
    ct, nonce, _key = encrypt_order_details(details)
    _ct2, _n2, other_key = encrypt_order_details(details)
    import pytest

    with pytest.raises(Exception):
        decrypt_order_details(ct, nonce, other_key)


def test_digest_deterministic_and_salt_sensitive():
    details = {"b": 2, "a": 1}
    salt = new_salt()
    assert order_digest(details, salt) == order_digest({"a": 1, "b": 2}, salt)
    assert order_digest(details, salt) != order_digest(details, new_salt())


def test_salt_is_32_bytes_and_unique():
    salts = {new_salt() for _ in range(100)}
    assert len(salts) == 100
    assert all(len(s) == 32 for s in salts)


def test_canonical_json_stable():
    # 與 SDK 端 canonicalJson 對齊：鍵排序、無空白、UTF-8 原樣
    assert canonical_json({"b": 1, "a": [2, "中文"]}) == '{"a":[2,"中文"],"b":1}'.encode()


def test_api_key_only_hash_stored():
    key, key_hash = generate_api_key()
    assert key.startswith("chui_sk_")
    assert key_hash == hash_api_key(key)
    assert key not in key_hash


def test_webhook_signature_roundtrip():
    body = b'{"type":"order.settled"}'
    sig = sign_webhook_payload("secret", "1700000000", body)
    assert verify_webhook_signature("secret", "1700000000", body, sig)
    assert not verify_webhook_signature("secret", "1700000001", body, sig)
    assert not verify_webhook_signature("wrong", "1700000000", body, sig)


def test_session_sign_verify():
    token = sign_session("s3cret", {"typ": "consumer", "sub": "csr_1", "exp": 9999999999})
    assert verify_session("s3cret", token)["sub"] == "csr_1"
    assert verify_session("other", token) is None
    assert verify_session("s3cret", token + "x") is None
