#!/usr/bin/env node
/**
 * @mtuska/hacknplan-mcp CLI.
 *
 *   npx @mtuska/hacknplan-mcp install   # register the server with Claude + store the API key
 *   npx @mtuska/hacknplan-mcp serve     # run the MCP server over stdio (default)
 *
 * With no command (how Claude launches it) it runs the server.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { serve } from "./index.js";
import { installSkill, type SkillScope } from "./skill.js";
import { VERSION } from "./version.js";

const PKG_NAME = "@mtuska/hacknplan-mcp";
const SERVER_KEY = "hacknplan";

type Scope = "project" | "global" | "local";

interface InstallOpts {
  scope?: Scope;
  apiKey?: string;
  name: string;
  yes: boolean;
  skipSkill: boolean;
}

// ----------------------------- arg parsing -----------------------------

function parseInstallArgs(argv: string[]): InstallOpts {
  const opts: InstallOpts = { name: SERVER_KEY, yes: false, skipSkill: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--skip-skill":
      case "--no-skill":
        opts.skipSkill = true;
        break;
      case "-g":
      case "--global":
      case "--user":
        opts.scope = "global";
        break;
      case "-p":
      case "--project":
        opts.scope = "project";
        break;
      case "--local":
        opts.scope = "local";
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--api-key":
        opts.apiKey = argv[++i];
        break;
      case "--name":
        opts.name = argv[++i] ?? SERVER_KEY;
        break;
      default:
        if (a.startsWith("--api-key=")) opts.apiKey = a.slice("--api-key=".length);
        else if (a.startsWith("--name=")) opts.name = a.slice("--name=".length);
        else throw new Error(`Unknown option for install: ${a}`);
    }
  }
  return opts;
}

// ----------------------------- prompts -----------------------------

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => (rl.close(), res(ans.trim()))));
}

/** Read a line without echoing it (for the API key). Falls back to plain read when not a TTY. */
function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mask everything the user types.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    const orig = out._writeToOutput.bind(out);
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (muted) {
        if (s.includes("\n") || s.includes("\r")) orig(s);
      } else orig(s);
    };
    process.stdout.write(question);
    muted = true;
    rl.question("", (ans) => {
      out._writeToOutput = orig;
      process.stdout.write("\n");
      rl.close();
      res(ans.trim());
    });
  });
}

// ----------------------------- install -----------------------------

function serverEntry(apiKey: string): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", PKG_NAME],
    env: { HACKNPLAN_API_KEY: apiKey },
  };
}

function claudeScope(scope: Scope): "user" | "project" | "local" {
  return scope === "global" ? "user" : scope;
}

/** Prefer the official `claude mcp add-json`; returns true on success. */
function tryClaudeCli(name: string, scope: Scope, apiKey: string): boolean {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return false;

  // Remove any existing entry so re-running install is idempotent (ignore failures).
  spawnSync("claude", ["mcp", "remove", name, "-s", claudeScope(scope)], { stdio: "ignore" });

  const json = JSON.stringify(serverEntry(apiKey));
  const r = spawnSync("claude", ["mcp", "add-json", name, json, "-s", claudeScope(scope)], {
    stdio: "inherit",
  });
  return !r.error && r.status === 0;
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`Existing config at ${path} is not valid JSON; fix or remove it first.`);
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Fallback: write the Claude config files directly when the CLI is unavailable. */
function writeConfigDirectly(name: string, scope: Scope, apiKey: string): string {
  const entry = serverEntry(apiKey);

  if (scope === "project") {
    const path = resolve(process.cwd(), ".mcp.json");
    const cfg = readJsonFile(path);
    const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
    servers[name] = entry;
    writeJsonFile(path, cfg);
    return path;
  }

  const path = join(homedir(), ".claude.json");
  const cfg = readJsonFile(path);
  if (scope === "global") {
    const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
    servers[name] = entry;
  } else {
    // local: scoped to the current project inside the user's config.
    const projects = (cfg.projects ??= {}) as Record<string, Record<string, unknown>>;
    const proj = (projects[process.cwd()] ??= {});
    const servers = (proj.mcpServers ??= {}) as Record<string, unknown>;
    servers[name] = entry;
  }
  writeJsonFile(path, cfg);
  return path;
}

