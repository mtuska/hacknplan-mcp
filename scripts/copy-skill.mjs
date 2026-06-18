// Copies the canonical skill source (.claude/skills) into dist/skills so it
// ships inside the npm package (dist is in package.json "files"). Run after tsc.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, ".claude", "skills");
const dest = join(root, "dist", "skills");

if (!existsSync(src)) {
  console.warn("[copy-skill] no .claude/skills to copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-skill] ${src} -> ${dest}`);
