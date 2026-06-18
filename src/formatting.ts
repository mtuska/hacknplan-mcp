/**
 * Response formatting helpers (high-signal, bounded output).
 *
 * Tools return either compact JSON (machine-friendly) or Markdown
 * (human-friendly), with a character cap so a large project never blows the
 * agent's context budget.
 */

export const CHARACTER_LIMIT = 25_000;

export type Rec = Record<string, unknown>;
export type ListFormat = "concise" | "detailed" | "json";

export function cap(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n…[truncated ${text.length - limit} chars; narrow your query or use format='concise']`
  );
}

export function asJson(obj: unknown): string {
  return cap(JSON.stringify(obj, null, 2));
}

function projectRow(p: Rec): string {
  return `- **${p.name}** (id=${p.id}, workspace=${p.workspaceId}, costMetric=${p.costMetric})`;
}

function workItemLine(w: Rec, detailed = false): string {
  const category = w.category as Rec | undefined;
  const stage = w.stage as Rec | undefined;
  const cat = category && typeof category === "object" ? category.name : undefined;
  const sname = stage && typeof stage === "object" ? stage.name : undefined;
  const tagList = Array.isArray(w.tags) ? (w.tags as Rec[]) : [];
  const tags = tagList
    .filter((t) => t && typeof t === "object")
    .map((t) => (t.name as string) ?? "")
    .join(", ");

  const bits = [`#${w.workItemId}`, (w.title as string) ?? ""];
  const meta: string[] = [];
  if (sname) meta.push(`stage=${sname}`);
  if (cat) meta.push(`cat=${cat}`);
  if (w.isStory) meta.push("STORY");
  if (w.isBlocked) meta.push("BLOCKED");
  if (tags) meta.push(`tags=[${tags}]`);

  let line = `- ${bits.join(" ")}` + (meta.length ? `  (${meta.join(", ")})` : "");
  if (detailed && typeof w.description === "string" && w.description) {
    const desc = w.description.trim().replace(/\n/g, " ");
    line += `\n    ${desc.slice(0, 200)}`;
  }
  return line;
}

export function formatList(items: Rec[], kind: string, fmt: ListFormat = "concise"): string {
  if (fmt === "json") return asJson(items);
  if (!items.length) return `_No ${kind} found._`;

  const lines: string[] = [`### ${items.length} ${kind}`];
  for (const it of items) {
    if (kind === "projects") {
      lines.push(projectRow(it));
    } else if (kind === "work items") {
      lines.push(workItemLine(it, fmt === "detailed"));
    } else {
      const name = it.name ?? it.title ?? it.text ?? String(it);
      const singular = kind.slice(0, -1);
      const ident =
        it[`${singular}Id`] ??
        it.id ??
        it.stageId ??
        it.categoryId ??
        it.tagId ??
        it.milestoneId ??
        it.boardId ??
        it.importanceLevelId;
      const extra = ident !== undefined && ident !== null ? ` (id=${ident})` : "";
      const status = it.status ? ` [${it.status}]` : "";
      lines.push(`- ${name}${extra}${status}`);
    }
  }
  return cap(lines.join("\n"));
}
