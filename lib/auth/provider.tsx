"use client";
import { createContext, useContext, useState, useEffect } from "react";
import type { Operator, RoleKey } from "@/lib/domain";
import { useRepositories } from "@/lib/data/provider";
import { can, type Permission } from "./permissions";

type AuthCtx = {
  operator: Operator | null;
  viewAs: RoleKey;
  setViewAs: (r: RoleKey) => void;
  login: (operatorId: string) => Promise<void>;
  logout: () => void;
};
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const repos = useRepositories();
  const [operator, setOperator] = useState<Operator | null>(null);
  const [viewAs, setViewAs] = useState<RoleKey>("manager");

  // auto-login the demo manager on mount (mocked auth). Best-effort: a failed
  // operator fetch just leaves the session logged out — never an unhandled rejection.
  useEffect(() => {
    login("op-dana").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; login is stable in this mock
  }, []);

  async function login(operatorId: string) {
    const op = await repos.operators.get(operatorId);
    if (op) { setOperator(op); setViewAs(op.role); }
  }
  function logout() { setOperator(null); }

  return <Ctx.Provider value={{ operator, viewAs, setViewAs, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
// Permissions follow the authenticated operator's real role, NOT `viewAs`.
// `viewAs` is a display-only "Viewing as" preview for the Today dashboard;
// it must never grant or revoke actions elsewhere in the app.
export function useCan(perm: Permission): boolean {
  const { operator } = useAuth();
  return operator ? can(operator.role, perm) : false;
}
