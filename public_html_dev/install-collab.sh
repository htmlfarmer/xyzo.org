#!/usr/bin/env bash
# install-collab.sh — one-line onboarding for xyzo.org/hivv.org/blnq.org collaborators.
#
# Usage:
#   curl -sSL https://xyzo.org/install-collab.sh | bash -s -- --name "asher's macbook"
#
# Flags:
#   --name=NAME        display name for this node
#   --role=ROLE        comma-separated (default: scripts). One of: scripts, gateway,
#                      model_serve, content.
#   --hub=URL          override hub (default: https://xyzo.org)
#   --no-service       don't install systemd/launchd; just register + leave daemon runnable
#   --uninstall        remove everything we installed
#
# After install:
#   collab status    # see node_id + counters
#   collab logs -f   # tail the log
#   collab stop      # stop the daemon
#
# This script is intentionally idempotent — running it twice upgrades.

set -euo pipefail

REPO_URL="https://github.com/xyzo/collab.git"
FALLBACK_REPO_URL="" # set when published under xyzo.org/collab
COLLAB_DIR="${COLLAB_DIR:-$HOME/collab}"
STATE_DIR="$HOME/.collab"

NAME=""
ROLE="scripts"
HUB="https://xyzo.org"
NO_SERVICE=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name=*)   NAME="${1#*=}"; shift ;;
        --name)     NAME="$2"; shift 2 ;;
        --role=*)   ROLE="${1#*=}"; shift ;;
        --role)     ROLE="$2"; shift 2 ;;
        --hub=*)    HUB="${1#*=}"; shift ;;
        --hub)      HUB="$2"; shift 2 ;;
        --no-service) NO_SERVICE=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# //; s/^#//'
            exit 0
            ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

log() { printf '\033[1;34m[collab]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[collab]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[collab]\033[0m %s\n' "$*" >&2; exit 1; }

detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)
            if grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        *) echo "other" ;;
    esac
}

OS="$(detect_os)"
log "detected OS: $OS"

# ── Uninstall ────────────────────────────────────────────────────────────
if [[ "$UNINSTALL" == "1" ]]; then
    log "uninstalling…"
    if [[ "$OS" == "macos" ]]; then
        launchctl unload "$HOME/Library/LaunchAgents/com.xyzo.collabd.plist" 2>/dev/null || true
        rm -f "$HOME/Library/LaunchAgents/com.xyzo.collabd.plist"
    else
        systemctl --user disable --now collabd.service 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/collabd.service"
        systemctl --user daemon-reload 2>/dev/null || true
    fi
    rm -rf "$COLLAB_DIR" "$STATE_DIR"
    log "removed $COLLAB_DIR and $STATE_DIR"
    log "if you also want to remove the node from xyzo, run:"
    log "    curl -sSL $HUB/api/collab/<node_id>/deregister -X POST"
    exit 0
fi

# ── Install OS deps ──────────────────────────────────────────────────────
need_cmd() { command -v "$1" >/dev/null 2>&1; }

ensure_python3() {
    if need_cmd python3; then
        PY=python3
    elif need_cmd python; then
        PY=python
    else
        log "python3 not found — installing"
        case "$OS" in
            macos)
                if ! need_cmd brew; then
                    die "homebrew not found. Install from https://brew.sh first."
                fi
                brew install python@3.11
                PY=python3
                ;;
            linux|wsl)
                if need_cmd apt-get; then
                    sudo apt-get update -y
                    sudo apt-get install -y python3 python3-pip python3-venv
                elif need_cmd dnf; then
                    sudo dnf install -y python3 python3-pip
                elif need_cmd yum; then
                    sudo yum install -y python3 python3-pip
                elif need_cmd pacman; then
                    sudo pacman -Sy --noconfirm python python-pip
                else
                    die "no package manager found — install python3 manually"
                fi
                PY=python3
                ;;
            *) die "unsupported OS: $OS — install python3 manually" ;;
        esac
    fi
    PY_VERSION="$($PY -c 'import sys;print("%d.%d.%d" % sys.version_info[:3])')"
    log "python: $PY ($PY_VERSION)"
    if ! $PY -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
        die "python >= 3.9 required (got $PY_VERSION)"
    fi
}

ensure_git() {
    if need_cmd git; then
        log "git: $(git --version)"
        return
    fi
    log "git not found — installing"
    case "$OS" in
        macos) brew install git ;;
        linux|wsl)
            if need_cmd apt-get; then sudo apt-get install -y git
            elif need_cmd dnf; then sudo dnf install -y git
            elif need_cmd yum; then sudo yum install -y git
            elif need_cmd pacman; then sudo pacman -Sy --noconfirm git
            else die "install git manually"
            fi
            ;;
    esac
}

