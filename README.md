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

Then ask Claude to run the **`hacknplan_whoami`** tool to confirm the key works.
(Restart Claude / reload the window first if it was already running.)

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

59 tools across the HacknPlan surface. Highlights:

- **Read/introspect** — `hacknplan_whoami`, `list_projects`, `get_project`,
  `list_work_items`, `get_work_item`, `list_stages`/`categories`/`tags`/
  `boards`/`milestones`/`importance_levels`.
- **Work items** — `create_work_item`, `update_work_item`, `delete_work_item`,
  `add_comment`, sub-tasks (`add_subtask`, `list_subtasks`, `update_subtask`,
  `delete_subtask`), `attach_tag`/`detach_tag`, `assign_user`/`unassign_user`.
- **Planning** — `create_project`/`update_project`/`delete_project`,
  stages, categories, tags, importance levels, `create_board`/`close_board`,
  `create_milestone`, dependencies (`add_dependency`/`remove_dependency`).
- **Time & metrics** — `log_work`, `list_work_logs`, `get_project_metrics`,
  `get_milestone_metrics`.
- **Design model** — `*_design_element` and `*_design_element_type` for the
  feature/knowledge tree.
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
