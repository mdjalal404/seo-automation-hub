/**
 * Role → capability matrix. Used by server actions for authorization and by the
 * UI only to decide what to render. RLS policies and RPCs enforce the same rules
 * independently in the database.
 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | "workspace.manage"
  | "members.manage"
  | "clients.manage"
  | "websites.manage"
  | "connections.manage"
  | "rules.manage"
  | "content.create"
  | "content.edit_any"
  | "content.edit_own"
  | "content.validate"
  | "content.approve"
  | "content.publish"
  | "content.push_draft"
  | "jobs.cancel"
  | "jobs.retry"
  | "reports.view"
  | "audit.view";

const MATRIX: Record<Role, readonly Capability[]> = {
  owner: [
    "workspace.manage", "members.manage", "clients.manage", "websites.manage", "connections.manage", "rules.manage",
    "content.create", "content.edit_any", "content.edit_own", "content.validate", "content.approve", "content.publish",
    "content.push_draft", "jobs.cancel", "jobs.retry", "reports.view", "audit.view",
  ],
  admin: [
    "clients.manage", "websites.manage", "connections.manage", "rules.manage",
    "content.create", "content.edit_any", "content.edit_own", "content.validate", "content.approve", "content.publish",
    "content.push_draft", "jobs.cancel", "jobs.retry", "reports.view", "audit.view",
  ],
  member: ["content.create", "content.edit_own", "content.validate", "content.push_draft", "reports.view"],
  viewer: ["reports.view"],
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return !!role && MATRIX[role].includes(capability);
}

export function canEditContent(
  role: Role | null | undefined,
  userId: string,
  item: { created_by: string | null; assigned_to: string | null },
): boolean {
  if (can(role, "content.edit_any")) return true;
  return can(role, "content.edit_own") && (item.created_by === userId || item.assigned_to === userId);
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
