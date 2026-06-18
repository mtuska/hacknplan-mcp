/**
 * HacknPlan MCP server.
 *
 * Wraps the HacknPlan API v0 and adds a cross-project portfolio dashboard.
 * Reads credentials from the environment:
 *   HACKNPLAN_API_KEY   (required)  — `Authorization: ApiKey <key>`
 *   HACKNPLAN_GROUPS    (optional)  — JSON map for portfolio grouping
 *
 * Tool design is workflow-oriented: names-over-ids where practical, bounded
 * high-signal output, actionable errors.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { HacknPlanClient, HacknPlanError } from "./client.js";
import { asJson, formatList, type Rec } from "./formatting.js";
import { portfolio, toMarkdown, toScheduleMarkdown } from "./portfolio.js";
import { VERSION } from "./version.js";

const FORMAT = z
  .enum(["concise", "detailed", "json"])
  .default("concise")
  .describe("Output format: 'concise' | 'detailed' | 'json'.");

/** Turn an exception into an actionable, LLM-friendly message. */
function errMsg(e: unknown): string {
  if (e instanceof HacknPlanError) {
    let hint = "";
    if (e.status === 400) {
      hint =
        " — body schema mismatch. Note: project costMetric must be the STRING" +
        " 'Hours' or 'Points'; stage status must be 'created'/'started'/'completed'" +
        " (lowercase); work items require title+isStory+estimatedCost+importanceLevelId.";
    } else if (e.status === 401) {
      hint = " — check HACKNPLAN_API_KEY.";
    } else if (e.status === 404) {
      hint = " — id not found (404 bodies are empty).";
    } else if (e.status === 429) {
      hint = " — rate limited (5 req/s); retried automatically, still failing.";
    }
    return `HacknPlan API error: ${e.message}${hint}`;
  }
  const name = e instanceof Error ? e.name : typeof e;
  const msg = e instanceof Error ? e.message : String(e);
  return `Error: ${name}: ${msg}`;
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Build the MCP server and register every tool against the given client. */
export function buildServer(hp: HacknPlanClient): McpServer {
  const server = new McpServer(
    { name: "hacknplan", version: VERSION },
    { capabilities: { tools: {} } },
  );

  const list = HacknPlanClient.asList;

  /** Register a tool whose handler returns a string; errors are formatted uniformly. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ): void {
    const cb = async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return textResult(await handler(args));
      } catch (e) {
        return textResult(errMsg(e));
      }
    };
    // The SDK validates args against `schema` before calling back; the cast just
    // bridges our uniform string-returning handler to its generic callback type.
    server.registerTool(name, { description, inputSchema: schema }, cb as never);
  }

  // ===================== READ / INTROSPECT =====================

  tool(
    "hacknplan_whoami",
    "Return the authenticated HacknPlan user (id, username, email, name). Use first to confirm the API key works.",
    {},
    async () => asJson(await hp.get("/users/me")),
  );

  tool(
    "list_workspaces",
    "List HacknPlan workspaces visible to the API key. NOTE: Personal/Personal-Plus accounts return an empty list even though a 'Personal workspace' exists in the web UI — projects still work and are auto-assigned to it. Only Studio workspaces appear here.",
    {},
    async () => formatList(list(await hp.get("/workspaces")), "workspaces"),
  );

  tool(
    "list_projects",
    "List all HacknPlan projects.",
    { format: FORMAT },
    async ({ format }) => formatList(list(await hp.get("/projects")), "projects", format),
  );

  tool(
    "get_project",
    "Get one project with its stages, categories, importance levels and boards rolled up — the structural overview you need before creating work items.",
    { project_id: z.number().int() },
    async ({ project_id }) => {
      const base = `/projects/${project_id}`;
      return asJson({
        project: await hp.get(base),
        stages: list(await hp.get(`${base}/stages`)),
        categories: list(await hp.get(`${base}/categories`)),
        importanceLevels: list(await hp.get(`${base}/importancelevels`)),
        boards: list(await hp.get(`${base}/boards`)),
      });
    },
  );

  tool(
    "list_stages",
    "List a project's stages (kanban columns). status is created|started|completed.",
    { project_id: z.number().int(), format: FORMAT },
    async ({ project_id, format }) =>
      formatList(list(await hp.get(`/projects/${project_id}/stages`)), "stages", format),
  );

  tool(
    "list_categories",
    "List a project's work-item categories.",
    { project_id: z.number().int(), format: FORMAT },
    async ({ project_id, format }) =>
      formatList(list(await hp.get(`/projects/${project_id}/categories`)), "categories", format),
  );

  tool(
    "list_tags",
    "List a project's tags.",
    { project_id: z.number().int(), format: FORMAT },
    async ({ project_id, format }) =>
      formatList(list(await hp.get(`/projects/${project_id}/tags`)), "tags", format),
  );

  tool(
    "list_boards",
    "List a project's boards (sprints/kanban boards). The default is 'Sprint 1'. Closed boards are hidden unless include_closed=true.",
    { project_id: z.number().int(), include_closed: z.boolean().default(false), format: FORMAT },
    async ({ project_id, include_closed, format }) =>
      formatList(
        list(await hp.get(`/projects/${project_id}/boards`, { includeClosed: include_closed })),
        "boards",
        format,
      ),
  );

  tool(
    "list_milestones",
    "List a project's milestones (release/epic groupings). Closed milestones are hidden unless include_closed=true.",
    { project_id: z.number().int(), include_closed: z.boolean().default(false), format: FORMAT },
    async ({ project_id, include_closed, format }) =>
      formatList(
        list(
          await hp.get(`/projects/${project_id}/milestones`, { includeClosed: include_closed }),
        ),
        "milestones",
        format,
      ),
  );

  tool(
    "list_work_items",
    "List/search a project's work items with server-side filters. All filters are optional and AND-combined: board_id, stage_id, category_id, milestone_id, importance_level_id, tag_id, design_element_id, assigned_user_id, is_story, status ('open'|'closed'), text (free-text match). Paginated via limit/offset. For a forgiving name-based search that also works if a filter is unsupported, use find_work_items.",
    {
      project_id: z.number().int(),
      board_id: z.number().int().optional(),
      stage_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      milestone_id: z.number().int().optional(),
      importance_level_id: z.number().int().optional(),
      tag_id: z.number().int().optional(),
      design_element_id: z.number().int().optional(),
      assigned_user_id: z.number().int().optional(),
      is_story: z.boolean().optional(),
      status: z.enum(["open", "closed"]).optional(),
      text: z.string().optional(),
      limit: z.number().int().default(50),
      offset: z.number().int().default(0),
      format: FORMAT,
    },
    async (a) => {
      const params: Record<string, unknown> = { limit: a.limit, offset: a.offset };
      if (a.board_id !== undefined) params.boardId = a.board_id;
      if (a.stage_id !== undefined) params.stageId = a.stage_id;
      if (a.category_id !== undefined) params.categoryId = a.category_id;
      if (a.milestone_id !== undefined) params.milestoneId = a.milestone_id;
      if (a.importance_level_id !== undefined) params.importanceLevelId = a.importance_level_id;
      if (a.tag_id !== undefined) params.tagId = a.tag_id;
      if (a.design_element_id !== undefined) params.designElementId = a.design_element_id;
      if (a.assigned_user_id !== undefined) params.assignedUsers = a.assigned_user_id;
      if (a.is_story !== undefined) params.isStory = a.is_story;
      if (a.status !== undefined) params.status = a.status;
      if (a.text !== undefined) params.text = a.text;
      const resp = await hp.get(`/projects/${a.project_id}/workitems`, params);
      return formatList(list(resp), "work items", a.format);
    },
  );

  tool(
    "get_work_item",
    "Get one work item with its sub-tasks (checklist) and comments.",
    { project_id: z.number().int(), work_item_id: z.number().int() },
    async ({ project_id, work_item_id }) => {
      const base = `/projects/${project_id}/workitems/${work_item_id}`;
      return asJson({
        workItem: await hp.get(base),
        subTasks: list(await hp.get(`${base}/subtasks`)),
        comments: list(await hp.get(`${base}/comments`)),
      });
    },
  );

  // ===================== WRITE / WORKFLOW =====================

  tool(
    "create_project",
    'Create a project. cost_metric is the STRING "Hours" or "Points" (capitalized). workspaceId is auto-assigned to your personal workspace (echoed back as 0). Returns the new project.',
    {
      name: z.string(),
      cost_metric: z.enum(["Hours", "Points"]).default("Hours"),
      hours_per_day: z.number().default(8),
      description: z.string().default(""),
    },
    async ({ name, cost_metric, hours_per_day, description }) => {
      const body: Rec = { name, costMetric: cost_metric, hoursPerDay: hours_per_day };
      if (description) body.description = description;
      return asJson(await hp.post("/projects", body));
    },
  );

  tool(
    "create_stage",
    "Create a kanban stage. status must be one of (lowercase): created | started | completed. Both color AND icon are required by the API (omitting icon returns HTTP 500); icon is a HacknPlan icon name (e.g. inbox, wrench, check, rocket, eye, ban).",
    {
      project_id: z.number().int(),
      name: z.string(),
      status: z.enum(["created", "started", "completed"]).default("created"),
      color: z.string().default("#3498db"),
      icon: z.string().default("inbox"),
      is_unblocker: z.boolean().default(false),
    },
    async ({ project_id, name, status, color, icon, is_unblocker }) =>
      asJson(
        await hp.post(`/projects/${project_id}/stages`, {
          name,
          status,
          isUnblocker: is_unblocker,
          color,
          icon,
        }),
      ),
  );

  tool(
    "create_category",
    "Create a work-item category.",
    { project_id: z.number().int(), name: z.string(), color: z.string().default("#3498db") },
    async ({ project_id, name, color }) =>
      asJson(await hp.post(`/projects/${project_id}/categories`, { name, color })),
  );

  tool(
    "create_tag",
    "Create a tag (label).",
    { project_id: z.number().int(), name: z.string(), color: z.string().default("#b3bac5") },
    async ({ project_id, name, color }) =>
      asJson(
        await hp.post(`/projects/${project_id}/tags`, { name, color, displayIconOnly: false }),
      ),
  );

  tool(
    "create_milestone",
    "Create a milestone. due_date is ISO 8601 (e.g. '2026-06-30T00:00:00Z').",
    {
      project_id: z.number().int(),
      name: z.string(),
      due_date: z.string().default(""),
      general_info: z.string().default(""),
    },
    async ({ project_id, name, due_date, general_info }) => {
      const body: Rec = { name };
      if (due_date) body.dueDate = due_date;
      if (general_info) body.generalInfo = general_info;
      return asJson(await hp.post(`/projects/${project_id}/milestones`, body));
    },
  );

  tool(
    "create_work_item",
    "Create a work item (task or user story). Required: title + importance_level_id (get it from get_project/list_*). category_id is required for tasks (not user stories). parent_id nests this item under a user story (the story→task hierarchy). assigned_user_ids assigns members; dependency_ids makes it blocked-by those items. sub_tasks is a list of checklist item titles. due_date/start_date are ISO 8601. If stage_id is given, the item is moved to that stage after creation (the API always creates new items in the default/first stage).",
    {
      project_id: z.number().int(),
      title: z.string(),
      importance_level_id: z.number().int(),
      category_id: z.number().int().optional(),
      description: z.string().default(""),
      estimated_cost: z.number().default(0),
      is_story: z.boolean().default(false),
      parent_id: z.number().int().optional(),
      board_id: z.number().int().optional(),
      start_date: z.string().default(""),
      due_date: z.string().default(""),
      tag_ids: z.array(z.number().int()).optional(),
      assigned_user_ids: z.array(z.number().int()).optional(),
      dependency_ids: z.array(z.number().int()).optional(),
      sub_tasks: z.array(z.string()).optional(),
      stage_id: z.number().int().optional(),
    },
    async (a) => {
      const body: Rec = {
        title: a.title,
        isStory: a.is_story,
        estimatedCost: a.estimated_cost,
        importanceLevelId: a.importance_level_id,
      };
      if (a.category_id !== undefined && !a.is_story) body.categoryId = a.category_id;
      if (a.description) body.description = a.description;
      if (a.parent_id !== undefined) body.parentId = a.parent_id;
      if (a.board_id !== undefined) body.boardId = a.board_id;
      if (a.start_date) body.startDate = a.start_date;
      if (a.due_date) body.dueDate = a.due_date;
      if (a.tag_ids?.length) body.tagIds = a.tag_ids;
      if (a.assigned_user_ids?.length) body.assignedUserIds = a.assigned_user_ids;
      if (a.dependency_ids?.length) body.dependencyIds = a.dependency_ids;
      if (a.sub_tasks?.length) body.subTasks = a.sub_tasks;
      let wi = (await hp.post(`/projects/${a.project_id}/workitems`, body)) as Rec;
      if (a.stage_id !== undefined) {
        wi = (await hp.patch(`/projects/${a.project_id}/workitems/${wi.workItemId}`, {
          stageId: a.stage_id,
        })) as Rec;
      }
      return asJson(wi);
    },
  );

  tool(
    "update_work_item",
    "Partially update a work item: move stage, retitle, edit description, set start/due date, block/unblock, retag, re-prioritize (importance_level_id), recategorize (category_id), re-estimate (estimated_cost), move board/milestone, re-parent, or reassign (assigned_user_ids replaces the whole assignee set). Provide only the fields you want to change.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      stage_id: z.number().int().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      start_date: z.string().optional(),
      due_date: z.string().optional(),
      is_blocked: z.boolean().optional(),
      tag_ids: z.array(z.number().int()).optional(),
      importance_level_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      estimated_cost: z.number().optional(),
      board_id: z.number().int().optional(),
      milestone_id: z.number().int().optional(),
      parent_id: z.number().int().optional(),
      assigned_user_ids: z.array(z.number().int()).optional(),
    },
    async (a) => {
      const body: Rec = {};
      if (a.stage_id !== undefined) body.stageId = a.stage_id;
      if (a.title !== undefined) body.title = a.title;
      if (a.description !== undefined) body.description = a.description;
      if (a.start_date !== undefined) body.startDate = a.start_date;
      if (a.due_date !== undefined) body.dueDate = a.due_date;
      if (a.is_blocked !== undefined) body.isBlocked = a.is_blocked;
      if (a.tag_ids !== undefined) body.tagIds = a.tag_ids;
      if (a.importance_level_id !== undefined) body.importanceLevelId = a.importance_level_id;
      if (a.category_id !== undefined) body.categoryId = a.category_id;
      if (a.estimated_cost !== undefined) body.estimatedCost = a.estimated_cost;
      if (a.board_id !== undefined) body.boardId = a.board_id;
      if (a.milestone_id !== undefined) body.milestoneId = a.milestone_id;
      if (a.parent_id !== undefined) body.parentId = a.parent_id;
      if (a.assigned_user_ids !== undefined) body.assignedUserIds = a.assigned_user_ids;
      if (!Object.keys(body).length) return "Error: provide at least one field to update.";
      return asJson(await hp.patch(`/projects/${a.project_id}/workitems/${a.work_item_id}`, body));
    },
  );

  tool(
    "add_subtask",
    "Add one sub-task (checklist item) to a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int(), title: z.string() },
    async ({ project_id, work_item_id, title }) =>
      asJson(await hp.post(`/projects/${project_id}/workitems/${work_item_id}/subtasks`, title)),
  );

  tool(
    "add_comment",
    "Add a comment to a work item (markdown supported, max 5000 chars).",
    { project_id: z.number().int(), work_item_id: z.number().int(), text: z.string() },
    async ({ project_id, work_item_id, text }) =>
      asJson(
        await hp.post(
          `/projects/${project_id}/workitems/${work_item_id}/comments`,
          text.slice(0, 5000),
        ),
      ),
  );

  tool(
    "delete_work_item",
    "Delete a work item. Destructive — set confirm=true to proceed.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, work_item_id, confirm }) => {
      if (!confirm) return "Refused: deletion is destructive. Re-call with confirm=true to delete.";
      await hp.delete(`/projects/${project_id}/workitems/${work_item_id}`);
      return `Deleted work item ${work_item_id}.`;
    },
  );

  tool(
    "delete_project",
    "Delete an ENTIRE project and everything in it. Destructive — set confirm=true.",
    { project_id: z.number().int(), confirm: z.boolean().default(false) },
    async ({ project_id, confirm }) => {
      if (!confirm)
        return "Refused: deleting a project removes ALL its work items, stages, etc. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}`);
      return `Deleted project ${project_id}.`;
    },
  );

  // ===================== MASTER DATA: UPDATE / DELETE =====================

  tool(
    "update_stage",
    "Update a kanban stage (re-name / re-color / re-icon / change status). status: created | started | closed (lowercase). color is hex; icon is a HacknPlan icon name (e.g. inbox, wrench, check, rocket, eye, ban).",
    {
      project_id: z.number().int(),
      stage_id: z.number().int(),
      name: z.string(),
      status: z.enum(["created", "started", "closed"]),
      is_unblocker: z.boolean().default(false),
      color: z.string().optional(),
      icon: z.string().optional(),
    },
    async (a) => {
      const body: Rec = { name: a.name, status: a.status, isUnblocker: a.is_unblocker };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(await hp.patch(`/projects/${a.project_id}/stages/${a.stage_id}`, body));
    },
  );

  tool(
    "delete_stage",
    "Delete a stage. Destructive (a project needs >=3 stages, one per status). confirm=true required.",
    { project_id: z.number().int(), stage_id: z.number().int(), confirm: z.boolean().default(false) },
    async ({ project_id, stage_id, confirm }) => {
      if (!confirm) return "Refused: deleting a stage is destructive. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/stages/${stage_id}`);
      return `Deleted stage ${stage_id}.`;
    },
  );

  tool(
    "update_category",
    "Update a work-item category (re-name / re-color / re-icon).",
    {
      project_id: z.number().int(),
      category_id: z.number().int(),
      name: z.string(),
      color: z.string().optional(),
      icon: z.string().optional(),
    },
    async (a) => {
      const body: Rec = { name: a.name };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(await hp.patch(`/projects/${a.project_id}/categories/${a.category_id}`, body));
    },
  );

  tool(
    "delete_category",
    "Delete a work-item category. Destructive. confirm=true required. (Useful to remove the game-dev defaults — Audio, Narrative, etc.)",
    {
      project_id: z.number().int(),
      category_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, category_id, confirm }) => {
      if (!confirm) return "Refused: deleting a category is destructive. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/categories/${category_id}`);
      return `Deleted category ${category_id}.`;
    },
  );

  tool(
    "update_tag",
    "Update a tag (re-name / re-color / re-icon / toggle icon-only display).",
    {
      project_id: z.number().int(),
      tag_id: z.number().int(),
      name: z.string(),
      color: z.string().optional(),
      display_icon_only: z.boolean().default(false),
      icon: z.string().optional(),
    },
    async (a) => {
      const body: Rec = { name: a.name, displayIconOnly: a.display_icon_only };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(await hp.patch(`/projects/${a.project_id}/tags/${a.tag_id}`, body));
    },
  );

  tool(
    "delete_tag",
    "Delete a tag. Destructive (removes it from all work items). confirm=true required.",
    { project_id: z.number().int(), tag_id: z.number().int(), confirm: z.boolean().default(false) },
    async ({ project_id, tag_id, confirm }) => {
      if (!confirm) return "Refused: deleting a tag is destructive. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/tags/${tag_id}`);
      return `Deleted tag ${tag_id}.`;
    },
  );

  tool(
    "list_importance_levels",
    "List a project's importance/priority levels (Urgent/High/Normal/Low by default).",
    { project_id: z.number().int(), format: FORMAT },
    async ({ project_id, format }) =>
      formatList(
        list(await hp.get(`/projects/${project_id}/importancelevels`)),
        "importanceLevels",
        format,
      ),
  );

  tool(
    "create_importance_level",
    "Create an importance/priority level (color+icon).",
    {
      project_id: z.number().int(),
      name: z.string(),
      color: z.string().optional(),
      icon: z.string().optional(),
      is_default: z.boolean().default(false),
    },
    async (a) => {
      const body: Rec = { name: a.name, isDefault: a.is_default };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(await hp.post(`/projects/${a.project_id}/importancelevels`, body));
    },
  );

  tool(
    "update_importance_level",
    "Update an importance level (re-name / re-color / re-icon / set default).",
    {
      project_id: z.number().int(),
      importance_level_id: z.number().int(),
      name: z.string(),
      color: z.string().optional(),
      icon: z.string().optional(),
      is_default: z.boolean().default(false),
    },
    async (a) => {
      const body: Rec = { name: a.name, isDefault: a.is_default };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(
        await hp.patch(
          `/projects/${a.project_id}/importancelevels/${a.importance_level_id}`,
          body,
        ),
      );
    },
  );

  // ===================== TAGS / USERS ON A WORK ITEM =====================

  tool(
    "attach_tag",
    "Attach an existing tag to a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int(), tag_id: z.number().int() },
    async ({ project_id, work_item_id, tag_id }) => {
      await hp.post(`/projects/${project_id}/workitems/${work_item_id}/tags`, tag_id);
      return `Attached tag ${tag_id} to work item ${work_item_id}.`;
    },
  );

  tool(
    "detach_tag",
    "Remove a tag from a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int(), tag_id: z.number().int() },
    async ({ project_id, work_item_id, tag_id }) => {
      await hp.delete(`/projects/${project_id}/workitems/${work_item_id}/tags/${tag_id}`);
      return `Detached tag ${tag_id} from work item ${work_item_id}.`;
    },
  );

  tool(
    "assign_user",
    "Assign a project user to a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int(), user_id: z.number().int() },
    async ({ project_id, work_item_id, user_id }) => {
      await hp.post(`/projects/${project_id}/workitems/${work_item_id}/users`, user_id);
      return `Assigned user ${user_id} to work item ${work_item_id}.`;
    },
  );

  tool(
    "unassign_user",
    "Remove a user assignment from a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int(), user_id: z.number().int() },
    async ({ project_id, work_item_id, user_id }) => {
      await hp.delete(`/projects/${project_id}/workitems/${work_item_id}/users/${user_id}`);
      return `Unassigned user ${user_id} from work item ${work_item_id}.`;
    },
  );

  tool(
    "list_project_users",
    "List the members of a project (id, username).",
    { project_id: z.number().int() },
    async ({ project_id }) => asJson(list(await hp.get(`/projects/${project_id}/users`))),
  );

  // ===================== SUB-TASKS (checklist) =====================

  tool(
    "list_subtasks",
    "List a work item's sub-tasks (its checklist), with completion state.",
    { project_id: z.number().int(), work_item_id: z.number().int() },
    async ({ project_id, work_item_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/workitems/${work_item_id}/subtasks`))),
  );

  tool(
    "update_subtask",
    "Update a sub-task (rename and/or mark complete/incomplete).",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      subtask_id: z.number().int(),
      title: z.string(),
      is_completed: z.boolean().optional(),
    },
    async (a) => {
      const body: Rec = { title: a.title };
      if (a.is_completed !== undefined) body.isCompleted = a.is_completed;
      return asJson(
        await hp.patch(
          `/projects/${a.project_id}/workitems/${a.work_item_id}/subtasks/${a.subtask_id}`,
          body,
        ),
      );
    },
  );

  tool(
    "delete_subtask",
    "Delete a sub-task. confirm=true required.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      subtask_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, work_item_id, subtask_id, confirm }) => {
      if (!confirm) return "Refused: re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/workitems/${work_item_id}/subtasks/${subtask_id}`);
      return `Deleted sub-task ${subtask_id}.`;
    },
  );

  // ===================== DEPENDENCIES =====================

  tool(
    "list_dependencies",
    "List a work item's dependencies (the predecessors that block it).",
    { project_id: z.number().int(), work_item_id: z.number().int() },
    async ({ project_id, work_item_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/workitems/${work_item_id}/dependencies`))),
  );

  tool(
    "add_dependency",
    "Make work_item_id depend on (be blocked by) predecessor_id. The successor can't be completed until the predecessor is done.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      predecessor_id: z.number().int(),
    },
    async ({ project_id, work_item_id, predecessor_id }) =>
      asJson(
        await hp.post(
          `/projects/${project_id}/workitems/${work_item_id}/dependencies`,
          predecessor_id,
        ),
      ),
  );

  tool(
    "remove_dependency",
    "Remove a dependency from a work item. confirm=true required.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      dependency_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, work_item_id, dependency_id, confirm }) => {
      if (!confirm) return "Refused: re-call with confirm=true.";
      await hp.delete(
        `/projects/${project_id}/workitems/${work_item_id}/dependencies/${dependency_id}`,
      );
      return `Removed dependency ${dependency_id}.`;
    },
  );

  // ===================== WORK LOGS (time tracking) =====================

  tool(
    "list_work_logs",
    "List the work logs (time entries) on a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int() },
    async ({ project_id, work_item_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/workitems/${work_item_id}/worklogs`))),
  );

  tool(
    "log_work",
    "Log time/effort on a work item. value = amount worked, in the project's costMetric unit (hours or points). comment is an optional note. Logs can only be edited within ~1 hour of creation.",
    {
      project_id: z.number().int(),
      work_item_id: z.number().int(),
      value: z.number(),
      comment: z.string().default(""),
    },
    async ({ project_id, work_item_id, value, comment }) => {
      const body: Rec = { value };
      if (comment) body.comment = comment;
      return asJson(
        await hp.post(`/projects/${project_id}/workitems/${work_item_id}/worklogs`, body),
      );
    },
  );

  // ===================== DESIGN MODEL (feature/knowledge tree) =====================

  tool(
    "list_design_element_types",
    "List the design-element TYPES (node categories of the design model, e.g. System / Module / Feature). Repurpose as a feature-tree taxonomy.",
    { project_id: z.number().int() },
    async ({ project_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/designelementtypes`))),
  );

  tool(
    "create_design_element_type",
    "Create a design-element type (a node category for the design/feature tree).",
    {
      project_id: z.number().int(),
      name: z.string(),
      color: z.string().optional(),
      icon: z.string().optional(),
    },
    async (a) => {
      const body: Rec = { name: a.name };
      if (a.color) body.color = a.color;
      if (a.icon) body.icon = a.icon;
      return asJson(await hp.post(`/projects/${a.project_id}/designelementtypes`, body));
    },
  );

  tool(
    "list_design_elements",
    "List design elements (nodes of the design/feature/knowledge tree). Optionally filter by type_id.",
    { project_id: z.number().int(), type_id: z.number().int().optional() },
    async ({ project_id, type_id }) => {
      let path = `/projects/${project_id}/designelements`;
      if (type_id !== undefined) path += `?typeId=${type_id}`;
      return asJson(list(await hp.get(path)));
    },
  );

  tool(
    "get_design_element",
    "Get one design element (with its documentation/description).",
    { project_id: z.number().int(), element_id: z.number().int() },
    async ({ project_id, element_id }) =>
      asJson(await hp.get(`/projects/${project_id}/designelements/${element_id}`)),
  );

  tool(
    "create_design_element",
    "Create a design element (a node in the design/feature tree). type_id is a design-element type id; parent_id nests it under another element (omit for a root). Link work items to it so progress rolls up the tree.",
    {
      project_id: z.number().int(),
      type_id: z.number().int(),
      name: z.string(),
      parent_id: z.number().int().optional(),
      description: z.string().default(""),
    },
    async (a) => {
      const body: Rec = { designElementTypeId: a.type_id, name: a.name };
      if (a.parent_id !== undefined) body.parentId = a.parent_id;
      if (a.description) body.description = a.description;
      return asJson(await hp.post(`/projects/${a.project_id}/designelements`, body));
    },
  );

  tool(
    "update_design_element",
    "Update a design element (rename, edit documentation, re-parent, change type). type_id and name are required by the API; pass the element's current values to keep them. Use get_design_element first to read them.",
    {
      project_id: z.number().int(),
      element_id: z.number().int(),
      type_id: z.number().int(),
      name: z.string(),
      description: z.string().optional(),
      parent_id: z.number().int().optional(),
    },
    async (a) => {
      const body: Rec = { designElementTypeId: a.type_id, name: a.name };
      if (a.description !== undefined) body.description = a.description;
      if (a.parent_id !== undefined) body.parentId = a.parent_id;
      return asJson(
        await hp.put(`/projects/${a.project_id}/designelements/${a.element_id}`, body),
      );
    },
  );

  tool(
    "delete_design_element",
    "Delete a design element (and its sub-tree). Destructive. confirm=true required.",
    {
      project_id: z.number().int(),
      element_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, element_id, confirm }) => {
      if (!confirm)
        return "Refused: deleting a design element removes its sub-tree. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/designelements/${element_id}`);
      return `Deleted design element ${element_id}.`;
    },
  );

  // ===================== BOARDS / PROJECT / METRICS =====================

  tool(
    "create_board",
    "Create a board (sprint/iteration). Optionally nest under a milestone and set start/due dates (ISO 8601).",
    {
      project_id: z.number().int(),
      name: z.string(),
      milestone_id: z.number().int().optional(),
      start_date: z.string().default(""),
      due_date: z.string().default(""),
      description: z.string().default(""),
    },
    async (a) => {
      const body: Rec = { name: a.name };
      if (a.milestone_id !== undefined) body.milestoneId = a.milestone_id;
      if (a.start_date) body.startDate = a.start_date;
      if (a.due_date) body.dueDate = a.due_date;
      if (a.description) body.description = a.description;
      return asJson(await hp.post(`/projects/${a.project_id}/boards`, body));
    },
  );

  tool(
    "close_board",
    "Close (end) a board/sprint.",
    { project_id: z.number().int(), board_id: z.number().int() },
    async ({ project_id, board_id }) => {
      await hp.post(`/projects/${project_id}/boards/${board_id}/closure`, {});
      return `Closed board ${board_id}.`;
    },
  );

  tool(
    "update_project",
    'Update a project\'s name / description / cost metric ("Hours" or "Points").',
    {
      project_id: z.number().int(),
      name: z.string().optional(),
      description: z.string().optional(),
      cost_metric: z.enum(["Hours", "Points"]).optional(),
    },
    async (a) => {
      const body: Rec = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (a.cost_metric !== undefined) body.costMetric = a.cost_metric;
      if (!Object.keys(body).length) return "Error: provide at least one field.";
      return asJson(await hp.patch(`/projects/${a.project_id}`, body));
    },
  );

  tool(
    "get_project_metrics",
    "Get a project's metrics (completion %, totals) — analytics Trello lacks.",
    { project_id: z.number().int() },
    async ({ project_id }) => asJson(await hp.get(`/projects/${project_id}/metrics`)),
  );

  tool(
    "get_milestone_metrics",
    "Get a milestone's metrics (burndown / completion).",
    { project_id: z.number().int(), milestone_id: z.number().int() },
    async ({ project_id, milestone_id }) =>
      asJson(await hp.get(`/projects/${project_id}/milestones/${milestone_id}/metrics`)),
  );

  tool(
    "list_attachments",
    "List the attachments on a work item.",
    { project_id: z.number().int(), work_item_id: z.number().int() },
    async ({ project_id, work_item_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/workitems/${work_item_id}/attachments`))),
  );

  // ===================== PORTFOLIO BIRDS-EYE (cross-project) =====================

  const PORTFOLIO_FMT = z.enum(["markdown", "json"]).default("markdown");

  tool(
    "portfolio_overview",
    "ALL-PROJECTS birds-eye view — the cross-project portfolio dashboard HacknPlan has no native equivalent for. Rolls up every project: completion %, open/closed counts, and urgent / blocked / due-soon / overdue flags, grouped via HACKNPLAN_GROUPS. Use for 'how's everything doing', 'what's on fire across all projects', 'portfolio status'.",
    { format: PORTFOLIO_FMT },
    async ({ format }) => {
      const data = await portfolio(hp, new Date());
      return format === "json" ? asJson(data) : toMarkdown(data);
    },
  );

  tool(
    "schedule_overview",
    "ALL-PROJECTS deadline countdown — every work item that has a due date, across every project, bucketed by time horizon (Overdue / This week ≤7d / Next 2 weeks 8-14d / This month 15-30d / Later) with a live days-left countdown. Use for 'what's due soon', 'what's overdue', 'deadlines', 'what should I do this week'.",
    { format: PORTFOLIO_FMT },
    async ({ format }) => {
      const data = await portfolio(hp, new Date());
      return format === "json" ? asJson(data.schedule) : toScheduleMarkdown(data);
    },
  );

  // ===================== SEARCH / QUERY / WORKFLOW HELPERS =====================

  /**
   * Page through a project's work items (the list endpoint caps each page).
   * `extra` carries best-effort server-side filters; if the API rejects them
   * (HTTP 400), we transparently retry without them so client-side filtering
   * still yields a correct result.
   */
  async function fetchAllWorkItems(
    pid: number,
    extra: Record<string, unknown> = {},
    cap = 200,
  ): Promise<Rec[]> {
    const pull = async (params: Record<string, unknown>): Promise<Rec[]> => {
      const out: Rec[] = [];
      const page = 100;
      for (let offset = 0; offset < cap; offset += page) {
        const batch = list(await hp.get(`/projects/${pid}/workitems`, { ...params, limit: page, offset }));
        out.push(...batch);
        if (batch.length < page) break;
      }
      return out.slice(0, cap);
    };
    try {
      return await pull(extra);
    } catch (e) {
      if (e instanceof HacknPlanError && e.status === 400 && Object.keys(extra).length) {
        return pull({}); // unsupported filter → fall back to client-side filtering
      }
      throw e;
    }
  }

  const isClosed = (w: Rec) => ((w.stage as Rec)?.status as string) === "closed";
  const assigneeIds = (w: Rec): number[] => {
    const arr = (w.assignedUsers ?? w.users) as Rec[] | undefined;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((u) => (u.userId ?? u.id ?? (u.user as Rec)?.id) as number | undefined)
      .filter((n): n is number => typeof n === "number");
  };

  tool(
    "find_work_items",
    "Search a project's work items by free text and/or facets — the name-based lookup that saves chaining list→scan→act. query matches title or description (case-insensitive). Optional facet filters: importance (level name e.g. 'Urgent'), tag (name), stage (name). status: open|closed|all (default open). Use this to resolve a task you only know by name into its id before update_work_item / move / etc.",
    {
      project_id: z.number().int(),
      query: z.string().default(""),
      importance: z.string().optional(),
      tag: z.string().optional(),
      stage: z.string().optional(),
      status: z.enum(["open", "closed", "all"]).default("open"),
      limit: z.number().int().default(25),
      format: FORMAT,
    },
    async (a) => {
      const q = a.query.trim().toLowerCase();
      // Best-effort server-side narrowing (falls back automatically if unsupported);
      // the client-side filter below is the source of truth either way.
      const extra: Record<string, unknown> = {};
      if (q) extra.text = a.query.trim();
      if (a.status !== "all") extra.status = a.status;
      let items = await fetchAllWorkItems(a.project_id, extra);
      items = items.filter((w) => {
        if (a.status === "open" && isClosed(w)) return false;
        if (a.status === "closed" && !isClosed(w)) return false;
        if (q) {
          const hay = `${w.title ?? ""}\n${w.description ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (a.importance && ((w.importanceLevel as Rec)?.name as string) !== a.importance)
          return false;
        if (a.stage && ((w.stage as Rec)?.name as string) !== a.stage) return false;
        if (a.tag) {
          const tags = (w.tags as Rec[]) ?? [];
          if (!tags.some((t) => (t.name as string) === a.tag)) return false;
        }
        return true;
      });
      return formatList(items.slice(0, a.limit), "work items", a.format);
    },
  );

  tool(
    "my_work",
    "List work items assigned to the authenticated user (from /users/me), optionally scoped to one project — the 'what am I working on' / standup view. By default only open items; set include_closed=true to see finished ones too. Relies on the assignee data the list endpoint returns inline.",
    {
      project_id: z.number().int().optional(),
      include_closed: z.boolean().default(false),
      format: PORTFOLIO_FMT,
    },
    async ({ project_id, include_closed, format }) => {
      const me = (await hp.get("/users/me")) as Rec;
      const myId = (me.id ?? me.userId) as number | undefined;
      if (typeof myId !== "number") return "Error: could not determine your user id from /users/me.";

      const projects =
        project_id !== undefined
          ? [{ id: project_id, name: `project ${project_id}` } as Rec]
          : list(await hp.get("/projects"));

      const mine: Rec[] = [];
      for (const p of projects) {
        const pid = p.id as number;
        const items = await fetchAllWorkItems(pid);
        for (const w of items) {
          if (!include_closed && isClosed(w)) continue;
          if (assigneeIds(w).includes(myId)) mine.push({ ...w, _project: p.name });
        }
      }
      if (format === "json") return asJson(mine);
      if (!mine.length) return "_No work items assigned to you (in scope)._";
      const lines = [`### ${mine.length} items assigned to ${me.username ?? myId}`];
      for (const w of mine) {
        const stage = ((w.stage as Rec)?.name as string) ?? "?";
        const imp = ((w.importanceLevel as Rec)?.name as string) ?? "";
        const due = w.dueDate ? ` · due ${String(w.dueDate).slice(0, 10)}` : "";
        lines.push(`- [${w._project}] #${w.workItemId} ${w.title}  (${stage}${imp ? `, ${imp}` : ""}${due})`);
      }
      return lines.join("\n");
    },
  );

  tool(
    "plan_feature",
    "Break a feature down in ONE call: create a user story, then create its child tasks (parented to the story) — optionally each with its own checklist (sub_tasks). Tasks inherit importance_level_id, default_category_id, board_id and milestone_id unless overridden per task. This is the fast path for 'turn this feature into a story with tasks'. Returns the created story and tasks.",
    {
      project_id: z.number().int(),
      story_title: z.string(),
      importance_level_id: z.number().int(),
      story_description: z.string().default(""),
      board_id: z.number().int().optional(),
      milestone_id: z.number().int().optional(),
      default_category_id: z.number().int().optional(),
      default_estimated_cost: z.number().default(0),
      tasks: z
        .array(
          z.object({
            title: z.string(),
            category_id: z.number().int().optional(),
            estimated_cost: z.number().optional(),
            importance_level_id: z.number().int().optional(),
            description: z.string().optional(),
            sub_tasks: z.array(z.string()).optional(),
          }),
        )
        .default([]),
    },
    async (a) => {
      const storyBody: Rec = {
        title: a.story_title,
        isStory: true,
        estimatedCost: 0,
        importanceLevelId: a.importance_level_id,
      };
      if (a.story_description) storyBody.description = a.story_description;
      if (a.board_id !== undefined) storyBody.boardId = a.board_id;
      if (a.milestone_id !== undefined) storyBody.milestoneId = a.milestone_id;
      const story = (await hp.post(`/projects/${a.project_id}/workitems`, storyBody)) as Rec;
      const storyId = story.workItemId as number;

      const created: Rec[] = [];
      for (const t of a.tasks) {
        const body: Rec = {
          title: t.title,
          isStory: false,
          estimatedCost: t.estimated_cost ?? a.default_estimated_cost,
          importanceLevelId: t.importance_level_id ?? a.importance_level_id,
          parentId: storyId,
        };
        const cat = t.category_id ?? a.default_category_id;
        if (cat !== undefined) body.categoryId = cat;
        if (t.description) body.description = t.description;
        if (a.board_id !== undefined) body.boardId = a.board_id;
        if (a.milestone_id !== undefined) body.milestoneId = a.milestone_id;
        if (t.sub_tasks?.length) body.subTasks = t.sub_tasks;
        created.push((await hp.post(`/projects/${a.project_id}/workitems`, body)) as Rec);
      }
      return asJson({ story, tasks: created });
    },
  );

  // ===================== MILESTONE / BOARD: UPDATE / DELETE =====================
  // (RESTful PATCH/DELETE following the documented resource convention.)

  tool(
    "update_milestone",
    "Update a milestone (rename, change due/start date, edit general info). Dates are ISO 8601.",
    {
      project_id: z.number().int(),
      milestone_id: z.number().int(),
      name: z.string().optional(),
      due_date: z.string().optional(),
      start_date: z.string().optional(),
      general_info: z.string().optional(),
    },
    async (a) => {
      const body: Rec = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.due_date !== undefined) body.dueDate = a.due_date;
      if (a.start_date !== undefined) body.startDate = a.start_date;
      if (a.general_info !== undefined) body.generalInfo = a.general_info;
      if (!Object.keys(body).length) return "Error: provide at least one field to update.";
      return asJson(await hp.patch(`/projects/${a.project_id}/milestones/${a.milestone_id}`, body));
    },
  );

  tool(
    "delete_milestone",
    "Delete a milestone. Destructive (work items are un-grouped, not deleted). confirm=true required.",
    {
      project_id: z.number().int(),
      milestone_id: z.number().int(),
      confirm: z.boolean().default(false),
    },
    async ({ project_id, milestone_id, confirm }) => {
      if (!confirm) return "Refused: deleting a milestone is destructive. Re-call with confirm=true.";
      await hp.delete(`/projects/${project_id}/milestones/${milestone_id}`);
      return `Deleted milestone ${milestone_id}.`;
    },
  );

  tool(
    "update_board",
    "Update a board/sprint (rename, change start/due date, description, or re-nest under a milestone). Dates are ISO 8601.",
    {
      project_id: z.number().int(),
      board_id: z.number().int(),
      name: z.string().optional(),
      start_date: z.string().optional(),
      due_date: z.string().optional(),
      description: z.string().optional(),
      milestone_id: z.number().int().optional(),
    },
    async (a) => {
      const body: Rec = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.start_date !== undefined) body.startDate = a.start_date;
      if (a.due_date !== undefined) body.dueDate = a.due_date;
      if (a.description !== undefined) body.description = a.description;
      if (a.milestone_id !== undefined) body.milestoneId = a.milestone_id;
      if (!Object.keys(body).length) return "Error: provide at least one field to update.";
      return asJson(await hp.patch(`/projects/${a.project_id}/boards/${a.board_id}`, body));
    },
  );

  // ===================== LIFECYCLE: CLOSE / REOPEN (non-destructive) =====================
  // Closing archives a project/milestone/board without deleting its contents
  // (POST .../closure to close, DELETE .../closure to reopen). Distinct from delete_*.

  tool(
    "close_project",
    "Close (archive) a project without deleting it — its work items and history are preserved. Reverse with reopen_project.",
    { project_id: z.number().int() },
    async ({ project_id }) => {
      await hp.post(`/projects/${project_id}/closure`, {});
      return `Closed (archived) project ${project_id}.`;
    },
  );

  tool(
    "reopen_project",
    "Reopen a previously closed/archived project.",
    { project_id: z.number().int() },
    async ({ project_id }) => {
      await hp.delete(`/projects/${project_id}/closure`);
      return `Reopened project ${project_id}.`;
    },
  );

  tool(
    "close_milestone",
    "Close (release) a milestone — marks it done without deleting it. Reverse with reopen_milestone.",
    { project_id: z.number().int(), milestone_id: z.number().int() },
    async ({ project_id, milestone_id }) => {
      await hp.post(`/projects/${project_id}/milestones/${milestone_id}/closure`, {});
      return `Closed milestone ${milestone_id}.`;
    },
  );

  tool(
    "reopen_milestone",
    "Reopen a previously closed milestone.",
    { project_id: z.number().int(), milestone_id: z.number().int() },
    async ({ project_id, milestone_id }) => {
      await hp.delete(`/projects/${project_id}/milestones/${milestone_id}/closure`);
      return `Reopened milestone ${milestone_id}.`;
    },
  );

  tool(
    "reopen_board",
    "Reopen a previously closed board/sprint (counterpart to close_board).",
    { project_id: z.number().int(), board_id: z.number().int() },
    async ({ project_id, board_id }) => {
      await hp.delete(`/projects/${project_id}/boards/${board_id}/closure`);
      return `Reopened board ${board_id}.`;
    },
  );

  // ===================== ACTIVITY / METRICS / DESIGN COMMENTS =====================

  tool(
    "recent_activity",
    "Project activity/event feed — the 'what changed' / standup view. Returns events between `from` and `to` (ISO 8601 dates/timestamps). If `from` is omitted it defaults to 7 days ago, `to` to now. Use for 'what happened this week', 'recent changes', daily standups.",
    {
      project_id: z.number().int(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    async ({ project_id, from, to }) => {
      const now = new Date();
      const fromIso = from ?? new Date(now.getTime() - 7 * 86_400_000).toISOString();
      const toIso = to ?? now.toISOString();
      return asJson(
        list(await hp.get(`/projects/${project_id}/events`, { from: fromIso, to: toIso })),
      );
    },
  );

  tool(
    "get_board_metrics",
    "Get a board's (sprint's) metrics — burndown / velocity / completion. Optionally scope to one user via user_id.",
    { project_id: z.number().int(), board_id: z.number().int(), user_id: z.number().int().optional() },
    async ({ project_id, board_id, user_id }) => {
      const params: Record<string, unknown> = {};
      if (user_id !== undefined) params.userId = user_id;
      return asJson(await hp.get(`/projects/${project_id}/boards/${board_id}/metrics`, params));
    },
  );

  tool(
    "get_design_element_metrics",
    "Get a design element's metrics (work rolled up from items linked to it). include_children rolls up its whole sub-tree.",
    {
      project_id: z.number().int(),
      element_id: z.number().int(),
      include_children: z.boolean().default(false),
    },
    async ({ project_id, element_id, include_children }) =>
      asJson(
        await hp.get(`/projects/${project_id}/designelements/${element_id}/metrics`, {
          includeChildren: include_children,
        }),
      ),
  );

  tool(
    "list_design_element_comments",
    "List the comments/notes on a design element (design-doc discussion thread).",
    { project_id: z.number().int(), element_id: z.number().int() },
    async ({ project_id, element_id }) =>
      asJson(list(await hp.get(`/projects/${project_id}/designelements/${element_id}/comments`))),
  );

  tool(
    "add_design_element_comment",
    "Add a comment/note to a design element (markdown supported, max 5000 chars).",
    { project_id: z.number().int(), element_id: z.number().int(), text: z.string() },
    async ({ project_id, element_id, text }) =>
      asJson(
        await hp.post(
          `/projects/${project_id}/designelements/${element_id}/comments`,
          text.slice(0, 5000),
        ),
      ),
  );

  return server;
}
