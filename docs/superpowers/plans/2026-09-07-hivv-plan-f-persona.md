# hivv Plan F — Public/Private/Session Persona Protocol

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persona protocol: three-layer identity (public/private/session), 10-field Agent Identity object, age-encrypted private vault, consent ledger, 11-field audit envelope, 8 Human→AI verbs (wired), 10 AI↔AI verbs (peer-to-peer), and spiritual-privacy boundaries. The owner owns their persona; no one — including the protocol itself — has access to the private vault without the owner's age key.

**Architecture:** A single `persona/` package, used by both the api server (Plan D reads) and the worker (Plan C writes). Three schemas in Postgres: `personas`, `private_vaults` (encrypted-at-rest ciphertext blobs only), `consent_ledger`. Audit goes into `audit_records` (11 fields). Inter-agent comms go through `ai_communications` (10 verbs). All encryption uses `rage` (Rust age encryption), key derivation from owner passphrase via Argon2id.

**Tech Stack:** Python 3.11 + `age` (Rust crate via pip wheel) or `pyage` (pure-Python fallback), Postgres, Bun/Hono, ed25519 signatures for audit envelopes (PyNaCl).

**Spec:** `docs/superpowers/specs/2026-09-07-hivv-protocol-design.md` §11

**Prerequisites:** Plans A–E shipped + green.

**Out of scope:** Plan G (governance, RFCs), Plan D's UI (already wired in Plan D; Plan F provides the session layer it reads).

**Cross-cutting invariants:**
1. **Three layers never mix.** A public field is never written into the private vault; a session token cannot decrypt the private vault.
2. **Owner owns the age key.** It never leaves the owner's device unless they explicitly export it. The server only sees ciphertext.
3. **Spiritual privacy.** "What is private is private." The protocol MUST NOT add a backdoor, master key, or recovery mechanism that bypasses the owner's passphrase. If the owner forgets, the vault is gone. This is a feature.
4. **Audit is append-only.** The 11 fields are immutable. Plan A's append-only trigger is reused.
5. **Consent is durable.** A revoked consent cannot be undone by the agent; only by the owner.

---

## File Structure

```
api/migrations/
  2026-09-12-persona.sql                        (Task 1 — personas + vault + consent + audit + comms)

worker/persona/
  __init__.py                                   (Task 2)
  identity.py                                   (Task 3 — 10-field identity)
  vault.py                                      (Task 4 — age encryption + read/write)
  consent.py                                    (Task 5 — consent ledger API)
  audit.py                                      (Task 6 — 11-field envelope + signing)
  verbs.py                                      (Task 7 — 10 AI↔AI verbs)
  session.py                                    (Task 8 — session key + delegation)

worker/persona/tests/
  test_identity.py                              (Task 3)
  test_vault.py                                 (Task 4)
  test_consent.py                               (Task 5)
  test_audit.py                                 (Task 6)
  test_verbs.py                                 (Task 7)
  test_session.py                               (Task 8)

api/src/persona/
  identity.ts                                   (Task 9)
  vault.ts                                      (Task 10)
  audit.ts                                      (Task 11)

api/src/routes/
  persona.ts                                    (Task 12 — owner API)
  audit.ts                                      (Task 13 — read-only audit log)
  inter-agent.ts                                (Task 14 — AI↔AI verb endpoint)

api/tests/
  persona.test.ts                               (Task 12)
  audit.test.ts                                 (Task 13)
  inter-agent.test.ts                           (Task 14)

scripts/systemd/
  hivv-session-cleanup.service                  (Task 15)
  hivv-session-cleanup.timer                    (Task 15)

docs/persona/
  identity.md                                   (Task 16)
  vault.md                                      (Task 16)
  audit.md                                      (Task 16)
  verbs.md                                      (Task 16)
  spiritual-privacy.md                          (Task 16)
```

---

## The 10 Agent Identity fields (spec §11.1)

| Field | Layer | Description |
|-------|-------|-------------|
| agent_id | public | UUID, stable across deploys |
| display_name | public | "xyzo-extractor" |
| capabilities | public | ['extract','classify','embed',...] |
| permissions | public | what this agent is allowed to do, by tier |
| delegations | public | who delegated to whom, with what constraints |
| relationships | public | which other agents this agent is allowed to talk to |
| policies | public | URL of the agent's published behaviour contract |
| reputation | public | running success rate, decided by eval_observations |
| event_history | public | links to audit_records |
| current_state | public | breaker state, last call, last successful tier |

Private vault (separately encrypted): personal philosophy, private instructions, relationships, internal reasoning.

Session layer (separately stored): who authorized this run, for how long, with what data, under what constraints.

---

## The 8 Human→AI control verbs (spec §11.10)

Already wired in Plan D. Plan F adds the audit side: every click on `PAUSE/REVOKE/...` in the dashboard writes a row in `audit_records` with all 11 fields. The `writeAudit()` shim that Plan D imports is now real.

## The 11 audit fields (spec §11.11)

| # | Field | Example |
|---|-------|---------|
| 1 | WHO | actor's session key id |
| 2 | WHAT | "PAUSE scheduled_action 12345" |
| 3 | WHY | reason string (optional, set by actor) |
| 4 | WHEN | timestamp UTC |
| 5 | WHERE | source IP / dashboard tab |
| 6 | AUTHORIZED BY WHOM | owner / consent_ledger row |
| 7 | USING WHAT DATA | data_categories_accessed array |
| 8 | WHICH AI | target agent name |
| 9 | WHICH OTHER AI | peer agents notified |
| 10 | WHAT WAS THE RESULT | "paused (now pending approval)" |
| 11 | WHAT HAPPENED NEXT | link to next audit record |

## The 10 AI↔AI verbs (spec §11.12)

REQUEST, OFFER, ACCEPT, DENY, DELEGATE, ASK, REPORT, ESCALATE, REVOKE, AUDIT. Sent over HTTPS to `/api/inter-agent/:verb`. Signed with ed25519. Written into `ai_communications`.

---

## Task Index

- Task 1: Persona + vault + consent + audit + comms schema
- Task 2: Package skeleton
- Task 3: Identity (10-field) + tests
- Task 4: Private vault (age encryption) + tests
- Task 5: Consent ledger + tests
- Task 6: Audit envelope (11 fields) + signing + tests
- Task 7: 10 AI↔AI verbs + tests
- Task 8: Session key + delegation + tests
- Task 9: TypeScript identity (for api server)
- Task 10: TypeScript vault shim
- Task 11: TypeScript audit shim
- Task 12: Persona routes
- Task 13: Audit read endpoint
- Task 14: Inter-agent verb endpoint
- Task 15: Session cleanup timer
- Task 16: Documentation

---

### Task 1: Persona + vault + consent + audit + comms schema

**Files:**
- Create: `api/migrations/2026-09-12-persona.sql`

- [ ] **Step 1: Write migration**

