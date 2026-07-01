"use client";
import { createContext, useContext, useMemo } from "react";
import type { Repositories } from "@/lib/data/repositories";
import { createMockRepositories } from "@/lib/data/mock/repositories";

const Ctx = createContext<Repositories | null>(null);

export function RepositoriesProvider({ children }: { children: React.ReactNode }) {
  const repos = useMemo(() => createMockRepositories(), []);
  return <Ctx.Provider value={repos}>{children}</Ctx.Provider>;
}

export function useRepositories(): Repositories {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRepositories must be used within RepositoriesProvider");
  return r;
}
