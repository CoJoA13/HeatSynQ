import type { RoleKey } from "@/lib/domain";

export type Permission = "approve_over_limit" | "apply_discount" | "release_cert" | "close_period" | "edit_setup" | "schedule_loads";

const MATRIX: Record<Permission, RoleKey[]> = {
  approve_over_limit: ["manager"],
  apply_discount: ["manager", "sales"],
  release_cert: ["manager"],
  close_period: ["manager", "office"],
  edit_setup: ["manager"],
  schedule_loads: ["manager", "office"],
};

export function can(role: RoleKey, perm: Permission): boolean {
  return MATRIX[perm].includes(role);
}