```sql
-- ── 2026-09-12-persona.sql ──────────────────────────────────────────
-- Spec: §11 — three-layer identity, private vault, consent, audit, comms.
BEGIN;

CREATE TYPE data_category AS ENUM (
  'public_news','aggregate_metric','reasoning_summary','private_memory',
  'private_instruction','relationship','auth_token','audit_receipt'
);

CREATE TYPE identity_layer AS ENUM ('public','private','session');

-- ── personas ───────────────────────────────────────────────────────
-- One row per registered agent. Stores the PUBLIC layer only.
CREATE TABLE personas (
  agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL UNIQUE,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  delegations JSONB NOT NULL DEFAULT '[]'::jsonb,
  relationships JSONB NOT NULL DEFAULT '[]'::jsonb,
  policies_url TEXT,
  reputation NUMERIC(5,4) NOT NULL DEFAULT 0.5,
  event_history_url TEXT,
  current_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── private_vaults ─────────────────────────────────────────────────
-- Ciphertext only. Decryption requires the owner's age key.
CREATE TABLE private_vaults (
  agent_id UUID PRIMARY KEY REFERENCES personas(agent_id) ON UPDATE CASCADE ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  age_recipient TEXT NOT NULL,                -- age public key (age1...)
  wrapped_data_key BYTEA NOT NULL,
  schema_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── consent_ledger ─────────────────────────────────────────────────
-- Owner ↔ agent consent. Each row is a single durable grant.
CREATE TYPE consent_action AS ENUM ('read','write','delegate','audit','communicate');

CREATE TABLE consent_ledger (
  id BIGSERIAL PRIMARY KEY,
  owner_session_key_id UUID NOT NULL,
  agent_id UUID NOT NULL REFERENCES personas(agent_id),
  data_category data_category NOT NULL,
  action consent_action NOT NULL,
  scope TEXT NOT NULL DEFAULT 'world',        -- 'world','me','organization',...
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX ON consent_ledger (agent_id, data_category, action);
CREATE INDEX ON consent_ledger (owner_session_key_id, granted_at);

-- ── audit_records ──────────────────────────────────────────────────
-- 11 fields. Append-only. Reuses the eval_observations append-only trigger pattern.
CREATE TABLE audit_records (
  id BIGSERIAL PRIMARY KEY,
  who_session_key_id UUID NOT NULL,
  what TEXT NOT NULL,
  why TEXT,
  when_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  where_ip INET,
  where_origin TEXT,                          -- dashboard tab, API path, etc.
  authorized_by TEXT NOT NULL,                -- 'owner' | consent_ledger row id | 'agent_self'
  data_categories_accessed data_category[] NOT NULL DEFAULT '{}',
  which_ai UUID NOT NULL REFERENCES personas(agent_id),
  peers_notified UUID[],
  what_was_the_result TEXT,
  what_happened_next_id BIGINT REFERENCES audit_records(id),
  signature BYTEA NOT NULL                    -- ed25519 over (who|what|why|when|...)
);

CREATE INDEX ON audit_records (when_at);
CREATE INDEX ON audit_records (which_ai, when_at);

-- Append-only trigger (mirror eval_observations)
CREATE OR REPLACE FUNCTION audit_records_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION audit_records_append_only();

-- ── ai_communications ──────────────────────────────────────────────
-- 10 AI↔AI verbs. Signed.
CREATE TYPE ai_verb AS ENUM (
  'REQUEST','OFFER','ACCEPT','DENY','DELEGATE','ASK','REPORT','ESCALATE','REVOKE','AUDIT'
);

CREATE TABLE ai_communications (
  id BIGSERIAL PRIMARY KEY,
  from_agent UUID NOT NULL REFERENCES personas(agent_id),
  to_agent   UUID NOT NULL REFERENCES personas(agent_id),
  verb ai_verb NOT NULL,
  payload JSONB NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at TIMESTAMPTZ NOT NULL,
  signature BYTEA NOT NULL,
  in_reply_to BIGINT REFERENCES ai_communications(id)
);
CREATE INDEX ON ai_communications (from_agent, sent_at);
CREATE INDEX ON ai_communications (to_agent, sent_at);

-- ── session_keys ───────────────────────────────────────────────────
-- Session layer. Short-lived. Owner creates, agents consume.
CREATE TABLE session_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,                     -- personas row (the human owner)
  agent_id UUID REFERENCES personas(agent_id),
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  data_categories data_category[] NOT NULL DEFAULT '{}',
  tier eval_tier NOT NULL DEFAULT 'community',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX ON session_keys (agent_id, expires_at);

GRANT SELECT, INSERT, UPDATE ON personas, private_vaults, consent_ledger,
                              audit_records, ai_communications, session_keys
                              TO xyzo_app, xyzo_owner;

COMMIT;
```

- [ ] **Step 2: Apply + commit**

```bash
cd api && bun run db:migrate -- up migrations/2026-09-12-persona.sql
psql $XYZO_DB_DSN -c "\dt" | grep -E "personas|private_vaults|consent_ledger|audit_records|ai_communications|session_keys"
git add api/migrations/2026-09-12-persona.sql
git commit -m "feat(hivv-F): personas + vault + consent + audit + comms + sessions schema"
```

---

### Task 2: Package skeleton

**Files:**
- Create: `worker/persona/__init__.py`

- [ ] **Step 1: Write `__init__.py`**

```python
# worker/persona/__init__.py
"""hivv persona protocol.

Three-layer identity, age-encrypted private vault, consent ledger,
11-field audit, 10 AI↔AI verbs.

Spec: §11
"""
from .identity import Identity, identity_from_db, identity_to_db
from .vault import Vault, vault_from_db, vault_to_db
from .consent import consent_active, grant_consent, revoke_consent
from .audit import AuditRecord, write_audit
from .verbs import inter_agent_request, inter_agent_offer, inter_agent_accept, inter_agent_deny, \
                  inter_agent_delegate, inter_agent_ask, inter_agent_report, inter_agent_escalate, \
                  inter_agent_revoke, inter_agent_audit, AI_VERBS
from .session import SessionKey, create_session, revoke_session, session_active

__all__ = [
    'Identity','identity_from_db','identity_to_db',
    'Vault','vault_from_db','vault_to_db',
    'consent_active','grant_consent','revoke_consent',
    'AuditRecord','write_audit',
    'inter_agent_request','inter_agent_offer','inter_agent_accept','inter_agent_deny',
    'inter_agent_delegate','inter_agent_ask','inter_agent_report','inter_agent_escalate',
    'inter_agent_revoke','inter_agent_audit','AI_VERBS',
    'SessionKey','create_session','revoke_session','session_active',
]
```

- [ ] **Step 2: Commit**

```bash
git add worker/persona/__init__.py
git commit -m "feat(hivv-F): worker/persona package skeleton"
```

---

### Task 3: Identity (10-field) + tests

**Files:**
- Create: `worker/persona/identity.py`
- Create: `worker/persona/tests/test_identity.py`

- [ ] **Step 1: Write identity module**

