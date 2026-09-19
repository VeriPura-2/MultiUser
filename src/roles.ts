/**
 * The five roles every approved organization starts with. These exact names are what
 * document_permission_rules.org_role_name matches against, so they are used consistently in
 * lifecycle functions, tests, and seed data.
 */
export const STANDARD_ROLES = [
  { name: "Organization Admin", is_org_admin: true },
  { name: "Compliance Manager", is_org_admin: false },
  { name: "Compliance User", is_org_admin: false },
  { name: "Reviewer", is_org_admin: false },
  { name: "Viewer", is_org_admin: false },
] as const;

export type StandardRoleName = (typeof STANDARD_ROLES)[number]["name"];

export const ORGANIZATION_ADMIN_ROLE: StandardRoleName = "Organization Admin";
