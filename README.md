# @mtuska/hacknplan-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[HacknPlan](https://hacknplan.com) project-management API, built for use with
**Claude**. It exposes HacknPlan projects, boards, work items, sub-tasks,
dependencies, time logs, the design model, and metrics as MCP tools — plus a
**cross-project portfolio dashboard** and a **deadline schedule** view that
HacknPlan has no native equivalent for.

Pure TypeScript/Node — runs over `npx`, no Python or other runtime required.

## Quick start

```bash
npx @mtuska/hacknplan-mcp install
```

The installer will:

1. Ask **where** to register the server with Claude — _global_ (all your
   projects), _project_ (this repo, shared via `.mcp.json`), or _local_ (this
   repo, private to you).
2. Prompt for your **HacknPlan API key** (input is hidden) and store it in the
   chosen Claude MCP config.
3. Install the bundled **`hacknplan` Claude skill** into the matching skills
   directory (global → `~/.claude/skills`, project/local → `./.claude/skills`).

Then ask Claude to run the **`hacknplan_whoami`** tool to confirm the key works.
(Restart Claude / reload the window first if it was already running.)

### The bundled skill (auto-updating)

`install` drops a `hacknplan` skill that teaches Claude how to drive these tools
(id-resolution, feature breakdown, destructive-confirm rules, the portfolio /
schedule / standup views). It's part of the npm package, so on every later
server launch — which Claude runs via `npx -y @mtuska/hacknplan-mcp` (always the
latest) — the server **re-syncs the skill if the package version changed**,
keeping it current with no action from you.

The refresh only touches a skill copy this package installed (tracked by a
`.installed-by.json` marker), so your own edits to other skills are never
affected. Pass `--skip-skill` to register the MCP server without the skill.

### Getting an API key

HacknPlan → your avatar → **Settings → API → Create**. Tick the scopes you need.

## Install options

```
npx @mtuska/hacknplan-mcp install [options]

  -g, --global        Register for all projects (private, in ~/.claude.json). Default.
  -p, --project       Register for this repo only, shared via ./.mcp.json.
      --local         Register for this repo only, private to you.
      --api-key KEY   Provide the key non-interactively (else prompted / $HACKNPLAN_API_KEY).
      --name NAME     Server name to register (default: "hacknplan").
      --skip-skill    Register the MCP server only; don't install the Claude skill.
  -y, --yes           Non-interactive; use defaults and fail if the key is missing.
```

Non-interactive example (e.g. CI / dotfiles):

```bash
HACKNPLAN_API_KEY=hp_xxx npx @mtuska/hacknplan-mcp install --global -y
```

> **Project scope & secrets:** `--project` writes the key into `./.mcp.json`,
> which is typically committed. For shared repos prefer `--global`, or add
> `.mcp.json` to `.gitignore`.

The installer uses the official `claude mcp add-json` command when the Claude
Code CLI is available, and otherwise writes the MCP config file directly.

## Manual configuration

If you'd rather not use the installer, add this to your Claude MCP config
(`~/.claude.json` for global, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "hacknplan": {
      "command": "npx",
      "args": ["-y", "@mtuska/hacknplan-mcp"],
      "env": { "HACKNPLAN_API_KEY": "hp_your_key_here" }
    }
  }
}
```

### Environment variables

| Variable             | Required | Purpose                                                              |
| -------------------- | -------- | ------------------------------------------------------------------- |
| `HACKNPLAN_API_KEY`  | yes      | `Authorization: ApiKey <key>` for the HacknPlan API.                |
| `HACKNPLAN_GROUPS`   | no       | JSON map of group label → project names, for the portfolio grouping. |

```bash
HACKNPLAN_GROUPS='{"Products":["Website","Mobile App"],"Ops":["Infra"]}'
```

## Tools

75 tools across the HacknPlan surface. Highlights:

- **Read/introspect** — `hacknplan_whoami`, `list_projects`, `get_project`,
  `list_work_items` (rich server-side filters), `get_work_item`,
  `list_stages`/`categories`/`tags`/`boards`/`milestones`/`importance_levels`.
- **Search & focus** — `find_work_items` (free-text + facet search to resolve a
  task by name into its id) and `my_work` (what's assigned to you, per-project
  or across all).
- **Work items** — `create_work_item` (with story→task `parent_id`, assignees,
  dependencies, checklists), `update_work_item` (re-stage / re-prioritize /
  recategorize / re-estimate / reassign / move board·milestone), `plan_feature`
  (create a user story + child tasks + checklists in one call),
  `delete_work_item`, `add_comment`, sub-tasks, tags, user assignment.
- **Planning** — `create_project`/`update_project`/`delete_project`,
  stages, categories, tags, importance levels, boards
  (`create_board`/`update_board`/`close_board`/`reopen_board`), milestones
  (`create_milestone`/`update_milestone`/`delete_milestone`), dependencies.
- **Lifecycle** — non-destructive archive/release via
  `close_project`/`reopen_project` and `close_milestone`/`reopen_milestone`.
- **Activity & metrics** — `recent_activity` (the "what changed this week" /
  standup feed), `log_work`, `list_work_logs`, `get_project_metrics`,
  `get_milestone_metrics`, `get_board_metrics` (sprint burndown).
- **Design model** — `*_design_element`/`*_design_element_type`, plus
  `get_design_element_metrics` and design-element comments
  (`list`/`add_design_element_comment`) for the feature/knowledge tree.
- **Portfolio (cross-project)** — `portfolio_overview` (completion %, urgent /
  blocked / due-soon / overdue across all projects) and `schedule_overview` (a
  deadline countdown bucketed by horizon).

Destructive tools (`delete_*`, `remove_dependency`) require `confirm=true`.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run typecheck
npm run dev          # run the CLI from source via tsx
node dist/cli.js serve   # run the MCP server over stdio
```

## Publishing

Releases are **tag-driven** via
[.github/workflows/release.yml](.github/workflows/release.yml). Pushing a
`vX.Y.Z` tag validates that it matches `package.json`, publishes to npm, and
creates the GitHub release:

```bash
npm version patch        # bumps package.json (CLI + server read it at runtime)
git push --follow-tags
```

Publishing uses npm **Trusted Publishing** (OIDC) with provenance — **no
`NPM_TOKEN` secret**. One-time maintainer setup:

1. Publish `v0.1.0` once manually (`npm publish --access public`) to claim the
   `@mtuska/hacknplan-mcp` name.
2. On npmjs.com → the package → **Trusted Publishers**, add this repo
   (`mtuska/hacknplan-mcp`) and the workflow filename (`release.yml`).

After that, every tag-driven release publishes with provenance and no
long-lived token. Users can verify with `npm audit signatures`.

## License

MIT © Montana Tuska