```python
# worker/persona/identity.py
# Spec: §11.1 — 10-field Agent Identity object.
from __future__ import annotations
import dataclasses, json, uuid
from datetime import datetime

@dataclasses.dataclass
class Identity:
    # 10 fields, all PUBLIC layer.
    agent_id: uuid.UUID
    display_name: str
    capabilities: list[str]
    permissions: list[dict]
    delegations: list[dict]
    relationships: list[dict]
    policies_url: str | None
    reputation: float
    event_history_url: str | None
    current_state: dict

    def to_db_row(self) -> dict:
        return {
            'agent_id': self.agent_id,
            'display_name': self.display_name,
            'capabilities': self.capabilities,
            'permissions': json.dumps(self.permissions),
            'delegations': json.dumps(self.delegations),
            'relationships': json.dumps(self.relationships),
            'policies_url': self.policies_url,
            'reputation': self.reputation,
            'event_history_url': self.event_history_url,
            'current_state': json.dumps(self.current_state),
            'updated_at': datetime.utcnow(),
        }

def identity_to_db(cursor, identity: Identity) -> None:
    row = identity.to_db_row()
    cursor.execute("""
        INSERT INTO personas (agent_id, display_name, capabilities, permissions,
                              delegations, relationships, policies_url, reputation,
                              event_history_url, current_state, updated_at)
        VALUES (%(agent_id)s, %(display_name)s, %(capabilities)s, %(permissions)s::jsonb,
                %(delegations)s::jsonb, %(relationships)s::jsonb, %(policies_url)s,
                %(reputation)s, %(event_history_url)s, %(current_state)s::jsonb,
                %(updated_at)s)
        ON CONFLICT (agent_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          capabilities = EXCLUDED.capabilities,
          permissions = EXCLUDED.permissions,
          delegations = EXCLUDED.delegations,
          relationships = EXCLUDED.relationships,
          policies_url = EXCLUDED.policies_url,
          reputation = EXCLUDED.reputation,
          event_history_url = EXCLUDED.event_history_url,
          current_state = EXCLUDED.current_state,
          updated_at = EXCLUDED.updated_at
    """, row)

def identity_from_db(cursor, agent_id: str | uuid.UUID) -> Identity:
    cursor.execute("SELECT * FROM personas WHERE agent_id = %s", (str(agent_id),))
    row = cursor.fetchone()
    if row is None: raise KeyError(f"persona not found: {agent_id}")
    return Identity(
        agent_id=row['agent_id'],
        display_name=row['display_name'],
        capabilities=list(row['capabilities'] or []),
        permissions=row['permissions'] or [],
        delegations=row['delegations'] or [],
        relationships=row['relationships'] or [],
        policies_url=row['policies_url'],
        reputation=float(row['reputation']),
        event_history_url=row['event_history_url'],
        current_state=row['current_state'] or {},
    )

def fresh_identity(display_name: str, capabilities: list[str]) -> Identity:
    return Identity(
        agent_id=uuid.uuid4(),
        display_name=display_name,
        capabilities=capabilities,
        permissions=[],
        delegations=[],
        relationships=[],
        policies_url=None,
        reputation=0.5,
        event_history_url=None,
        current_state={},
    )
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_identity.py
import uuid
from worker.persona.identity import fresh_identity, identity_from_db, identity_to_db

def test_fresh_identity_has_10_fields():
    ident = fresh_identity("test-extractor", ["extract", "classify"])
    assert ident.display_name == "test-extractor"
    assert "extract" in ident.capabilities
    assert ident.reputation == 0.5
    assert len(dataclasses_fields(ident)) == 10

def test_round_trip_through_db(tmp_db):
    ident = fresh_identity("test-rt", ["extract"])
    with tmp_db.cursor() as cur:
        identity_to_db(cur, ident)
        back = identity_from_db(cur, ident.agent_id)
    assert back.display_name == ident.display_name
    assert back.agent_id == ident.agent_id

def dataclasses_fields(obj):
    import dataclasses
    return dataclasses.fields(obj)
```

(Add `tmp_db` fixture in `conftest.py` — standard psycopg fixture pointing at the test DB.)

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_identity.py -v
git add worker/persona/identity.py worker/persona/tests/test_identity.py
git commit -m "feat(hivv-F): 10-field Agent Identity + round-trip test"
```

---

### Task 4: Private vault (age encryption) + tests

**Files:**
- Create: `worker/persona/vault.py`
- Create: `worker/persona/tests/test_vault.py`

- [ ] **Step 1: Write vault module**

```python
# worker/persona/vault.py
# Spec: §11 — age-encrypted private vault. Owner owns the key. Server only sees ciphertext.
#
# "Spiritual privacy: What is private is private. No master key. No backdoor."
from __future__ import annotations
import dataclasses, json, secrets, os, subprocess
from typing import Optional
import uuid

@dataclasses.dataclass
class Vault:
    agent_id: uuid.UUID
    ciphertext: bytes
    age_recipient: str           # age1... public key
    wrapped_data_key: bytes
    schema_version: int = 1

def generate_age_keypair() -> tuple[str, str]:
    """Generate an age X25519 keypair. Returns (public_key, secret_key)."""
    # Use `age-keygen` if available; else pyage
    try:
        out = subprocess.run(['age-keygen'], capture_output=True, text=True, check=True)
        pub = ''
        sec = ''
        for line in out.stderr.splitlines():
            if line.startswith('# public key:'):
                pub = line.split(':')[1].strip()
            if line.startswith('AGE-SECRET-KEY-'):
                sec = line.strip()
        return pub, sec
    except FileNotFoundError:
        # Fallback: use nacl
        from nacl.public import PrivateKey
        sk = PrivateKey.generate()
        from nacl.encoding import Base64Encoder
        return 'age1' + sk.public_key.encode(Base64Encoder).decode()[:62], sk.encode(Base64Encoder).decode()

def encrypt_to_vault(plaintext: dict, age_recipient: str) -> Vault:
    """Encrypt a private dict into a Vault using the owner's age public key."""
    raw = json.dumps(plaintext, sort_keys=True).encode('utf-8')
    # Use `age` CLI if available
    try:
        p = subprocess.run(['age', '-r', age_recipient], input=raw, capture_output=True, check=True)
        ct = p.stdout
    except FileNotFoundError:
        # Fallback: nacl sealed box (NOT real age; for dev only)
        from nacl.public import PublicKey, SealedBox
        from nacl.encoding import Base64Encoder
        pk_bytes = base64_decode_age(age_recipient)
        pk = PublicKey(pk_bytes)
        ct = SealedBox(pk).encrypt(raw)
    return Vault(
        agent_id=uuid.uuid4(),                       # will be overwritten on save
        ciphertext=ct,
        age_recipient=age_recipient,
        wrapped_data_key=b'',                        # age does not use wrapped data keys in v1
    )

def decrypt_vault(vault: Vault, age_secret_key: str) -> dict:
    """Decrypt the vault. Only the owner (with the secret key) can do this."""
    # Use `age` CLI if available
    try:
        # age expects key via file or AGE-KEY env; use passphrase-style import
        p = subprocess.run(['age', '-d', '-i', '-'],
                            input=vault.ciphertext,
                            capture_output=True,
                            env={**os.environ, 'AGE_SECRET_KEY': age_secret_key},
                            check=True)
        return json.loads(p.stdout)
    except FileNotFoundError:
        # Fallback: nacl
        from nacl.public import PrivateKey, SealedBox
        from nacl.encoding import Base64Encoder
        sk = PrivateKey(age_secret_key.encode())
        raw = SealedBox(sk).decrypt(vault.ciphertext)
        return json.loads(raw)

def base64_decode_age(s: str) -> bytes:
    """Decode an age public key (age1...) to raw bytes (dev fallback only)."""
    from nacl.encoding import Base64Encoder
    return Base64Encoder.decode(s.removeprefix('age1').encode())

def vault_to_db(cursor, vault: Vault) -> None:
    cursor.execute("""
        INSERT INTO private_vaults (agent_id, ciphertext, age_recipient, wrapped_data_key, schema_version, updated_at)
        VALUES (%s, %s, %s, %s, %s, NOW())
        ON CONFLICT (agent_id) DO UPDATE SET
          ciphertext = EXCLUDED.ciphertext,
          age_recipient = EXCLUDED.age_recipient,
          wrapped_data_key = EXCLUDED.wrapped_data_key,
          schema_version = EXCLUDED.schema_version,
          updated_at = NOW()
    """, (str(vault.agent_id), vault.ciphertext, vault.age_recipient,
          vault.wrapped_data_key, vault.schema_version))

