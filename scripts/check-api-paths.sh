#!/usr/bin/env bash
#
# scripts/check-api-paths.sh — guard against silent 404s.
#
# The 2026-09-06 audit found 13 frontend fetch() calls targeting routes
# that didn't exist. This script diffs every /api/... literal in
# public_html/ against the routes actually registered in api/src/, so a
# similar drift can't slip back in.
#
# Strategy:
#   1. Collect frontend call sites via Python regex (handles JS string
#      templates like `/api/foo/${id}` cleanly).
#   2. Collect registered routes by parsing server.ts (mount prefixes)
#      and grepping each route file for `xxxRoute.(get|post|...)("path")`.
#   3. Diff and report unmatched. Exit 1 if any unmatched.
#
# T-13 acceptance.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "check-api-paths.sh: python3 required" >&2
  exit 2
fi

python3 - <<'PY'
import os, re, sys
from pathlib import Path

ROOT = Path(".").resolve()
PUBLIC = ROOT / "public_html"
SERVER = ROOT / "api/src/server.ts"
ROUTES_DIR = ROOT / "api/src/routes"

# --- 1. Frontend call sites ----------------------------------------------
# Match a /api/... string literal. Tolerate template-literal interpolations
# (`${...}`) by stripping them down to the static prefix. Skip dynamic
# constructions like `"/api/" + x` — those can't be statically resolved.

frontend_paths: set[str] = set()

js_files = list(PUBLIC.rglob("*.js")) + list(PUBLIC.rglob("*.html"))
for path in js_files:
    if "/vendor/" in str(path):
        continue
    text = path.read_text(errors="replace")
    # Match "/api/..." literals (single/double/back tick). Up to the next quote
    # or template-literal end, stripped of ${...} interpolations.
    for m in re.finditer(r"['\"`](/api/[A-Za-z0-9_\-/{}$]*?)['\"`]", text):
        raw = m.group(1)
        # Strip template-literal interpolations — keep the static prefix only.
        # "/api/foo/${id}/bar" → "/api/foo"
        static = re.split(r"\$\{[^}]*\}", raw)[0]
        # Trim trailing slashes / partial segments left after the cut.
        static = static.rstrip("/")
        # Drop the literal `${` opening if the cut left it dangling.
        static = re.sub(r"\$\{[^}]*$", "", static)
        if static and static != "/api":
            frontend_paths.add(static)

# --- 2. Registered routes -----------------------------------------------
# Parse server.ts to find:
#   - imports:  import { xRoute } from "./routes/x";
#   - mounts:   app.route("/api/foo", xRoute);
# Then in each routes/x.ts, grep for `xRoute.(get|post|...)("path")` and
# concatenate mount-prefix + path.

registered: set[str] = set()

import_pattern = re.compile(r'import\s*\{\s*([^}]+)\}\s*from\s*"\./routes/([\w-]+)"')
mount_pattern = re.compile(r'\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)')

server_text = SERVER.read_text()
import_map: dict[str, str] = {}
for m in import_pattern.finditer(server_text):
    names_str, file_stem = m.group(1), m.group(2)
    # Extract the first import name (the route variable)
    var_name = names_str.split(",")[0].strip()
    import_map[var_name] = file_stem

mounts: list[tuple[str, str]] = []
for m in mount_pattern.finditer(server_text):
    prefix, var_name = m.group(1), m.group(2)
    mounts.append((prefix, var_name))

route_decl_pattern = re.compile(r'\.(get|post|put|patch|delete)\(\s*"([^"]+)"')

for prefix, var_name in mounts:
    stem = import_map.get(var_name)
    if not stem:
        continue
    route_file = ROUTES_DIR / f"{stem}.ts"
    if not route_file.exists():
        continue
    rt = route_file.read_text()
    for m in route_decl_pattern.finditer(rt):
        sub = m.group(2)
        # Combine mount prefix + sub-path. "/api/health" + "/" → "/api/health/"
        # → normalize to "/api/health" so the frontend literal matches.
        if sub == "/":
            full = prefix
        else:
            full = prefix.rstrip("/") + "/" + sub.lstrip("/")
        full = re.sub(r"/+", "/", full)
        full = full.rstrip("/") or "/"
        registered.add(full)