async function runInstall(argv: string[]): Promise<void> {
  const opts = parseInstallArgs(argv);

  // 1. Scope
  let scope = opts.scope;
  if (!scope) {
    if (opts.yes || !process.stdin.isTTY) {
      scope = "global"; // safe default: private, all-projects
    } else {
      console.log("\nWhere should the HacknPlan MCP server be registered for Claude?");
      console.log("  1) global  — all your projects (stored privately in ~/.claude.json) [default]");
      console.log("  2) project — this repo only, shared via ./.mcp.json (key is written into it)");
      console.log("  3) local   — this repo only, private to you");
      const choice = (await ask("Choose [1/2/3]: ")) || "1";
      scope = choice === "2" ? "project" : choice === "3" ? "local" : "global";
    }
  }

  // 2. API key
  let apiKey = opts.apiKey ?? process.env.HACKNPLAN_API_KEY ?? "";
  if (!apiKey) {
    if (opts.yes || !process.stdin.isTTY) {
      throw new Error(
        "No API key provided. Pass --api-key <key> or set HACKNPLAN_API_KEY for non-interactive install.",
      );
    }
    console.log(
      "\nEnter your HacknPlan API key (HacknPlan → avatar → Settings → API → Create).",
    );
    apiKey = await askHidden("HACKNPLAN_API_KEY: ");
  }
  if (!apiKey) throw new Error("An API key is required.");

  if (scope === "project") {
    console.log(
      "\n⚠  Project scope writes the API key into ./.mcp.json. If this repo is shared,\n" +
        "   add `.mcp.json` to .gitignore or use `--global` instead.",
    );
  }

  // 3. Register
  let location: string;
  if (tryClaudeCli(opts.name, scope, apiKey)) {
    location = `Claude (${claudeScope(scope)} scope, via claude CLI)`;
  } else {
    const path = writeConfigDirectly(opts.name, scope, apiKey);
    location = path;
  }

  console.log(`\n✓ Registered "${opts.name}" → ${location}`);

  // 4. Install the bundled Claude skill into the same scope (global → user skills,
  //    project/local → ./.claude/skills). It auto-updates on later server launches.
  if (!opts.skipSkill) {
    try {
      const res = installSkill(scope as SkillScope);
      if (res) console.log(`✓ Installed skill "hacknplan" → ${res.dir} (auto-updates)`);
      else console.log("• Skill source not found in this build; skipped skill install.");
    } catch (e) {
      console.log(`• Could not install the skill (${e instanceof Error ? e.message : e}); MCP server is still registered.`);
    }
  }

  console.log("✓ Verify the API key works by asking Claude to run the `hacknplan_whoami` tool.");
  if (scope !== "project") {
    console.log("  (Restart Claude / reload the window if it was already running.)");
  }
}

// ----------------------------- help -----------------------------

function printHelp(): void {
  console.log(`${PKG_NAME} v${VERSION}

A Model Context Protocol server for the HacknPlan project-management API.

Usage:
  npx ${PKG_NAME} <command> [options]

Commands:
  install     Register the server with Claude, store your API key, and install
              the bundled "hacknplan" Claude skill (auto-updates on later runs).
  serve       Run the MCP server over stdio (this is the default with no command).
  help        Show this help.

Install options:
  -g, --global        Register for all projects (private, in ~/.claude.json). Default.
  -p, --project       Register for this repo only, shared via ./.mcp.json.
      --local         Register for this repo only, private to you.
      --api-key KEY   Provide the API key non-interactively (else prompted / $HACKNPLAN_API_KEY).
      --name NAME     Server name to register (default: "${SERVER_KEY}").
      --skip-skill    Don't install the Claude skill (register the MCP server only).
  -y, --yes           Non-interactive; use defaults and fail if the key is missing.

Examples:
  npx ${PKG_NAME} install
  npx ${PKG_NAME} install --global --api-key hp_xxx
  HACKNPLAN_API_KEY=hp_xxx npx ${PKG_NAME} install --project -y
`);
}

// ----------------------------- main -----------------------------

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "serve":
    case "start":
      await serve();
      return;
    case "install":
      await runInstall(rest);
      return;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