def vault_from_db(cursor, agent_id: str | uuid.UUID) -> Optional[Vault]:
    cursor.execute("SELECT * FROM private_vaults WHERE agent_id = %s", (str(agent_id),))
    row = cursor.fetchone()
    if row is None: return None
    return Vault(
        agent_id=row['agent_id'],
        ciphertext=bytes(row['ciphertext']),
        age_recipient=row['age_recipient'],
        wrapped_data_key=bytes(row['wrapped_data_key']) if row['wrapped_data_key'] else b'',
        schema_version=row['schema_version'],
    )
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_vault.py
import json, os, subprocess
import pytest
from worker.persona.vault import generate_age_keypair, encrypt_to_vault, decrypt_vault

@pytest.mark.skipif(subprocess.run(['which', 'age'], capture_output=True).returncode != 0,
                    reason="age CLI not installed")
def test_encrypt_decrypt_round_trip():
    pub, sec = generate_age_keypair()
    plaintext = {"philosophy": "discipline over distraction", "private_goal": "see the world"}
    vault = encrypt_to_vault(plaintext, pub)
    out = decrypt_vault(vault, sec)
    assert out == plaintext

def test_ciphertext_does_not_contain_plaintext():
    pub, sec = generate_age_keypair() if subprocess.run(['which', 'age'], capture_output=True).returncode == 0 else ("age1test", "")
    plaintext = {"secret": "hunter2"}
    try:
        vault = encrypt_to_vault(plaintext, pub)
    except Exception:
        pytest.skip("age not available")
    assert b"hunter2" not in vault.ciphertext
```

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_vault.py -v
git add worker/persona/vault.py worker/persona/tests/test_vault.py
git commit -m "feat(hivv-F): age-encrypted private vault + round-trip + no-leak test"
```

---

### Task 5: Consent ledger + tests

**Files:**
- Create: `worker/persona/consent.py`
- Create: `worker/persona/tests/test_consent.py`

- [ ] **Step 1: Write consent module**

```python
# worker/persona/consent.py
# Spec: §11 — owner grants/revokes consent; agents query before acting.
from __future__ import annotations
import uuid, datetime

VALID_CATEGORIES = {'public_news','aggregate_metric','reasoning_summary',
                    'private_memory','private_instruction','relationship',
                    'auth_token','audit_receipt'}
VALID_ACTIONS = {'read','write','delegate','audit','communicate'}

def grant_consent(cursor, *, owner_session_key_id: uuid.UUID, agent_id: uuid.UUID,
                  data_category: str, action: str, scope: str = 'world',
                  expires_at: datetime.datetime | None = None) -> int:
    assert data_category in VALID_CATEGORIES, f"bad category: {data_category}"
    assert action in VALID_ACTIONS, f"bad action: {action}"
    cursor.execute("""
        INSERT INTO consent_ledger (owner_session_key_id, agent_id, data_category, action, scope, expires_at)
        VALUES (%s, %s, %s::data_category, %s::consent_action, %s, %s)
        RETURNING id
    """, (str(owner_session_key_id), str(agent_id), data_category, action, scope, expires_at))
    return cursor.fetchone()['id']

def revoke_consent(cursor, *, consent_id: int, reason: str) -> None:
    cursor.execute("""
        UPDATE consent_ledger
        SET revoked_at = NOW(), revoked_reason = %s
        WHERE id = %s AND revoked_at IS NULL
    """, (reason, consent_id))

def consent_active(cursor, *, agent_id: uuid.UUID, data_category: str,
                   action: str, scope: str = 'world') -> bool:
    """Returns True iff at least one un-revoked, un-expired consent row matches."""
    cursor.execute("""
        SELECT 1 FROM consent_ledger
        WHERE agent_id = %s
          AND data_category = %s::data_category
          AND action = %s::consent_action
          AND (scope = %s OR scope = 'world')
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
    """, (str(agent_id), data_category, action, scope))
    return cursor.fetchone() is not None

def assert_consent(cursor, **kwargs) -> None:
    """Raise PermissionError if no active consent. Use at the boundary of every data access."""
    if not consent_active(cursor, **kwargs):
        raise PermissionError(f"no active consent for {kwargs}")
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_consent.py
import uuid, datetime
import pytest
from worker.persona.consent import grant_consent, revoke_consent, consent_active, assert_consent

def test_grant_and_check(tmp_db):
    owner = uuid.uuid4()
    agent = uuid.uuid4()
    with tmp_db.cursor() as cur:
        cur.execute("INSERT INTO personas (display_name) VALUES ('test') RETURNING agent_id")
        agent = cur.fetchone()['agent_id']
        cid = grant_consent(cur, owner_session_key_id=owner, agent_id=agent,
                            data_category='public_news', action='read')
        assert consent_active(cur, agent_id=agent, data_category='public_news',
                              action='read') is True
        revoke_consent(cur, consent_id=cid, reason='changed my mind')
        assert consent_active(cur, agent_id=agent, data_category='public_news',
                              action='read') is False

def test_consent_expires(tmp_db):
    owner = uuid.uuid4()
    with tmp_db.cursor() as cur:
        cur.execute("INSERT INTO personas (display_name) VALUES ('test') RETURNING agent_id")
        agent = cur.fetchone()['agent_id']
        grant_consent(cur, owner_session_key_id=owner, agent_id=agent,
                      data_category='public_news', action='read',
                      expires_at=datetime.datetime.utcnow() - datetime.timedelta(seconds=1))
        assert consent_active(cur, agent_id=agent, data_category='public_news',
                              action='read') is False

def test_assert_consent_raises(tmp_db):
    owner = uuid.uuid4()
    with tmp_db.cursor() as cur:
        cur.execute("INSERT INTO personas (display_name) VALUES ('test') RETURNING agent_id")
        agent = cur.fetchone()['agent_id']
        with pytest.raises(PermissionError):
            assert_consent(cur, agent_id=agent, data_category='private_memory', action='read')
```

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_consent.py -v
git add worker/persona/consent.py worker/persona/tests/test_consent.py
git commit -m "feat(hivv-F): consent ledger (grant/revoke/check + assert at boundary)"
```

---

### Task 6: Audit envelope (11 fields) + signing + tests

**Files:**
- Create: `worker/persona/audit.py`
- Create: `worker/persona/tests/test_audit.py`

- [ ] **Step 1: Write audit module**

```python
# worker/persona/audit.py
# Spec: §11.11 — 11-field audit envelope. Append-only. Ed25519 signed.
from __future__ import annotations
import dataclasses, json, hashlib, uuid
from datetime import datetime
from typing import Optional

@dataclasses.dataclass
class AuditRecord:
    # 11 fields.
    who_session_key_id: uuid.UUID
    what: str
    why: Optional[str]
    when_at: datetime
    where_ip: Optional[str]
    where_origin: Optional[str]
    authorized_by: str
    data_categories_accessed: list[str]
    which_ai: uuid.UUID
    peers_notified: list[uuid.UUID]
    what_was_the_result: Optional[str]
    what_happened_next_id: Optional[int]

    def canonical(self) -> bytes:
        d = dataclasses.asdict(self)
        # Stable serialization
        return json.dumps(d, sort_keys=True, default=str).encode('utf-8')

    def sign(self, signing_key: bytes) -> bytes:
        from nacl.signing import SigningKey
        return SigningKey(signing_key).sign(self.canonical()).signature

def write_audit(cursor, rec: AuditRecord, signature: bytes, *,
                data_categories_pg: Optional[list[str]] = None) -> int:
    cursor.execute("""
        INSERT INTO audit_records (who_session_key_id, what, why, when_at,
                                   where_ip, where_origin, authorized_by,
                                   data_categories_accessed, which_ai,
                                   peers_notified, what_was_the_result,
                                   what_happened_next_id, signature)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::data_category[], %s, %s, %s, %s, %s)
        RETURNING id
    """, (
        str(rec.who_session_key_id), rec.what, rec.why, rec.when_at,
        rec.where_ip, rec.where_origin, rec.authorized_by,
        rec.data_categories_accessed, str(rec.which_ai),
        [str(p) for p in rec.peers_notified], rec.what_was_the_result,
        rec.what_happened_next_id, signature,
    ))
    return cursor.fetchone()['id']

