/**
 * Cross-project portfolio rollup — the birds-eye view HacknPlan lacks natively.
 *
 * HacknPlan has no all-projects dashboard (it shows per-project boards + a
 * recent-activity feed only). This aggregates every project into one snapshot
 * using the work-item LIST endpoint, which returns stage / importance /
 * category / isBlocked / dueDate inline — so a whole project rolls up in ONE
 * request (no N+1 per card).
 *
 * Optional grouping: HacknPlan has no "workspace" tier, so projects can be
 * grouped for display via the HACKNPLAN_GROUPS env var — a JSON object mapping a
 * group label to a list of project names, e.g.
 *
 *   HACKNPLAN_GROUPS='{"Team A":["Website","API"],"Personal":["Notes"]}'
 *
 * If unset, every project falls under a single "All Projects" group.
 */
import { HacknPlanClient } from "./client.js";

type Rec = Record<string, unknown>;

const DEFAULT_GROUP = "All Projects";

function loadGroups(): Record<string, string[]> {
  const raw = (process.env.HACKNPLAN_GROUPS ?? "").trim();
  if (!raw) return {};
  try {
    const g = JSON.parse(raw);
    return g && typeof g === "object" && !Array.isArray(g) ? g : {};
  } catch {
    return {};
  }
}

const GROUPS = loadGroups();

function groupOf(name: string): string {
  for (const [label, names] of Object.entries(GROUPS)) {
    if (names.includes(name)) return label;
  }
  return DEFAULT_GROUP;
}

interface Deadline {
  title: string;
  due: string;
  days_left: number;
  stage: string;
  project?: string;
  group?: string;
}

interface Rollup {
  id: number;
  name: string;
  group: string;
  description: string;
  total: number;
  open: number;
  closed: number;
  pct_done: number;
  blocked: number;
  urgent: number;
  high: number;
  due_soon: number;
  overdue: number;
  stories: number;
  by_stage: Record<string, number>;
  by_category: Record<string, number>;
  deadlines: Deadline[];
}

/** Calendar-day difference so "due today" == 0 (not a partial-day -1). */
function daysBetween(a: Date, b: Date): number {
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((da - db) / 86_400_000);
}

/** One-request rollup of a single project from its inline work-item list. */
export async function projectRollup(
  hp: HacknPlanClient,
  project: Rec,
  now: Date,
): Promise<Rollup> {
  const pid = project.id as number;
  const items = HacknPlanClient.asList(
    await hp.get(`/projects/${pid}/workitems`, { limit: 100 }),
  );

  const total = items.length;
  let closed = 0,
    open = 0,
    blocked = 0,
    urgent = 0,
    high = 0,
    dueSoon = 0,
    overdue = 0,
    stories = 0;
  const byStage: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const deadlines: Deadline[] = [];

  for (const w of items) {
    const stage = (w.stage as Rec) ?? {};
    const sname = (stage.name as string) ?? "?";
    const sstatus = (stage.status as string) ?? "";
    byStage[sname] = (byStage[sname] ?? 0) + 1;
    if (sstatus === "closed") closed++;
    else open++;

    // "blocked" = a Blocked-named stage OR the derived isBlocked flag. HacknPlan's
    // isBlocked is dependency-derived (usually false), so the stage name is the
    // real signal for a Trello-style "Blocked" column.
    if (w.isBlocked || sname.toLowerCase().includes("block") || sname.includes("⏸")) {
      blocked++;
    }

    const imp = ((w.importanceLevel as Rec)?.name as string) ?? "";
    if (imp === "Urgent") urgent++;
    else if (imp === "High") high++;

    const cat = (w.category as Rec)?.name as string | undefined;
    if (cat) byCategory[cat] = (byCategory[cat] ?? 0) + 1;

    if (w.isStory) stories++;

    const due = w.dueDate as string | undefined;
    if (due && sstatus !== "closed") {
      const d = new Date(due);
      if (!Number.isNaN(d.getTime())) {
        const days = daysBetween(d, now);
        if (days < 0) overdue++;
        else if (days <= 7) dueSoon++;
        deadlines.push({ title: (w.title as string) ?? "", due: due.slice(0, 10), days_left: days, stage: sname });
      }
    }
  }

  const pct = total ? Math.round((100 * closed) / total) : 0;
  return {
    id: pid,
    name: project.name as string,
    group: groupOf(project.name as string),
    description: String(project.description ?? "").split("\n")[0].slice(0, 80),
    total,
    open,
    closed,
    pct_done: pct,
    blocked,
    urgent,
    high,
    due_soon: dueSoon,
    overdue,
    stories,
    by_stage: byStage,
    by_category: byCategory,
    deadlines,
  };
}

export interface Portfolio {
  generated_at: string;
  grand: Record<string, number>;
  groups: Record<string, Record<string, number>>;
  projects: Rollup[];
  schedule: Deadline[];
}

