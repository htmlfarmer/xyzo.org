# XYZO Development Workflow

## Architecture

```
PRODUCTION (xyzo.org)              NOVA (nova.xyzo.org)
├── public_html/                   ├── public_html_dev/
├── api/src/ (port 3008)           └── same API (port 3008)
└── PostgreSQL (shared)
```

**Both share the same database.** No duplication needed — migrations are idempotent.

## Golden Rule

> **If the site is working well, don't touch production.**
> Edit nova → test → deploy.
>
> **Exception:** Critical fixes (site broken, pins missing, errors flooding)
> can go straight to production — but always sync to nova after.

## Quick Start

```bash
# 1. Edit files in public_html_dev/
# 2. Test at https://nova.xyzo.org
# 3. Deploy when ready
./deploy.sh --full
```

## Development Flow

```
Edit code → Test on nova.xyzo.org → Validate → Deploy → Verify
     ↓              ↓                  ↓           ↓          ↓
  public_html_dev  browser           validate.sh  deploy.sh  xyzo.org
  or api/src/      nova.xyzo.org     (auto)       (auto)     (live)
```

## Commands

| Command | What it does |
|---|---|
| `./deploy.sh` | Deploy frontend only |
| `./deploy.sh --full` | Deploy frontend + restart API |
| `./deploy.sh --dry-run` | Preview what would change |
| `./deploy.sh --rollback` | Revert to previous version |
| `./website.sh https://xyzo.org` | Run full site audit |

## File Locations

| Purpose | Production | Nova |
|---|---|---|
| Frontend JS | `public_html/app.js` | `public_html_dev/app.js` |
| Frontend CSS | `public_html/styles.css` | `public_html_dev/styles.css` |
| Frontend HTML | `public_html/index.html` | `public_html_dev/index.html` |
| API server | `api/src/` (shared) | `api/src/` (shared) |
| Database | PostgreSQL (shared) | PostgreSQL (shared) |

## Safety Features

1. **Pre-deploy validation** — `validate-api.sh` runs automatically before any deploy
2. **Backup** — Current production is backed up before each deploy
3. **Health check** — Post-deploy verification ensures API is responding
4. **Pin smoke test** — Verifies pins are actually being returned
5. **Dry run** — Preview changes without applying them
6. **Rollback** — Revert to backup if something breaks

## What NOT to Do

- ❌ Edit `public_html/app.js` for feature work (use nova)
- ❌ Deploy without running `validate-api.sh`
- ❌ Skip the backup step in `deploy.sh`
- ❌ Make "while I'm here" changes to production

## When It's OK to Edit Production Directly

- Site is broken (pins missing, errors flooding, pages 500)
- One-line hotfix that can't wait for the nova → deploy cycle
- After fixing: always sync the change back to `public_html_dev/`

## Database Notes

- Dev and prod share the same PostgreSQL database
- Schema migrations are idempotent (`CREATE TABLE IF NOT EXISTS`)
- Adding columns is safe (additive only)
- **NEVER** drop columns or tables in production without a migration plan
- **NEVER** modify the `news_sources` or `news_articles` tables without understanding the fetch pipeline

## Adding New Features

1. Create the feature in `api/src/routes/` and `public_html_dev/`
2. Test on `https://xyzo.org/nova`
3. Run `./website.sh https://xyzo.org/nova` for full audit
4. Run `./deploy.sh --dry-run` to preview
5. Run `./deploy.sh --full` to deploy
6. Verify `https://xyzo.org` works