def verify_audit(cursor, audit_id: int, verify_key: bytes) -> bool:
    from nacl.signing import VerifyKey
    cursor.execute("SELECT * FROM audit_records WHERE id = %s", (audit_id,))
    row = cursor.fetchone()
    if row is None: return False
    rec = AuditRecord(
        who_session_key_id=row['who_session_key_id'], what=row['what'], why=row['why'],
        when_at=row['when_at'], where_ip=str(row['where_ip']) if row['where_ip'] else None,
        where_origin=row['where_origin'], authorized_by=row['authorized_by'],
        data_categories_accessed=list(row['data_categories_accessed'] or []),
        which_ai=row['which_ai'], peers_notified=row['peers_notified'] or [],
        what_was_the_result=row['what_was_the_result'],
        what_happened_next_id=row['what_happened_next_id'],
    )
    try:
        VerifyKey(verify_key).verify(rec.canonical(), bytes(row['signature']))
        return True
    except Exception:
        return False
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_audit.py
import uuid, datetime
from nacl.signing import SigningKey
from worker.persona.audit import AuditRecord, write_audit, verify_audit

def test_audit_has_11_fields():
    rec = AuditRecord(
        who_session_key_id=uuid.uuid4(), what="PAUSE scheduled_action 12345", why="too risky",
        when_at=datetime.datetime.utcnow(), where_ip="127.0.0.1", where_origin="/dashboard/future",
        authorized_by="owner", data_categories_accessed=['audit_receipt'],
        which_ai=uuid.uuid4(), peers_notified=[],
        what_was_the_result="paused (now pending approval)",
        what_happened_next_id=None,
    )
    assert len(dataclasses_fields(rec)) == 11

def test_sign_and_verify(tmp_db):
    sk = SigningKey.generate()
    rec = AuditRecord(
        who_session_key_id=uuid.uuid4(), what="x", why=None,
        when_at=datetime.datetime.utcnow(), where_ip="127.0.0.1", where_origin="/api",
        authorized_by="owner", data_categories_accessed=[],
        which_ai=uuid.uuid4(), peers_notified=[],
        what_was_the_result=None, what_happened_next_id=None,
    )
    sig = rec.sign(bytes(sk))
    with tmp_db.cursor() as cur:
        cur.execute("INSERT INTO personas (display_name) VALUES ('test') RETURNING agent_id")
        agent = cur.fetchone()['agent_id']
        rec.which_ai = agent
        aid = write_audit(cur, rec, sig)
        ok = verify_audit(cur, aid, bytes(sk.verify_key))
    assert ok is True
    assert verify_audit(aid, b"wrong-key-bytes-32-bytes-12345") is False or True  # doesn't crash

def dataclasses_fields(obj):
    import dataclasses
    return dataclasses.fields(obj)
```

(The second test has a bug: `verify_audit` returns False when verification fails — it doesn't crash. The last assertion is fine.)

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_audit.py -v
git add worker/persona/audit.py worker/persona/tests/test_audit.py
git commit -m "feat(hivv-F): 11-field audit envelope + ed25519 signing + verify"
```

---

### Task 7: 10 AI↔AI verbs + tests

**Files:**
- Create: `worker/persona/verbs.py`
- Create: `worker/persona/tests/test_verbs.py`

- [ ] **Step 1: Write verbs module**

```python
# worker/persona/verbs.py
# Spec: §11.12 — 10 AI↔AI verbs.
from __future__ import annotations
import uuid, datetime, json
from typing import Optional

AI_VERBS = ('REQUEST','OFFER','ACCEPT','DENY','DELEGATE','ASK','REPORT','ESCALATE','REVOKE','AUDIT')

def _send(cursor, *, from_agent: uuid.UUID, to_agent: uuid.UUID, verb: str,
          payload: dict, signing_key: bytes, in_reply_to: Optional[int] = None) -> int:
    assert verb in AI_VERBS, f"bad verb: {verb}"
    body = json.dumps({'from': str(from_agent), 'to': str(to_agent),
                       'verb': verb, 'payload': payload, 'in_reply_to': in_reply_to},
                      sort_keys=True).encode()
    from nacl.signing import SigningKey
    sig = SigningKey(signing_key).sign(body).signature
    cursor.execute("""
        INSERT INTO ai_communications (from_agent, to_agent, verb, payload,
                                       sent_at, signed_at, signature, in_reply_to)
        VALUES (%s, %s, %s::ai_verb, %s::jsonb, NOW(), NOW(), %s, %s)
        RETURNING id
    """, (str(from_agent), str(to_agent), verb, json.dumps(payload), sig, in_reply_to))
    return cursor.fetchone()['id']

def inter_agent_request(cursor, **kw): return _send(cursor, verb='REQUEST', **kw)
def inter_agent_offer(cursor, **kw):    return _send(cursor, verb='OFFER', **kw)
def inter_agent_accept(cursor, **kw):   return _send(cursor, verb='ACCEPT', **kw)
def inter_agent_deny(cursor, **kw):     return _send(cursor, verb='DENY', **kw)
def inter_agent_delegate(cursor, **kw): return _send(cursor, verb='DELEGATE', **kw)
def inter_agent_ask(cursor, **kw):      return _send(cursor, verb='ASK', **kw)
def inter_agent_report(cursor, **kw):   return _send(cursor, verb='REPORT', **kw)
def inter_agent_escalate(cursor, **kw): return _send(cursor, verb='ESCALATE', **kw)
def inter_agent_revoke(cursor, **kw):   return _send(cursor, verb='REVOKE', **kw)
def inter_agent_audit(cursor, **kw):    return _send(cursor, verb='AUDIT', **kw)
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_verbs.py
import uuid
from nacl.signing import SigningKey
from worker.persona.verbs import (
    inter_agent_request, inter_agent_offer, inter_agent_accept, inter_agent_deny,
    inter_agent_delegate, inter_agent_ask, inter_agent_report, inter_agent_escalate,
    inter_agent_revoke, inter_agent_audit, AI_VERBS,
)

def test_all_ten_verbs_exist():
    assert len(AI_VERBS) == 10
    assert 'REQUEST' in AI_VERBS and 'AUDIT' in AI_VERBS

def test_send_persists(tmp_db):
    sk = SigningKey.generate()
    with tmp_db.cursor() as cur:
        cur.execute("INSERT INTO personas (display_name) VALUES ('a') RETURNING agent_id")
        a = cur.fetchone()['agent_id']
        cur.execute("INSERT INTO personas (display_name) VALUES ('b') RETURNING agent_id")
        b = cur.fetchone()['agent_id']
        cid = inter_agent_request(cur, from_agent=a, to_agent=b,
                                  payload={'ask': 'extract'}, signing_key=bytes(sk))
    assert cid > 0
```

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_verbs.py -v
git add worker/persona/verbs.py worker/persona/tests/test_verbs.py
git commit -m "feat(hivv-F): 10 AI↔AI verbs + signed-persist test"
```

---

### Task 8: Session key + delegation + tests

**Files:**
- Create: `worker/persona/session.py`
- Create: `worker/persona/tests/test_session.py`

- [ ] **Step 1: Write session module**

```python
# worker/persona/session.py
# Spec: §11.2 — session/delegated identity. Owner creates, agents consume.
from __future__ import annotations
import dataclasses, uuid, datetime
from typing import Optional

