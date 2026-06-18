/**
 * Bundled Claude skill: install it into the user's (or project's) skills
 * directory and keep it auto-updated.
 *
 * The canonical source is `.claude/skills/hacknplan/` in this repo. `npm run
 * build` copies it to `dist/skills/`, so the published package carries it. At
 * runtime we copy it into the chosen skills directory on `install`, and re-sync
 * it on every server launch when the running package version differs — and
 * because Claude launches the server via `npx -y @mtuska/hacknplan-mcp` (always
 * latest), that re-sync is what makes the skill auto-update.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "./version.js";

export const SKILL_NAME = "hacknplan";
const PKG = "@mtuska/hacknplan-mcp";
const MARKER = ".installed-by.json";

export type SkillScope = "global" | "project" | "local";

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Locate the bundled skill: dist/skills (prod) or the repo source (dev). */
function bundledSkillDir(): string | null {
  const candidates = [
    join(moduleDir(), "skills", SKILL_NAME), // dist/skills/<name>
    join(moduleDir(), "..", ".claude", "skills", SKILL_NAME), // repo source, via tsx
  ];
  return candidates.find((p) => existsSync(join(p, "SKILL.md"))) ?? null;
}

/** Skills live in ~/.claude/skills (global) or <cwd>/.claude/skills (project/local). */
function skillsBase(scope: SkillScope): string {
  return scope === "global"
    ? join(homedir(), ".claude", "skills")
    : join(process.cwd(), ".claude", "skills");
}

function writeMarker(dir: string): void {
  writeFileSync(
    join(dir, MARKER),
    JSON.stringify({ package: PKG, version: VERSION }, null, 2) + "\n",
  );
}

/** Copy the bundled skill into the scope's skills directory. Returns the dest dir. */
export function installSkill(scope: SkillScope): { dir: string } | null {
  const src = bundledSkillDir();
  if (!src) return null;
  const dir = join(skillsBase(scope), SKILL_NAME);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(src, dir, { recursive: true });
  writeMarker(dir);
  return { dir };
}

/**
 * Best-effort auto-update: refresh any skill copy WE installed (identified by the
 * marker) when the running package version differs. Touches nothing else, and
 * never throws — skill upkeep must not break the MCP server.
 */
export function syncInstalledSkill(): void {
  try {
    const src = bundledSkillDir();
    if (!src) return;
    const seen = new Set<string>();
    for (const base of [skillsBase("global"), skillsBase("project")]) {
      const dir = join(base, SKILL_NAME);
      if (seen.has(dir)) continue;
      seen.add(dir);
      const marker = join(dir, MARKER);
      if (!existsSync(marker)) continue;
      const meta = JSON.parse(readFileSync(marker, "utf8")) as {
        package?: string;
        version?: string;
      };
      if (meta.package !== PKG || meta.version === VERSION) continue; // not ours / current
      cpSync(src, dir, { recursive: true });
      writeMarker(dir);
    }
  } catch {
    // ignore: a failed skill sync must never affect the server
  }
}