# --- 3. Diff -------------------------------------------------------------
# Frontend paths may be parameterised templates (`/api/foo/${id}/bar`).
# The static prefix `/api/foo` should match any registered route whose
# remaining path starts with `:` (a parameter) at the next segment.
#
# Match rules (in order):
#   1. Exact: frontend path == registered path.
#   2. Prefix with param next segment:
#      registered = "/api/foo/:id", frontend = "/api/foo" → match.
#   3. No match → 404.
#
# This catches the case where a route is `/api/discovery-status/:id` and
# the JS calls `/api/discovery-status/${requestId}` — the script sees both
# as static `/api/discovery-status` after stripping the interpolation,
# and prefix-match wins.

WHITELIST = {
    # Documented plan references, not yet shipped.
    "/api/intelligence/admin",
}

allowed_frontend = frontend_paths | WHITELIST


def matches(frontend_path: str, registered_paths: set[str]) -> bool:
    if frontend_path in registered_paths:
        return True
    # Strip a trailing slash for sanity.
    fp = frontend_path.rstrip("/") or "/"
    fp_parts = fp.split("/")
    for rp in registered_paths:
        rp_norm = rp.rstrip("/") or "/"
        if rp_norm == fp:
            return True
        rp_parts = rp_norm.split("/")

        # A ROUTE PARAM may stand for any frontend segment, and the
        # route may carry trailing params the frontend literal does not
        # name.
        #
        # The tile proxy is the case that needs it: the client asks for
        # "/api/tile/rain" (the date and the tile numbers are built at
        # runtime) and the route is "/api/tile/:dataset/:date/:z/:y/:x"
        # — the literal "rain" IS the `:dataset`, and the route has
        # four more segments the frontend literal never spells out.
        #
        # The rule is positional and strict about LITERALS: a route
        # segment that is not a param must equal the frontend's, and
        # the route may only have EXTRA segments if they are all
        # params. A mismatch anywhere fails.
        ok = True
        for i, seg in enumerate(fp_parts):
            if i >= len(rp_parts):
                ok = False
                break
            rseg = rp_parts[i]
            if rseg.startswith(":"):
                continue
            if rseg != seg:
                ok = False
                break
        if ok:
            rest = rp_parts[len(fp_parts):]
            if all(r.startswith(":") for r in rest):
                return True

        # The registered route might have extra segments after fp. If the
        # next segment after fp is a Hono parameter (`:foo`), it's a match.
        if rp_norm.startswith(fp + "/"):
            tail = rp_norm[len(fp) + 1 :].split("/", 1)[0]
            if tail.startswith(":"):
                return True
    return False


unmatched = sorted(
    p for p in frontend_paths if not matches(p, registered) and p not in WHITELIST
)
unused_registered = sorted(p for p in registered if p not in allowed_frontend)

print(f"Frontend call sites: {len(frontend_paths)}")
print(f"Registered routes:   {len(registered)}")

if unmatched:
    print()
    print("UNMATCHED frontend /api/ paths (will 404):")
    for p in unmatched:
        print(f"  {p}")

if unused_registered:
    # Don't fail on this — many admin/worker routes have no UI consumer
    # by design. Just print for visibility.
    print()
    print(f"(Informational) Registered routes with no frontend caller ({len(unused_registered)}):")
    for p in unused_registered[:20]:
        print(f"  {p}")
    if len(unused_registered) > 20:
        print(f"  ... and {len(unused_registered) - 20} more")

if unmatched:
    sys.exit(1)

print()
print("All public_html /api/ paths are registered. ✓")
PY
