import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

type Danger = {
  category: "files" | "git" | "database" | "system";
  reason: string;
  match: string;
};

const FILE_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:^|[\n;&|()])\s*(?:sudo\s+)?(?:command\s+)?(?:(?:\.?\.?|~)?\/[\w./-]+\/)?(?:rm|rmdir|unlink|trash|trash-put|shred|srm)\b[^\n]*/i,
    reason: "deletes or destroys files",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*find\b[^\n;&|]*\s-delete\b[^\n]*/i,
    reason: "find -delete removes files",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*(?:sudo\s+)?rsync\b[^\n;&|]*\s--delete(?:\s|=|$)[^\n]*/i,
    reason: "rsync --delete removes destination files",
  },
];

const GIT_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:^|[\n;&|()])\s*git\s+clean\b[^\n]*/i,
    reason: "git clean deletes untracked files",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*git\s+reset\b[^\n;&|]*\s--hard\b[^\n]*/i,
    reason: "git reset --hard discards local changes",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*git\s+restore\b[^\n;&|]*(?:\s--staged\b|\s\.\b|\s:\/\b|\s\*|\s--source\b)[^\n]*/i,
    reason: "git restore can discard local changes",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*git\s+checkout\b[^\n;&|]*\s--\s+[^\n]*/i,
    reason: "git checkout -- can discard local changes",
  },
];

const SYSTEM_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:^|[\n;&|()])\s*(?:sudo\s+)?(?:mkfs(?:\.\w+)?|wipefs|fdisk|sfdisk|parted)\b[^\n]*/i,
    reason: "disk or filesystem command can destroy data",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*(?:sudo\s+)?diskutil\b[^\n;&|]*(?:erase|partition|apfs\s+delete|apfs\s+erase)[^\n]*/i,
    reason: "diskutil command can destroy data",
  },
  {
    pattern: /(?:^|[\n;&|()])\s*(?:sudo\s+)?docker\b[^\n;&|]*(?:system\s+prune|volume\s+prune|volume\s+rm|compose\s+down\b[^\n;&|]*\s-v\b)[^\n]*/i,
    reason: "docker command removes volumes or cached data",
  },
];