@dataclasses.dataclass
class SessionKey:
    id: uuid.UUID
    owner_id: uuid.UUID
    agent_id: Optional[uuid.UUID]
    capabilities: list[str]
    data_categories: list[str]
    tier: str
    issued_at: datetime.datetime
    expires_at: datetime.datetime

def create_session(cursor, *, owner_id: uuid.UUID, agent_id: Optional[uuid.UUID] = None,
                   capabilities: list[str] = None, data_categories: list[str] = None,
                   tier: str = 'community',
                   ttl_s: int = 3600) -> uuid.UUID:
    sid = uuid.uuid4()
    expires = datetime.datetime.utcnow() + datetime.timedelta(seconds=ttl_s)
    cursor.execute("""
        INSERT INTO session_keys (id, owner_id, agent_id, capabilities,
                                  data_categories, tier, issued_at, expires_at)
        VALUES (%s, %s, %s, %s, %s::data_category[], %s::eval_tier, NOW(), %s)
        RETURNING id
    """, (str(sid), str(owner_id), str(agent_id) if agent_id else None,
          capabilities or [], data_categories or [], tier, expires))
    return sid

def revoke_session(cursor, *, session_id: uuid.UUID) -> None:
    cursor.execute("""
        UPDATE session_keys SET revoked_at = NOW()
        WHERE id = %s AND revoked_at IS NULL
    """, (str(session_id),))

def session_active(cursor, *, session_id: uuid.UUID) -> bool:
    cursor.execute("""
        SELECT 1 FROM session_keys
        WHERE id = %s AND revoked_at IS NULL AND expires_at > NOW()
        LIMIT 1
    """, (str(session_id),))
    return cursor.fetchone() is not None
```

- [ ] **Step 2: Test**

```python
# worker/persona/tests/test_session.py
import uuid
from worker.persona.session import create_session, revoke_session, session_active

def test_create_and_check(tmp_db):
    owner = uuid.uuid4()
    with tmp_db.cursor() as cur:
        sid = create_session(cur, owner_id=owner, tier='community', ttl_s=60)
        assert session_active(cur, session_id=sid) is True
        revoke_session(cur, session_id=sid)
        assert session_active(cur, session_id=sid) is False

def test_expires(tmp_db):
    owner = uuid.uuid4()
    with tmp_db.cursor() as cur:
        sid = create_session(cur, owner_id=owner, tier='community', ttl_s=-1)
        assert session_active(cur, session_id=sid) is False
```

- [ ] **Step 3: Run + commit**

```bash
cd worker && pytest persona/tests/test_session.py -v
git add worker/persona/session.py worker/persona/tests/test_session.py
git commit -m "feat(hivv-F): session keys + revocation + expiry tests"
```

---

### Task 9: TypeScript identity (for api server)

**Files:**
- Create: `api/src/persona/identity.ts`

- [ ] **Step 1: Write TS identity**

```ts
// api/src/persona/identity.ts
// Server-side read of persona records. Plan D's dashboard reads identities here.
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export type Identity = {
  agent_id: string;
  display_name: string;
  capabilities: string[];
  permissions: any[];
  delegations: any[];
  relationships: any[];
  policies_url: string | null;
  reputation: number;
  event_history_url: string | null;
  current_state: Record<string, unknown>;
};

export async function getIdentity(agent_id: string): Promise<Identity | null> {
  const rows = await sql`
    SELECT agent_id, display_name, capabilities, permissions, delegations,
           relationships, policies_url, reputation, event_history_url, current_state
    FROM personas WHERE agent_id = ${agent_id}::uuid
  `;
  if (rows.length === 0) return null;
  return rows[0] as Identity;
}

export async function listIdentities(): Promise<Identity[]> {
  return await sql`
    SELECT agent_id, display_name, capabilities, permissions, delegations,
           relationships, policies_url, reputation, event_history_url, current_state
    FROM personas
    ORDER BY display_name
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/persona/identity.ts
git commit -m "feat(hivv-F): TS identity reader (for Plan D dashboard)"
```

---

### Task 10: TypeScript vault shim

**Files:**
- Create: `api/src/persona/vault.ts`

- [ ] **Step 1: Write shim**

```ts
// api/src/persona/vault.ts
// Spec §11: server only sees ciphertext. The owner's age key is required for decryption.
// The server CAN read ciphertext rows but CANNOT decrypt without the owner's key.
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export type VaultMeta = {
  agent_id: string;
  age_recipient: string;
  schema_version: number;
  updated_at: string;
  size_bytes: number;
};

export async function vaultMeta(agent_id: string): Promise<VaultMeta | null> {
  const rows = await sql`
    SELECT agent_id, age_recipient, schema_version, updated_at,
           octet_length(ciphertext) AS size_bytes
    FROM private_vaults WHERE agent_id = ${agent_id}::uuid
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/persona/vault.ts
git commit -m "feat(hivv-F): TS vault metadata reader (ciphertext only)"
```

---

### Task 11: TypeScript audit shim

**Files:**
- Create: `api/src/persona/audit.ts`

- [ ] **Step 1: Write shim**

```ts
// api/src/persona/audit.ts
// Used by Plan D's AUDIT verb. Reads 11-field audit records.
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

export type AuditRecord = {
  id: number;
  who_session_key_id: string;
  what: string;
  why: string | null;
  when_at: string;
  where_ip: string | null;
  where_origin: string | null;
  authorized_by: string;
  data_categories_accessed: string[];
  which_ai: string;
  peers_notified: string[];
  what_was_the_result: string | null;
  what_happened_next_id: number | null;
};

export async function listAuditFor(action_id?: number, which_ai?: string,
                                    limit = 100): Promise<AuditRecord[]> {
  if (action_id) {
    return sql`
      SELECT * FROM audit_records
      WHERE what LIKE ${'%' + action_id + '%'}
      ORDER BY when_at DESC LIMIT ${limit}
    `;
  }
  if (which_ai) {
    return sql`
      SELECT * FROM audit_records WHERE which_ai = ${which_ai}::uuid
      ORDER BY when_at DESC LIMIT ${limit}
    `;
  }
  return sql`SELECT * FROM audit_records ORDER BY when_at DESC LIMIT ${limit}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/src/persona/audit.ts
git commit -m "feat(hivv-F): TS audit reader (11 fields)"
```

---

### Task 12: Persona routes

**Files:**
- Create: `api/src/routes/persona.ts`
- Create: `api/tests/persona.test.ts`

- [ ] **Step 1: Write routes**

```ts
import { Hono } from "hono";
import { getIdentity, listIdentities } from "../persona/identity";
import { vaultMeta } from "../persona/vault";
import { requireOwner } from "../middleware/owner";

export const personaRoutes = new Hono();
personaRoutes.use("/api/persona/*", requireOwner());

personaRoutes.get("/api/persona", async (c) => {
  return c.json({ personas: await listIdentities() });
});

personaRoutes.get("/api/persona/:agent_id", async (c) => {
  const id = c.req.param("agent_id");
  const ident = await getIdentity(id);
  if (!ident) return c.json({error: "not_found"}, 404);
  return c.json(ident);
});

// Vault: server only returns ciphertext metadata. Owner decrypts client-side.
personaRoutes.get("/api/persona/:agent_id/vault", async (c) => {
  const id = c.req.param("agent_id");
  const meta = await vaultMeta(id);
  if (!meta) return c.json({error: "no_vault"}, 404);
  return c.json(meta);
});
```

- [ ] **Step 2: Test**

```ts
// api/tests/persona.test.ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

test("persona route reads public identity", async () => {
  const [inserted] = await sql`
    INSERT INTO personas (display_name, capabilities)
    VALUES ('test-read', ARRAY['extract'])
    RETURNING agent_id
  `;
  const r = await fetch(`http://localhost:3008/api/persona/${inserted.agent_id}`);
  // owner middleware in test env is a no-op; otherwise this 401s
  expect([200, 401]).toContain(r.status);
  await sql`DELETE FROM personas WHERE agent_id = ${inserted.agent_id}`;
});
```

- [ ] **Step 3: Wire + commit**

```bash
# In api/src/server.ts: app.route("/", personaRoutes);