/** Roll up ALL projects. `now` is passed in by the caller. */
export async function portfolio(hp: HacknPlanClient, now: Date): Promise<Portfolio> {
  const projects = HacknPlanClient.asList(await hp.get("/projects"));
  const rolled: Rollup[] = [];
  const sorted = [...projects].sort((a, b) =>
    String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()),
  );
  for (const p of sorted) {
    rolled.push(await projectRollup(hp, p, now));
  }

  const groupTotals: Record<string, Record<string, number>> = {};
  const grand: Record<string, number> = {
    projects: rolled.length,
    total: 0,
    open: 0,
    closed: 0,
    blocked: 0,
    urgent: 0,
    due_soon: 0,
    overdue: 0,
  };

  for (const r of rolled) {
    for (const k of ["total", "open", "closed", "blocked", "urgent", "due_soon", "overdue"]) {
      grand[k] += (r as unknown as Record<string, number>)[k];
    }
    const gt = (groupTotals[r.group] ??= {
      projects: 0,
      total: 0,
      closed: 0,
      blocked: 0,
      urgent: 0,
    });
    gt.projects += 1;
    gt.total += r.total;
    gt.closed += r.closed;
    gt.blocked += r.blocked;
    gt.urgent += r.urgent;
  }
  grand.pct_done = grand.total ? Math.round((100 * grand.closed) / grand.total) : 0;
  for (const gt of Object.values(groupTotals)) {
    gt.pct_done = gt.total ? Math.round((100 * gt.closed) / gt.total) : 0;
  }

  const schedule: Deadline[] = [];
  for (const r of rolled) {
    for (const dl of r.deadlines) {
      schedule.push({ ...dl, project: r.name, group: r.group });
    }
  }
  schedule.sort((a, b) => a.days_left - b.days_left);

  return { generated_at: now.toISOString(), grand, groups: groupTotals, projects: rolled, schedule };
}

// horizon buckets for the countdown view
const SCHEDULE_BUCKETS: Array<[string, (d: number) => boolean]> = [
  ["Overdue", (d) => d < 0],
  ["This week (≤7d)", (d) => d >= 0 && d <= 7],
  ["Next 2 weeks (8–14d)", (d) => d >= 8 && d <= 14],
  ["This month (15–30d)", (d) => d >= 15 && d <= 30],
  ["Later (>30d)", (d) => d > 30],
];

export function toScheduleMarkdown(p: Portfolio): string {
  const sched = p.schedule;
  if (!sched.length) {
    return "_No upcoming deadlines (no work items have a due date set)._";
  }
  const lines = [
    `# Schedule — ${sched.length} upcoming deadlines (as of ${p.generated_at.slice(0, 10)})`,
    "",
  ];
  for (const [label, pred] of SCHEDULE_BUCKETS) {
    const rows = sched.filter((s) => pred(s.days_left));
    if (!rows.length) continue;
    lines.push(`## ${label} — ${rows.length}`);
    for (const s of rows) {
      const d = s.days_left;
      const cd = d < 0 ? `${-d}d overdue` : d === 0 ? "due today" : `${d}d left`;
      lines.push(`- **${cd}** · ${s.due} · ${s.project} — ${s.title}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function groupOrder(p: Portfolio): string[] {
  const order = Object.keys(GROUPS).filter((g) => g in p.groups);
  const rest = Object.keys(p.groups)
    .filter((g) => !order.includes(g))
    .sort((a, b) => p.groups[b].total - p.groups[a].total);
  return [...order, ...rest];
}

function bar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function toMarkdown(p: Portfolio): string {
  const g = p.grand;
  const lines = [
    `# Portfolio — ${g.projects} projects, ${g.pct_done}% done (${g.closed}/${g.total} items)`,
    `⚑ ${g.urgent} urgent · ⏸ ${g.blocked} blocked · ⏰ ${g.due_soon} due ≤7d · 🔴 ${g.overdue} overdue`,
    "",
  ];
  for (const label of groupOrder(p)) {
    const gt = p.groups[label];
    lines.push(`## ${label} — ${gt.pct_done}% (${gt.closed}/${gt.total}), ${gt.projects} projects`);
    const rows = p.projects
      .filter((r) => r.group === label)
      .sort((a, b) => b.urgent - a.urgent || b.blocked - a.blocked || b.pct_done - a.pct_done);
    for (const r of rows) {
      const flags: string[] = [];
      if (r.urgent) flags.push(`⚑${r.urgent}`);
      if (r.blocked) flags.push(`⏸${r.blocked}`);
      if (r.overdue) flags.push(`🔴${r.overdue}`);
      if (r.due_soon) flags.push(`⏰${r.due_soon}`);
      lines.push(
        `- **${r.name}** ${bar(r.pct_done)} ${r.pct_done}%  (${r.closed}/${r.total})  ${flags.join(" ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
