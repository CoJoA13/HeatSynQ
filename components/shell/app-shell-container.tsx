"use client";
import { AppShell } from "./app-shell";
import { useNavBadges } from "@/lib/query/hooks";

export function AppShellContainer({ children }: { children: React.ReactNode }) {
  const badges = useNavBadges();
  return <AppShell badges={badges}>{children}</AppShell>;
}
