import time
import uuid

TOKEN_TTL = 60

_pending: dict[str, dict] = {}


def create_token(action: str, params: dict, preview: str) -> dict:
    token = str(uuid.uuid4())
    mutation = {
        "token": token,
        "action": action,
        "params": params,
        "preview": preview,
        "created_at": time.time(),
    }
    _pending[token] = mutation
    return mutation


def consume_token(token: str) -> dict | None:
    mutation = _pending.pop(token, None)
    if not mutation:
        return None
    if time.time() - mutation["created_at"] > TOKEN_TTL:
        return None
    return mutation


def list_pending() -> list[dict]:
    now = time.time()
    expired = [k for k, v in _pending.items() if now - v["created_at"] > TOKEN_TTL]
    for k in expired:
        del _pending[k]
    return list(_pending.values())
