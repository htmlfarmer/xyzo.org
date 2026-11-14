#!/usr/bin/env bash
# ── migrate-to-xyzo.sh ──────────────────────────────────────────────
#
# One-shot migration: xyzo.org → xyzo.org
# Run with:  sudo bash /var/www/vhosts/xyzo.org/scripts/migrate-to-xyzo.sh
#
# Handles: systemd renames, DB rename, code refs, Caddy, crontab, restart.
# Idempotent — safe to re-run.
set -euo pipefail

OLD="newsium"
NEW="xyzo"
OLD_D="xyzo.org"
NEW_D="xyzo.org"
OLD_V="/var/www/vhosts/${OLD_D}"
NEW_V="/var/www/vhosts/${NEW_D}"

log() { echo "━━━ $*"; }
ok()  { echo "  ✓ $*"; }
skip(){ echo "  ⏭ $*"; }

# ── 1. Stop services ────────────────────────────────────────────────
log "Stopping ${OLD} services"
for f in /etc/systemd/system/${OLD}-*.service /etc/systemd/system/${OLD}-*.timer; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  systemctl stop "$n" 2>/dev/null || true
  systemctl disable "$n" 2>/dev/null || true
  ok "stopped $n"
done

# ── 2. Symlink ──────────────────────────────────────────────────────
log "Updating symlink"
[ -L "/home/asher/www/${OLD_D}" ] && rm -f "/home/asher/www/${OLD_D}"
if [ ! -L "/home/asher/www/${NEW_D}" ]; then
  ln -sf "${NEW_V}/public_html" "/home/asher/www/${NEW_D}"
  ok "created /home/asher/www/${NEW_D}"
else
  skip "symlink exists"
fi

# ── 3. Rename systemd services ──────────────────────────────────────
log "Renaming systemd services"
for f in /etc/systemd/system/${OLD}-*.service /etc/systemd/system/${OLD}-*.timer; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  new_base="${base/${OLD}-/${NEW}-}"
  new_file="/etc/systemd/system/${new_base}"
  cp "$f" "$new_file"
  sed -i "s|${OLD_V}|${NEW_V}|g" "$new_file"
  sed -i "s|${OLD_D}|${NEW_D}|g" "$new_file"
  sed -i "s|${OLD}-api|${NEW}-api|g" "$new_file"
  sed -i "s|Description=Newsium|Description=Xyzo|g" "$new_file"
  sed -i "s|SyslogIdentifier=${OLD}|SyslogIdentifier=${NEW}|g" "$new_file"
  rm -f "$f"
  ok "${base} → ${new_base}"