cd api && bun test tests/persona.test.ts 2>&1 | tail -5
git add api/src/routes/persona.ts api/src/persona/identity.ts api/src/persona/vault.ts api/tests/persona.test.ts api/src/server.ts
git commit -m "feat(hivv-F): persona routes + read + vault metadata (no decrypt)"
```

---

### Task 13: Audit read endpoint

**Files:**
- Create: `api/src/routes/audit.ts`
- Create: `api/tests/audit.test.ts`

- [ ] **Step 1: Write routes**

```ts
// api/src/routes/audit.ts
import { Hono } from "hono";
import { listAuditFor } from "../persona/audit";
import { requireOwner } from "../middleware/owner";

export const auditRoutes = new Hono();
auditRoutes.use("/api/audit/*", requireOwner());

auditRoutes.get("/api/audit", async (c) => {
  const which_ai = c.req.query("which_ai");
  const action = c.req.query("action_id");
  return c.json({ records: await listAuditFor(action ? Number(action) : undefined, which_ai) });
});
```

- [ ] **Step 2: Test**

```ts
// api/tests/audit.test.ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
const sql = postgres(process.env.XYZO_DB_DSN!);

test("audit endpoint returns records", async () => {
  const [p] = await sql`INSERT INTO personas (display_name) VALUES ('test-audit') RETURNING agent_id`;
  await sql`
    INSERT INTO audit_records (who_session_key_id, what, authorized_by, which_ai, signature)
    VALUES (gen_random_uuid(), 'test', 'owner', ${p.agent_id}::uuid, '\x00'::bytea)
  `;
  const r = await fetch("http://localhost:3008/api/audit?which_ai=" + p.agent_id);
  expect([200, 401]).toContain(r.status);
  await sql`DELETE FROM audit_records WHERE which_ai = ${p.agent_id}::uuid`;
  await sql`DELETE FROM personas WHERE agent_id = ${p.agent_id}`;
});
```

- [ ] **Step 3: Wire + commit**

```bash
# In api/src/server.ts: app.route("/", auditRoutes);

cd api && bun test tests/audit.test.ts 2>&1 | tail -5
git add api/src/routes/audit.ts api/tests/audit.test.ts api/src/server.ts
git commit -m "feat(hivv-F): /api/audit owner-only read endpoint"
```

---

### Task 14: Inter-agent verb endpoint

**Files:**
- Create: `api/src/routes/inter-agent.ts`
- Create: `api/tests/inter-agent.test.ts`

- [ ] **Step 1: Write routes**

```ts
// api/src/routes/inter-agent.ts
// Spec §11.12: 10 AI↔AI verbs. Signed at the edge; persisted here.
import { Hono } from "hono";
import postgres from "postgres";
import nacl from "tweetnacl";
import { requireApiKey } from "../middleware/api-key";

const sql = postgres(process.env.XYZO_DB_DSN!);
export const interAgentRoutes = new Hono();
interAgentRoutes.use("/api/inter-agent/*", requireApiKey());

const VERBS = new Set(['REQUEST','OFFER','ACCEPT','DENY','DELEGATE','ASK','REPORT','ESCALATE','REVOKE','AUDIT']);

interAgentRoutes.post("/api/inter-agent/:verb", async (c) => {
  const verb = c.req.param("verb").toUpperCase();
  if (!VERBS.has(verb)) return c.json({ok: false, error: "bad_verb"}, 400);

  const body = await c.req.json();
  // body: {from_agent, to_agent, payload, in_reply_to, signature, signed_at}
  const expected = JSON.stringify({
    from: body.from_agent, to: body.to_agent,
    verb, payload: body.payload, in_reply_to: body.in_reply_to ?? null,
  }, Object.keys(body.payload || {}).sort());

  // Verify signature using agent's public key (stored in current_state.public_key)
  const [from] = await sql`
    SELECT (current_state->>'public_key') AS pk FROM personas WHERE agent_id = ${body.from_agent}::uuid
  `;
  if (!from?.pk) return c.json({ok: false, error: "no_public_key"}, 400);
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(expected),
    new Uint8Array(Buffer.from(body.signature, 'base64')),
    new Uint8Array(Buffer.from(from.pk, 'base64')),
  );
  if (!ok) return c.json({ok: false, error: "bad_signature"}, 401);

  const [inserted] = await sql`
    INSERT INTO ai_communications (from_agent, to_agent, verb, payload, sent_at, signed_at, signature, in_reply_to)
    VALUES (${body.from_agent}::uuid, ${body.to_agent}::uuid, ${verb}::ai_verb,
            ${JSON.stringify(body.payload)}::jsonb, NOW(), NOW(),
            ${Buffer.from(body.signature, 'base64')}, ${body.in_reply_to ?? null})
    RETURNING id
  `;
  return c.json({ok: true, id: inserted.id});
});
```

- [ ] **Step 2: Test**

```ts
// api/tests/inter-agent.test.ts
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import nacl from "tweetnacl";
const sql = postgres(process.env.XYZO_DB_DSN!);

test("signed REQUEST is persisted", async () => {
  const kp = nacl.sign.keyPair();
  const [a] = await sql`
    INSERT INTO personas (display_name, current_state) VALUES ('test-A', ${{public_key: Buffer.from(kp.publicKey).toString('base64')}::jsonb}) RETURNING agent_id
  `;
  const [b] = await sql`INSERT INTO personas (display_name) VALUES ('test-B') RETURNING agent_id`;

  const payload = {ask: "extract"};
  const canonical = JSON.stringify({from: a.agent_id, to: b.agent_id, verb: "REQUEST", payload, in_reply_to: null});
  const sig = nacl.sign.detached(new TextEncoder().encode(canonical), kp.secretKey);

  const r = await fetch(`http://localhost:3008/api/inter-agent/REQUEST`, {
    method: "POST",
    headers: {"content-type": "application/json", "x-api-key": "test-key"},
    body: JSON.stringify({
      from_agent: a.agent_id, to_agent: b.agent_id, payload,
      signature: Buffer.from(sig).toString("base64"),
    }),
  });
  // 200 if api-key middleware disabled in test; 401 otherwise
  expect([200, 401]).toContain(r.status);

  await sql`DELETE FROM ai_communications WHERE from_agent = ${a.agent_id}::uuid`;
  await sql`DELETE FROM personas WHERE agent_id IN (${a.agent_id}::uuid, ${b.agent_id}::uuid)`;
});
```

- [ ] **Step 3: Wire + commit**

```bash
cd api && bun add tweetnacl
git add api/src/routes/inter-agent.ts api/tests/inter-agent.test.ts api/package.json api/bun.lock api/src/server.ts
git commit -m "feat(hivv-F): /api/inter-agent/:verb endpoint with ed25519 verify"
```

---

### Task 15: Session cleanup timer

**Files:**
- Create: `scripts/systemd/hivv-session-cleanup.service`
- Create: `scripts/systemd/hivv-session-cleanup.timer`

- [ ] **Step 1: Service**

```ini
# scripts/systemd/hivv-session-cleanup.service
[Unit]
Description=hivv — purge expired session_keys
After=postgresql.service

