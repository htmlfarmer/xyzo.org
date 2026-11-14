"""Registration + auth for collabd.

Two responsibilities:
  1. Generate an RSA keypair locally and POST the public key to xyzo.
     xyzo returns a node_id + dashboard_token, which we persist to
     ~/.collab/config.toml.
  2. Sign requests (future). PR-1 only uses bearer tokens; signing is
     reserved for PR-2/3 where we'll add more sensitive endpoints.

Stdlib only (urllib, ssl, json, base64).
"""
from __future__ import annotations

import base64
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .config import Config


@dataclass
class RegistrationResult:
    node_id: str
    dashboard_token: str
    name: str
    jobs_url: str
    heartbeat_url: str
    dashboard_url: str
    roles: list[str]


def detect_os() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        # Detect WSL specifically.
        try:
            release = Path("/proc/sys/kernel/osrelease").read_text().lower()
            if "microsoft" in release or "wsl" in release:
                return "wsl"
        except Exception:
            pass
        return "linux"
    if sys.platform.startswith("win"):
        return "windows"
    return "other"


def detect_arch() -> str:
    """Return 'arm64', 'x86_64', or 'other'."""
    machine = os.uname().machine if hasattr(os, "uname") else ""
    machine = (machine or "").lower()
    if machine in ("arm64", "aarch64"):
        return "arm64"
    if machine in ("x86_64", "amd64"):
        return "x86_64"
    return "other"


def generate_keypair(key_dir: Path) -> tuple[Path, Path]:
    """Generate a 2048-bit RSA keypair. Returns (priv_path, pub_pem_path)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key_dir.mkdir(parents=True, exist_ok=True)
    priv_path = key_dir / "node.key"
    pub_path = key_dir / "node.pub.pem"

    if priv_path.exists():
        # Reuse existing key — don't lose identity on reinstall.
        return priv_path, pub_path

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    priv_path.write_bytes(priv_pem)
    pub_path.write_bytes(pub_pem)
    try:
        priv_path.chmod(0o600)
        pub_path.chmod(0o644)
    except Exception:
        pass
    return priv_path, pub_path


def load_public_key_pem(pub_path: Path) -> str:
    return pub_path.read_text()


def register(cfg: Config, key_dir: Path, *, timeout_s: float = 30.0) -> RegistrationResult:
    """POST /api/collab/register, persist tokens, return the result."""
    _, pub_path = generate_keypair(key_dir)
    pub_pem = load_public_key_pem(pub_path)

    payload = {
        "name": cfg.name or socket.gethostname(),
        "public_key": pub_pem,
        "os": detect_os(),
        "arch": detect_arch(),
        "python_version": "%d.%d.%d" % sys.version_info[:3],
        "collabd_version": "0.1.0",
        "roles": cfg.roles,
    }

    url = cfg.hub_url.rstrip("/") + "/api/collab/register"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
        if resp.status != 201:
            raise RuntimeError(f"register failed: HTTP {resp.status}")
        body = json.loads(resp.read())

    cfg.node_id = body["node_id"]
    cfg.dashboard_token = body["dashboard_token"]
    cfg.name = body.get("name", cfg.name)
    cfg.save()
    return RegistrationResult(**body)


def bearer_auth_headers(cfg: Config) -> dict[str, str]:
    return {"authorization": f"Bearer {cfg.dashboard_token}"}


def http_get_json(url: str, cfg: Config | None = None, *, timeout_s: float = 30.0) -> dict:
    """GET a JSON resource. If cfg is provided, adds bearer auth."""
    headers = {"accept": "application/json"}
    if cfg is not None:
        headers.update(bearer_auth_headers(cfg))
    req = urllib.request.Request(url, headers=headers, method="GET")
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
        return json.loads(resp.read())


def http_post_json(url: str, payload: dict, cfg: Config | None = None, *, timeout_s: float = 60.0) -> dict:
    """POST JSON. Returns parsed body or raises."""
    headers = {"content-type": "application/json", "accept": "application/json"}
    if cfg is not None:
        headers.update(bearer_auth_headers(cfg))
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e
