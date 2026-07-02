import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import { useSetEquipmentAvailability, useCompleteMaintenance } from "@/lib/query/hooks";
import { DEMO_NOW } from "@/lib/clock";
import type { ReactNode } from "react";

function createWrapper(repositories = createMockRepositories({ latencyMs: 0 })) {
  const Wrapper = ({ children }: { children: ReactNode }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={client}>
        <RepositoriesProvider repositories={repositories}>
          <AuthProvider>{children}</AuthProvider>
        </RepositoriesProvider>
      </QueryClientProvider>
    );
  };
  Wrapper.displayName = "EquipmentHooksTestWrapper";
  return Wrapper;
}

describe("equipment mutation hooks", () => {
  it("setEquipmentAvailability happy path", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetEquipmentAvailability(), { wrapper });

    const unit = (await repos.equipment.get("eq-iq-1"))!;
    await act(() =>
      result.current.mutateAsync({ equipment: unit, availability: "down", note: "Burner fault" }),
    );
    const after = (await repos.equipment.get("eq-iq-1"))!;
    expect(after.availability).toBe("down");
    expect(after.note).toBe("Burner fault");
    expect(after.version).toBe(1);
  });

  it("setEquipmentAvailability stale version rejects, state unchanged", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetEquipmentAvailability(), { wrapper });

    const unit = (await repos.equipment.get("eq-iq-1"))!;
    await expect(
      result.current.mutateAsync({
        equipment: { ...unit, version: 99 },
        availability: "down",
        note: "x",
      }),
    ).rejects.toThrow("Version conflict");
    expect((await repos.equipment.get("eq-iq-1"))!.availability).toBe("available");
  });

  it("completeMaintenance rolls the SAT forward from DEMO_NOW", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useCompleteMaintenance(), { wrapper });

    const task = (await repos.maintenance.get("mnt-vac-1-sat"))!;
    await act(() => result.current.mutateAsync({ task, at: DEMO_NOW }));
    const rolled = (await repos.maintenance.get("mnt-vac-1-sat"))!;
    expect(rolled.lastDoneAt).toBe("2026-06-30T00:00:00.000Z");
    expect(rolled.nextDueAt).toBe("2026-07-30T00:00:00.000Z");
    expect(rolled.version).toBe(1);
  });

  it("completeMaintenance stale version rejects, dates unchanged", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useCompleteMaintenance(), { wrapper });

    const task = (await repos.maintenance.get("mnt-vac-1-sat"))!;
    await expect(
      result.current.mutateAsync({ task: { ...task, version: 99 }, at: DEMO_NOW }),
    ).rejects.toThrow("Version conflict");
    expect((await repos.maintenance.get("mnt-vac-1-sat"))!.nextDueAt).toBe("2026-06-30T00:00:00.000Z");
  });
});