done
# Also update deploy/ copies
for f in "${NEW_V}"/deploy/*.service "${NEW_V}"/deploy/*.timer; do
  [ -f "$f" ] || continue
  sed -i "s|${OLD_V}|${NEW_V}|g; s|${OLD_D}|${NEW_D}|g; s|${OLD}-api|${NEW}-api|g" "$f"
done
systemctl daemon-reload
for f in /etc/systemd/system/${NEW}-*.service /etc/systemd/system/${NEW}-*.timer; do
  [ -f "$f" ] || continue
  systemctl enable "$(basename "$f")" 2>/dev/null || true
done
ok "daemon-reload + enable done"

# ── 4. Rename PostgreSQL database ───────────────────────────────────
log "Renaming database ${OLD} → ${NEW}"
sudo -u postgres psql -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = '${OLD}' AND pid <> pg_backend_pid();" 2>/dev/null || true

if sudo -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "${OLD}"; then
  sudo -u postgres psql -c "ALTER DATABASE ${OLD} RENAME TO ${NEW};"
  ok "database renamed"
else
  skip "database already renamed"
fi

# Update .env
sed -i "s|5432/${OLD}|5432/${NEW}|g" "${NEW_V}/api/.env" 2>/dev/null || true
ok "updated .env"

# Update hardcoded DB refs in code
grep -rl "5432/${OLD}" "${NEW_V}" --include="*.py" --include="*.ts" --include="*.sh" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=backups 2>/dev/null | while read -r f; do
  sed -i "s|5432/${OLD}|5432/${NEW}|g" "$f"
done
ok "updated DB refs in code"

# ── 5. Bulk-replace xyzo.org → xyzo.org in all code ──────────────
log "Replacing ${OLD_D} → ${NEW_D} in code files"
find "${NEW_V}" -type f \
  \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.json" \
     -o -name "*.env" -o -name "*.md" -o -name "*.sh" -o -name "*.sql" \
     -o -name "*.html" -o -name "*.css" -o -name "*.service" -o -name "*.timer" \) \
  ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/backups/*" \
  ! -path "*/.pytest_cache/*" ! -path "*/.minimax/*" ! -path "*/.artifacts/*" \
  -exec grep -l "${OLD_D}" {} \; 2>/dev/null | while read -r f; do
  sed -i "s|${OLD_D}|${NEW_D}|g" "$f"
done
ok "domain replaced in all code files"

# ── 6. Update Caddy config ──────────────────────────────────────────
log "Updating Caddy"
cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.pre-xyzo-$(date +%s)"
ok "backed up Caddyfile"

python3 << 'PYEOF'
with open("/etc/caddy/Caddyfile") as f:
    c = f.read()

old_block = """xyzo.org {
	root * /var/www/vhosts/xyzo.org/public_html
	encode zstd gzip
	file_server
	reverse_proxy /api/* localhost:3008 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
	header {
		Content-Security-Policy "frame-ancestors 'none'"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}

www.xyzo.org {
	redir https://xyzo.org{uri}
}"""

new_block = """xyzo.org {
	root * /var/www/vhosts/xyzo.org/public_html
	encode zstd gzip
	file_server
	reverse_proxy /api/* localhost:3008 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
	header {
		Content-Security-Policy "frame-ancestors 'none'"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}

www.xyzo.org {
	redir https://xyzo.org{uri}
}

# Redirect old domain → new domain
xyzo.org {
	redir https://xyzo.org{uri} permanent
}

www.xyzo.org {
	redir https://xyzo.org{uri} permanent
}"""

c = c.replace(old_block, new_block)
with open("/etc/caddy/Caddyfile", "w") as f:
    f.write(c)
print("  ✓ Caddyfile updated")
PYEOF

# ── 7. Update crontab ───────────────────────────────────────────────
log "Updating crontab"
crontab -l 2>/dev/null | sed "s|${OLD_V}|${NEW_V}|g" | crontab -
ok "crontab updated"

# ── 8. Update git remote ────────────────────────────────────────────
log "Git remote"
cd "${NEW_V}"
if git remote get-url origin 2>/dev/null | grep -q "${OLD_D}"; then
  git remote set-url origin "$(git remote get-url origin | sed "s|${OLD_D}|${NEW_D}|g")"
  ok "git remote updated"
else
  skip "no change needed"
fi

# ── 9. Reload & restart ─────────────────────────────────────────────
log "Starting services"
systemctl reload caddy 2>/dev/null && ok "caddy reloaded" || echo "  ⚠ caddy reload failed"

for f in /etc/systemd/system/${NEW}-*.service; do
  [ -f "$f" ] || continue
  n=$(basename "$f" .service)
  systemctl start "$n" 2>/dev/null && ok "started $n" || echo "  ⚠ $n failed — check: journalctl -u $n -n 20"
done
for f in /etc/systemd/system/${NEW}-*.timer; do
  [ -f "$f" ] || continue
  n=$(basename "$f" .timer)
  systemctl start "$n" 2>/dev/null && ok "timer $n started" || true
done

# ── 10. Verify ──────────────────────────────────────────────────────
log "Verification"
sleep 2
curl -sf http://localhost:3008/api/health >/dev/null 2>&1 && ok "API healthy" || echo "  ⚠ API not responding"
PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" psql -h localhost -U ${OLD}_app -d ${NEW} -c "SELECT 1;" >/dev/null 2>&1 && ok "DB accessible" || echo "  ⚠ DB not accessible as ${OLD}_app@${NEW}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Migration complete!"
echo ""
echo "  Site:    https://${NEW_D}/"
echo "  Redirect: https://${OLD_D}/ → https://${NEW_D}/"
echo "  API:     systemctl status ${NEW}-api"
echo "  DB:      psql -d ${NEW}"
echo ""
echo "  SSL: Caddy auto-provisions Let's Encrypt certs."
echo "       First request may take 30-60s."
echo "═══════════════════════════════════════════════"
