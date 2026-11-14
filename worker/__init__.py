import os
import sys

# Ensure user site-packages is on sys.path regardless of which user (root, www-data, etc.)
# launches the worker processes via systemd units or scripts.
_USER_SITE = "/home/asher/.local/lib/python3.11/site-packages"
if _USER_SITE not in sys.path and os.path.isdir(_USER_SITE):
    sys.path.insert(0, _USER_SITE)

# Also ensure worker directory itself is on sys.path so bare imports (from robots import ...) succeed
_WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)