ensure_cryptography() {
    # collabd imports cryptography for RSA keypair generation.
    # Try to import it; if missing, install via pip into user site.
    if $PY -c 'import cryptography' 2>/dev/null; then
        log "cryptography: installed"
        return
    fi
    log "cryptography not found — installing via pip"
    if ! need_cmd pip; then
        if need_cmd pip3; then PIP=pip3; else
            case "$OS" in
                linux|wsl) $PY -m ensurepip --upgrade || sudo apt-get install -y python3-pip ;;
            esac
            PIP="pip"
        fi
    else
        PIP="pip"
    fi
    $PY -m $PIP install --user --quiet 'cryptography>=41,<46' || \
    $PY -m $PIP install --break-system-packages --quiet 'cryptography>=41,<46' || \
    die "could not install cryptography; try: $PY -m pip install cryptography"
}

ensure_python3
ensure_git
ensure_cryptography

# ── Clone or pull the collab repo ────────────────────────────────────────
if [[ -d "$COLLAB_DIR/.git" ]]; then
    log "pulling latest collab repo at $COLLAB_DIR"
    (cd "$COLLAB_DIR" && git pull --ff-only 2>/dev/null || true)
else
    log "cloning collab repo to $COLLAB_DIR"
    if git clone --depth 1 "$REPO_URL" "$COLLAB_DIR" 2>/dev/null; then
        :
    elif [[ -n "$FALLBACK_REPO_URL" ]] && git clone --depth 1 "$FALLBACK_REPO_URL" "$COLLAB_DIR" 2>/dev/null; then
        :
    else
        die "could not clone $REPO_URL — is the network OK?"
    fi
fi

# Make collabd importable.
export PYTHONPATH="$COLLAB_DIR${PYTHONPATH:+:$PYTHONPATH}"

# Symlink `collab` into ~/.local/bin (create the dir if missing).
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$COLLAB_DIR/collab" "$BIN_DIR/collab"
log "symlinked: $BIN_DIR/collab → $COLLAB_DIR/collab"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    warn "$BIN_DIR is not on your PATH — add it: export PATH=\"$BIN_DIR:\$PATH\""
fi

# ── Register with the hub ────────────────────────────────────────────────
log "registering with hub: $HUB"
register_args=(--hub "$HUB" --role "$ROLE")
if [[ -n "$NAME" ]]; then
    register_args+=(--name "$NAME")
fi

REG_OUTPUT="$($PY -m collabd register "${register_args[@]}")" || die "registration failed"
echo "$REG_OUTPUT"

NODE_ID="$(echo "$REG_OUTPUT" | $PY -c 'import sys, json; print(json.load(sys.stdin)["node_id"])')"
log "registered as node \033[1m$NODE_ID\033[0m"

# ── Install service ──────────────────────────────────────────────────────
write_systemd_user_unit() {
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/collabd.service" <<EOF
[Unit]
Description=collabd — xyzo.org collaborator daemon
After=network-online.target

[Service]
Type=simple
Environment=PYTHONPATH=$COLLAB_DIR
ExecStart=$PY -m collabd start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now collabd.service
}

write_launchd_plist() {
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$HOME/Library/LaunchAgents/com.xyzo.collabd.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.xyzo.collabd</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>collabd</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONPATH</key><string>$COLLAB_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/collabd.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/collabd.err.log</string>
</dict>
</plist>
EOF
    launchctl unload "$HOME/Library/LaunchAgents/com.xyzo.collabd.plist" 2>/dev/null || true
    launchctl load "$HOME/Library/LaunchAgents/com.xyzo.collabd.plist"
}

if [[ "$NO_SERVICE" == "0" ]]; then
    case "$OS" in
        macos)    write_launchd_plist ;;
        linux|wsl) write_systemd_user_unit || warn "systemd unit install failed; run 'collab start' manually" ;;
        *)        warn "OS=$OS: no service installer; run 'collab start' manually" ;;
    esac
else
    log "--no-service set; daemon not started automatically"
fi

# ── Done ─────────────────────────────────────────────────────────────────
cat <<EOF

\033[1;32m✓ collabd installed\033[0m

  node_id:    $NODE_ID
  hub:        $HUB
  role:       $ROLE
  config:     $STATE_DIR/config.toml
  log:        $STATE_DIR/logs/collabd.log
  dashboard:  $HUB/collab/node/$NODE_ID

  collab status    # show counters + last heartbeat
  collab logs -f   # tail the log
  collab stop      # stop the daemon
EOF