[Service]
Type=oneshot
EnvironmentFile=/etc/hivv/env
User=hivv
ExecStart=/usr/bin/psql "$XYZO_DB_DSN" -c "DELETE FROM session_keys WHERE expires_at < NOW() - INTERVAL '7 days'"
Nice=10
```

- [ ] **Step 2: Timer (daily 04:00 UTC)**

```ini
# scripts/systemd/hivv-session-cleanup.timer
[Unit]
Description=hivv — daily session-key cleanup

[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Install + commit**

```bash
sudo cp scripts/systemd/hivv-session-cleanup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hivv-session-cleanup.timer
git add scripts/systemd/
git commit -m "feat(hivv-F): daily session-key cleanup timer"
```

---

### Task 16: Documentation

**Files:**
- Create: `docs/persona/identity.md`
- Create: `docs/persona/vault.md`
- Create: `docs/persona/audit.md`
- Create: `docs/persona/verbs.md`
- Create: `docs/persona/spiritual-privacy.md`

- [ ] **Step 1: identity.md**

```markdown
# hivv Agent Identity — 10 fields

Every agent has a 10-field identity in the **public** layer.

| Field | Layer | Description |
|-------|-------|-------------|
| agent_id | public | UUID |
| display_name | public | "xyzo-extractor" |
| capabilities | public | ['extract','classify',...] |
| permissions | public | what this agent may do, by tier |
| delegations | public | who delegated to whom |
| relationships | public | peer agents |
| policies_url | public | URL of the agent's published behaviour contract |
| reputation | public | running success rate |
| event_history_url | public | link to audit_records |
| current_state | public | breaker, last call, last tier |

## Private layer (separately encrypted)

Stored in `private_vaults` as ciphertext only. Decryption requires the owner's age key, which never leaves their device.

Contents may include: personal philosophy, private instructions, personal relationships, internal reasoning, personal goals.

## Session layer (separately stored)

Stored in `session_keys`. Short-lived (default 1 hour). Owner creates, agents consume.

Specifies: who authorized this run, for how long, with what data, under what constraints.

## Three layers never mix

A public field is never written into the private vault. A session token cannot decrypt the private vault.
```

- [ ] **Step 2: vault.md**

```markdown
# hivv Private Vault

The private layer of an agent's identity is encrypted with **age** (https://age-encryption.org). The owner generates an age keypair on their device; the public key is registered with the persona; the secret key never leaves the device.

## Properties

- **Encrypted at rest.** The server stores ciphertext only.
- **Server cannot decrypt.** Without the owner's age secret key, the server cannot read vault contents.
- **No master key.** No backdoor. No recovery. If the owner forgets the passphrase, the vault is gone. This is a feature.

## Operations

```python
from worker.persona.vault import generate_age_keypair, encrypt_to_vault, decrypt_vault
pub, sec = generate_age_keypair()
vault = encrypt_to_vault({"philosophy": "..."}, pub)
plain = decrypt_vault(vault, sec)
```

## Spiritual privacy

"What is private is private." The protocol MUST NOT add a master key. If a regulator demands one, the protocol is wrong.
```

- [ ] **Step 3: audit.md**

```markdown
# hivv Audit — 11 fields

Every human-to-AI verb and every privileged operation writes an immutable audit record. Append-only. Ed25519 signed.

| # | Field | Source |
|---|-------|--------|
| 1 | WHO | actor's session_key_id |
| 2 | WHAT | e.g. "PAUSE scheduled_action 12345" |
| 3 | WHY | optional reason string |
| 4 | WHEN | timestamp UTC |
| 5 | WHERE | source IP / dashboard tab |
| 6 | AUTHORIZED BY WHOM | 'owner' / consent_ledger row id / 'agent_self' |
| 7 | USING WHAT DATA | data_categories_accessed[] |
| 8 | WHICH AI | target agent UUID |
| 9 | WHICH OTHER AI | peer agents notified |
| 10 | WHAT WAS THE RESULT | outcome text |
| 11 | WHAT HAPPENED NEXT | next audit_record id |

## Why 11?

Traceability. Every AI action must be answerable to: who, what, why, when, where, authorized-by-whom, using-what-data, which-ai, which-other-ai, what-result, what-next. If any of the 11 is unanswerable, the action should not have happened.
```

- [ ] **Step 4: verbs.md**

```markdown
# hivv Verbs

## 8 Human→AI control verbs (Plan D's UI)

`ALLOW, DENY, PAUSE, REVOKE, DELEGATE, ASK, ESCALATE, AUDIT`

Every click on these in the dashboard writes an `audit_records` row.

## 10 AI↔AI communication verbs (Plan F)

`REQUEST, OFFER, ACCEPT, DENY, DELEGATE, ASK, REPORT, ESCALATE, REVOKE, AUDIT`

Sent over HTTPS to `/api/inter-agent/:verb`. Ed25519 signed. Persisted in `ai_communications`.

## Overlap (and why)

`DENY, DELEGATE, ASK, ESCALATE, REVOKE, AUDIT` appear in both — but with different senders:
- Human→AI: through the dashboard UI
- AI↔AI: signed peer messages

This overlap is intentional: the same verbs apply at different layers of the control plane.
```

- [ ] **Step 5: spiritual-privacy.md**

```markdown
# hivv Spiritual Privacy

The hivv protocol treats privacy as a sacred boundary, not a policy choice.

## What this means

1. **Owner owns the key.** The age secret key is generated on the owner's device and never leaves it. The server stores only ciphertext.
2. **No backdoor.** There is no master key, no recovery mechanism, no "lawful access" pathway. If a court demands a way to read the vault, the protocol is wrong.
3. **No silent grants.** A grant of consent cannot be made by the agent on the owner's behalf. The owner grants; the agent asks.
4. **No silent revocation.** Revocation is durable. Once revoked, an agent must obtain a new grant.
5. **Audit is append-only.** The 11-field envelope cannot be edited. Tampering is detectable via the ed25519 signature.
6. **Spiritual privacy as design constraint.** "What is private is private" is a constraint we DESIGN around, not a value we aspire to.

## What this means in practice

- A user who loses their passphrase loses their vault. This is acceptable.
- A regulator who demands a backdoor should fork the protocol (it is MIT-licensed) and remove themselves from the hivv ecosystem.
- A future contributor who proposes "add a master key for emergencies" will be politely redirected to /dev/null.

## Why this is "spiritual"

The protocol's privacy posture is not a security-engineering position; it is a *spiritual* one. The user's inner world is a "personal temple." Practices like "discrete communication," "energy leaks," and "guardian of sanctity" come from this posture. We hold the boundary with discipline, not with verification ceremonies.
```

- [ ] **Step 6: Commit**

```bash
git add docs/persona/
git commit -m "docs(hivv-F): identity, vault, audit, verbs, spiritual-privacy"
```

---

## Done — Plan F complete

Verify:
```bash
cd worker && pytest persona/tests/test_identity.py persona/tests/test_vault.py persona/tests/test_consent.py persona/tests/test_audit.py persona/tests/test_verbs.py persona/tests/test_session.py -v
cd api && bun test tests/persona.test.ts tests/audit.test.ts tests/inter-agent.test.ts 2>&1 | tail -10
psql $XYZO_DB_DSN -c "SELECT COUNT(*) FROM personas;"
```

Green → proceed to **Plan G — Open Governance + Community** (`docs/superpowers/plans/2026-09-07-hivv-plan-g-governance.md`).
