# CPU/memory hard caps for xyzo services (home-box politeness)

These are drop-in snippets for /etc/systemd/system/<unit>.d/limits.conf.
They cap TOTAL CPU so the box stays usable (login, browsing, CLI) even when
a model or sweep goes wild. 8 cores = 800% budget; caps below keep every
heavy unit under ~25% each, all of them at once under the machine's
capacity. Apply:

```bash
sudo cp deploy/systemd-limits/xyzo-*.service.d-limits.conf /tmp/  # inspect first
sudo mkdir -p /etc/systemd/system/xyzo-nn-infer.service.d
sudo tee /etc/systemd/system/xyzo-nn-infer.service.d/limits.conf <<SNIP
[Service]
CPUQuota=150%
Nice=15
MemoryMax=2G
SNIPE
# ... repeat per unit ...
sudo systemctl daemon-reload
```

Soft cap (no sudo needed): worker/load_guard.py + `health_monitor --cpu-guard`
pause pipeline cycles when load > 90% — wire into the existing watchdog cron:
`*/2 * * * * cd /var/www/vhosts/xyzo.org && python3 -m worker.health_monitor --cpu-guard --quiet`
