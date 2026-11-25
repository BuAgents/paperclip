// bu-fork: display names for the principals referenced in wake context.
// Agents were crediting decisions to the wrong human because the wake payload
// only carried opaque user IDs. Names come from the same source as the company
// user directory (active company memberships joined to auth users), so a user
// who is unknown or no longer a member resolves to null and callers fall back
// to the ID. Kept separate from upstream files to keep the upstream diff small.
import { and, eq, inArray } from "drizzle-orm";
import { agents, authUsers, companyMemberships, type Db } from "@paperclipai/db";

export interface PrincipalNames {
  userName(userId: string | null | undefined): string | null;
  agentName(agentId: string | null | undefined): string | null;
}

const unique = (ids: Iterable<string | null | undefined>) =>
  [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];

const lookup = (map: Map<string, string>) => (id: string | null | undefined) =>
  (id ? map.get(id) : undefined) ?? null;

/** One query for users and one for agents, scoped to the company. Never throws on unknown IDs. */
export async function loadPrincipalNames(
  db: Db,
  companyId: string,
  ids: { userIds?: Iterable<string | null | undefined>; agentIds?: Iterable<string | null | undefined> },
): Promise<PrincipalNames> {
  const userIds = unique(ids.userIds ?? []);
  const agentIds = unique(ids.agentIds ?? []);
  const [userRows, agentRows] = await Promise.all([
    userIds.length
      ? db
          .select({ id: authUsers.id, name: authUsers.name })
          .from(companyMemberships)
          .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalId, userIds),
            ),
          )
      : Promise.resolve([]),
    agentIds.length
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
      : Promise.resolve([]),
  ]);
  const named = (rows: Array<{ id: string; name: string | null }>) =>
    new Map(rows.flatMap((row) => {
      // Names are rendered into prompts: one line, bounded length.
      const name = row.name?.replace(/\s+/g, " ").trim().slice(0, 120);
      return name ? [[row.id, name] as const] : [];
    }));
  return { userName: lookup(named(userRows)), agentName: lookup(named(agentRows)) };
}
