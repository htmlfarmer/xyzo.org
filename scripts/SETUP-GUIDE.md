# xyzo.org Setup & Permissions Guide

This guide covers what permissions and packages are needed so you (or AI agents) can manage everything without sudo issues.

## Recommended Setup: Give the `asher` user passwordless sudo for specific commands

This lets scripts run system commands without asking for a password every time:

```bash
sudo visudo -f /etc/sudoers.d/xyzo-asher
```

Add this line:

```
asher ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/pip3, /usr/bin/pip3 install *, /usr/bin/python3 -m *, /bin/cp, /bin/mv, /bin/rm /etc/systemd/system/*, /bin/systemctl daemon-reload
```

Save and exit. Now `sudo systemctl restart xyzo-api` and similar commands work without a password.

## Alternative: Use polkit rules

Create `/etc/polkit-1/localauthority/50-local.d/xyzo.pkla`:

```ini
[Allow asher to manage xyzo services]
Identity=unix-user:asher
Action=org.freedesktop.systemd1.manage-units;org.freedesktop.systemd1.manage-unit-files
ResultAny=yes
ResultInactive=yes
ResultActive=yes
```

## Packages to install system-wide

The main issue was that `psycopg` was installed in `/home/asher/.local/` which isn't in root's Python path. Install these **system-wide** so all users have access:

```bash
sudo pip3 install --break-system-packages \
    psycopg psycopg-binary \
    feedparser httpx \
    robotexclusionrulesparser \
    requests beautifulsoup4 \
    lxml python-dateutil pytz \
    flask flask-cors gunicorn \
    newspaper3k readability-lxml
```

These are all the Python deps the workers and API need.

## Alternative: Create a dedicated Python venv

```bash
sudo mkdir -p /opt/xyzo-venv
sudo python3 -m venv /opt/xyzo-venv
sudo /opt/xyzo-venv/bin/pip install -r /var/www/vhosts/xyzo.org/requirements.txt
```

Then update systemd services to use `/opt/xyzo-venv/bin/python3` instead of `/usr/bin/python3`.

## File Permissions

Set these so the `asher` user can edit everything:

```bash
# Make the project writable
sudo chown -R asher:asher /var/www/vhosts/xyzo.org
sudo chmod -R u+w /var/www/vhosts/xyzo.org

# Log directory
sudo mkdir -p /var/log/xyzo
sudo chown asher:asher /var/log/xyzo

# Service files (root-owned but writable by asher's group)
sudo chgrp -R asher /etc/systemd/system/xyzo-*
sudo chmod -R g+w /etc/systemd/system/xyzo-*
```

## Run the all-in-one setup

```bash
sudo bash /var/www/vhosts/xyzo.org/scripts/xyzo-full-setup.sh
```

This script:
- Installs all Python packages system-wide
- Creates log directory
- Installs all systemd units with proper User=asher setting
- Enables and starts all timers/services
- Runs health checks

## Emergency commands

```bash
# Stop everything
sudo bash /var/www/vhosts/xyzo.org/scripts/emergency-stop.sh

# Check status
bash /var/www/vhosts/xyzo.org/scripts/status.sh

# Manual run
cd /var/www/vhosts/xyzo.org
python3 -m worker.run --fast --step fetch   # Just fetch
python3 -m worker.run --step geocode --limit 100  # Geocode 100
python3 -m worker.run --step extract --limit 50    # AI extract 50
```

## Why services were failing

The systemd services run as **root** by default. But `psycopg` was installed in `/home/asher/.local/lib/python3.11/site-packages/` which is only in **asher's** Python path, not root's. So every service would crash immediately with:

```
ModuleNotFoundError: No module named 'psycopg'
```

The fix is one of:
1. Install Python packages system-wide (recommended)
2. Use a venv at a system path
3. Add `User=asher` to each service file (which the setup script does)
