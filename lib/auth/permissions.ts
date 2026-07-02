import type { RoleKey } from "@/lib/domain";

/** Display order for the Setup permission-matrix view. */
export const PERMISSIONS = ["approve_over_limit", "apply_discount", "release_cert", "close_period", "edit_setup", "schedule_loads", "maintain_equipment"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const MATRIX: Record<Permission, RoleKey[]> = {
  approve_over_limit: ["manager"],
  apply_discount: ["manager", "sales"],
  release_cert: ["manager"],
  close_period: ["manager", "office"],
  edit_setup: ["manager"],
  schedule_loads: ["manager", "office"],
  maintain_equipment: ["manager", "office"],
};

export const permissionMeta: Record<Permission, { label: string }> = {
  approve_over_limit: { label: "Approve over-limit quotes" },
  apply_discount: { label: "Apply discounts" },
  release_cert: { label: "Release certifications" },
  close_period: { label: "Close A/R period" },
  edit_setup: { label: "Edit setup" },
  schedule_loads: { label: "Schedule loads" },
  maintain_equipment: { label: "Maintain equipment" },
};

export function can(role: RoleKey, perm: Permission): boolean {
  return MATRIX[perm].includes(role);
}
