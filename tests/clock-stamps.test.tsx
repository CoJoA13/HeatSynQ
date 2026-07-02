import { describe, it, expect } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import { useTrackInStep } from "@/lib/query/hooks";
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
  Wrapper.displayName = "ClockStampsTestWrapper";
  return Wrapper;
}

describe("mutation stamps use the frozen clock", () => {
  it("track-in stamps trackedInAt and activity with DEMO_NOW", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const operator = (await repos.operators.get("op-dana"))!;
    const order = (await repos.workOrders.get("wo-48205"))!; // step 3 (Temper) is pending
    const { result } = renderHook(() => useTrackInStep(), { wrapper: createWrapper(repos) });
    await act(async () => {
      await result.current.mutateAsync({ order, stepN: 3, operator });
    });
    await waitFor(async () => {
      const updated = (await repos.workOrders.get("wo-48205"))!;
      const step = updated.steps.find((s) => s.n === 3)!;
      expect(step.trackedInAt).toBe(DEMO_NOW);
      expect(updated.activity[updated.activity.length - 1].at).toBe(DEMO_NOW);
    });
  });
});
