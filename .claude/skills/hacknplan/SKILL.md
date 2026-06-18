---
name: hacknplan
description: Manage HacknPlan projects, boards, sprints, milestones, and work items (tasks/user stories) through the HacknPlan MCP tools. Use whenever the user wants to view, search, create, update, organize, estimate, assign, or track project-management work in HacknPlan — including breaking a feature into tasks, checking what's due or overdue, a standup/portfolio overview, or "what am I working on".
---

# HacknPlan project management

This skill drives the `@mtuska/hacknplan-mcp` server. Its tools wrap the HacknPlan
API v0. Prefer these tools over guessing; HacknPlan is **id-driven**, so resolve
names to ids first.

## Orientation (do this before acting)

1. `hacknplan_whoami` — confirm the API key works (run once if unsure).
2. `list_projects` — get project ids.
3. `get_project` — one call that rolls up a project's **stages, categories,
   importance levels, and boards**. You almost always need this before creating
   or moving work items, because creates require ids from it.

## Resolving names → ids

The user will say "move the *Login bug* to Done", not give ids. Resolve first:

- `find_work_items(project_id, query, …)` — free-text + facet search; the fastest
  way to turn a remembered title into a `workItemId`. Use its result's id with
  `update_work_item` / `get_work_item` / etc.
- For stages/categories/importance/tags, read them from `get_project` (or the
  `list_*` tools) and match by name to get the id.

## Common workflows

- **Create a task or story** — `create_work_item`. Requires `title` +
  `importance_level_id`; tasks also need `category_id`. New items land in the
  first stage — pass `stage_id` to place them elsewhere. Use `parent_id` to nest
  a task under a user story.
- **Break a feature down** — `plan_feature` creates a user story plus its child
  tasks (and optional per-task checklists) in **one call**. Prefer it over many
  `create_work_item` calls.
- **Move / edit a work item** — `update_work_item`. It can re-stage, retitle,
  re-prioritize (`importance_level_id`), recategorize, re-estimate
  (`estimated_cost`), set due/start dates, block/unblock, retag, reassign
  (`assigned_user_ids` replaces the whole set), and move board/milestone. Send
  only the fields you're changing.
- **Checklists** — `add_subtask` / `list_subtasks` / `update_subtask`
  (set `is_completed`).
- **Comments, tags, assignment** — `add_comment`, `attach_tag`/`detach_tag`,
  `assign_user`/`unassign_user`.
- **Dependencies** — `add_dependency` (successor blocked by predecessor),
  `list_dependencies`, `remove_dependency`.
- **Time tracking** — `log_work`, `list_work_logs`.

## Overviews & status (read-only)

- `portfolio_overview` — cross-project birds-eye: completion %, urgent / blocked /
  due-soon / overdue. Use for "how's everything doing".
- `schedule_overview` — every dated item bucketed by horizon (overdue → later).
  Use for "what's due soon / this week / overdue".
- `my_work` — items assigned to the authenticated user. Use for "what am I working
  on". (Relies on assignees being returned inline by the list endpoint.)
- `recent_activity` — the project event feed (defaults to the last 7 days). Use for
  standups / "what changed".
- Metrics: `get_project_metrics`, `get_milestone_metrics`, `get_board_metrics`.

## Lifecycle

Closing is **non-destructive** (archive/release) and reversible — prefer it over
deleting: `close_project`/`reopen_project`, `close_milestone`/`reopen_milestone`,
`close_board`/`reopen_board`.

## Rules & gotchas

- **Destructive tools require `confirm=true`** (`delete_*`, `remove_dependency`).
  Never pass `confirm=true` unless the user clearly asked to delete; otherwise
  surface the refusal and ask.
- **`cost_metric`** is the capitalized string `"Hours"` or `"Points"`.
- **Stage `status`** is lowercase: `created` | `started` | `completed` (and
  `closed` when updating). Creating a stage needs both a `color` and an `icon`.
- **Dates** are ISO 8601 (e.g. `2026-06-30T00:00:00Z`).
- Lists/searches are bounded and paginated — narrow with filters or `format:
  "concise"` rather than dumping everything.
- On a 400, re-check ids and the body rules above; on 401, the API key is wrong.