const DB_TOOL_PATTERN = /(?:^|[\s|;&(])(?:sudo\s+)?(?:(?:npx|bunx)\s+|(?:pnpm|yarn|bun|npm)\s+(?:exec\s+|dlx\s+|run\s+)?|uv\s+run\s+|docker\s+compose\s+exec\s+\S+\s+|docker\s+exec\s+\S+\s+)?(?:psql|mysql|mariadb|sqlite3|duckdb|clickhouse-client|mongosh|mongo|redis-cli|prisma|drizzle-kit|supabase|knex|sequelize|rails|rake|alembic|liquibase|flyway|dropdb)\b/i;

const SQL_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdrop\s+(?:database|schema|table|view|index|type|function|procedure)\b/i, reason: "drops database objects" },
  { pattern: /\btruncate\s+(?:table\s+)?[\w`".[\]-]+/i, reason: "truncates table data" },
  { pattern: /\bdelete\s+from\s+[\w`".[\]-]+/i, reason: "deletes database records" },
  { pattern: /\bupdate\s+[\w`".[\]-]+\s+set\b/i, reason: "modifies database records" },
  { pattern: /\binsert\s+into\s+[\w`".[\]-]+/i, reason: "inserts database records" },
  { pattern: /\bupsert\s+(?:into\s+)?[\w`".[\]-]+/i, reason: "upserts database records" },
  { pattern: /\breplace\s+into\s+[\w`".[\]-]+/i, reason: "replaces database records" },
  { pattern: /\bmerge\s+into\s+[\w`".[\]-]+/i, reason: "merges database records" },
  { pattern: /\balter\s+(?:database|schema|table|view|index|type)\b/i, reason: "alters database schema" },
  { pattern: /\bcreate\s+or\s+replace\b/i, reason: "replaces database objects" },
  { pattern: /\b(?:dropDatabase|drop\s*\(|deleteMany|deleteOne|remove\s*\(|updateMany|updateOne|replaceOne)\b/i, reason: "modifies or deletes database records" },
  { pattern: /\b(?:flushall|flushdb|del)\b/i, reason: "deletes Redis data" },
];

const DB_COMMAND_DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdropdb\b[^\n]*/i, reason: "drops a database" },
  { pattern: /\b(?:db:drop|db:reset|migrate\s+reset|migrate:reset|schema:drop|reset\s+db|database\s+reset)\b[^\n]*/i, reason: "database reset/drop command" },
  { pattern: /\b(?:migrate\s+down|rollback|db:migrate:down|db:migrate:undo|db:migrate:undo:all)\b[^\n]*/i, reason: "database rollback command can modify schema/data" },
  { pattern: /\b(?:prisma\s+migrate\s+reset|supabase\s+db\s+reset|drizzle-kit\s+drop)\b[^\n]*/i, reason: "database destructive tool command" },
];

function firstMatch(command: string, pattern: RegExp): string | null {
  const match = command.match(pattern);
  return match?.[0]?.trim() || null;
}

function collectMatches(command: string, category: Danger["category"], checks: Array<{ pattern: RegExp; reason: string }>): Danger[] {
  const dangers: Danger[] = [];
  for (const check of checks) {
    const match = firstMatch(command, check.pattern);
    if (match) dangers.push({ category, reason: check.reason, match });
  }
  return dangers;
}

export function detectDangerousCommand(command: string): Danger[] {
  const dangers = [
    ...collectMatches(command, "files", FILE_DESTRUCTIVE_PATTERNS),
    ...collectMatches(command, "git", GIT_DESTRUCTIVE_PATTERNS),
    ...collectMatches(command, "system", SYSTEM_DESTRUCTIVE_PATTERNS),
    ...collectMatches(command, "database", DB_COMMAND_DESTRUCTIVE_PATTERNS),
  ];

  if (DB_TOOL_PATTERN.test(command)) {
    dangers.push(...collectMatches(command, "database", SQL_DESTRUCTIVE_PATTERNS));

    const dbImportMatch = firstMatch(command, /(?:^|[\n;&|()])\s*[^\n;&|]*(?:psql|mysql|mariadb|sqlite3|duckdb)\b[^\n;&|]*\s<\s*\S+[^\n]*/i);
    if (dbImportMatch) {
      dangers.push({ category: "database", reason: "imports SQL into a database; file contents may modify data", match: dbImportMatch });
    }
  }

  return dedupeDangers(dangers);
}

function dedupeDangers(dangers: Danger[]): Danger[] {
  const seen = new Set<string>();
  return dangers.filter((danger) => {
    const key = `${danger.category}:${danger.reason}:${danger.match}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatConfirmation(command: string, dangers: Danger[]): string {
  const lines = dangers.map((danger, index) => `${index + 1}. [${danger.category}] ${danger.reason}\n   ${danger.match}`);
  return [
    "Pi detected a potentially destructive command.",
    "",
    ...lines,
    "",
    "Command:",
    command,
    "",
    "Run it anyway?",
  ].join("\n");
}

async function confirmDangerousCommand(command: string, ctx: ExtensionContext): Promise<{ allowed: boolean; reason?: string }> {
  const dangers = detectDangerousCommand(command);
  if (dangers.length === 0) return { allowed: true };

  const reason = dangers.map((danger) => `${danger.category}: ${danger.reason}`).join("; ");
  if (!ctx.hasUI) return { allowed: false, reason: `Blocked destructive command in non-interactive mode: ${reason}` };

  const ok = await ctx.ui.confirm("Confirm destructive action", formatConfirmation(command, dangers));
  return ok ? { allowed: true } : { allowed: false, reason: `Blocked destructive command: ${reason}` };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const result = await confirmDangerousCommand(event.input.command, ctx);
    if (!result.allowed) return { block: true, reason: result.reason };
  });

  pi.on("user_bash", async (event, ctx) => {
    const result = await confirmDangerousCommand(event.command, ctx);
    if (result.allowed) return;

    return {
      result: {
        output: result.reason ?? "Blocked destructive command",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
