// /api/version — reports the deployed git commit so the front-end can
// show a friendly "code just changed, please reload" toast.
//
// We use Bun.spawnSync against the repo's own git dir. Cheap (sub-ms),
// runs on every poll, but the client only re-renders when the SHA
// actually changes — so don't bother caching server-side.

import { Hono } from "hono";
import { resolve } from "node:path";

export const versionRoute = new Hono();

interface VersionInfo {
  sha: string;
  short_sha: string;
  branch: string;
  message: string;
  committed_at: string | null;
}

function git(args: string[], cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

// Walk up from cwd until we find a directory containing `.git/`. Falls
// back to cwd if nothing found — the endpoint then returns nulls and
// the client treats that as "unknown version, skip the toast".
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const probe = Bun.spawnSync(["test", "-d", `${dir}/.git`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (probe.exitCode === 0) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

versionRoute.get("/version", async (c) => {
  const root = findRepoRoot(resolve(import.meta.dir, "../../../"));

  const sha = git(["rev-parse", "HEAD"], root);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const message = git(["log", "-1", "--pretty=%s"], root);
  const iso = git(["log", "-1", "--pretty=%cI"], root);

  if (!sha) {
    return c.json({
      sha: null,
      short_sha: null,
      branch: null,
      message: null,
      committed_at: null,
      error: "git_unavailable",
    } satisfies VersionInfo & { error: string });
  }

  return c.json({
    sha,
    short_sha: sha.slice(0, 7),
    branch: branch || null,
    message: message || null,
    committed_at: iso || null,
  } satisfies VersionInfo);
});
