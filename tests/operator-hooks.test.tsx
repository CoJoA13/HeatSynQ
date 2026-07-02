import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import { useSetOperatorQuoteLimit } from "@/lib/query/hooks";
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
  Wrapper.displayName = "OperatorHooksTestWrapper";
  return Wrapper;
}

describe("operator seed pins", () => {
  it("pins the 3 seed operators' roles and quote limits", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const ops = await repos.operators.list();
    expect(ops.map((o) => [o.id, o.role, o.quoteAuthLimitCents])).toEqual([
      ["op-dana", "manager", 100_000_00],
      ["op-vance", "sales", 25_000_00],
      ["op-office", "office", 0],
    ]);
  });
});

describe("useSetOperatorQuoteLimit", () => {
  it("happy path: updates the limit and bumps version", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetOperatorQuoteLimit(), { wrapper });

    const vance = (await repos.operators.get("op-vance"))!;
    await act(() => result.current.mutateAsync({ operator: vance, quoteAuthLimitCents: 30_000_00 }));

    const after = (await repos.operators.get("op-vance"))!;
    expect(after.quoteAuthLimitCents).toBe(30_000_00);
    expect(after.version).toBe(1);
    expect(after.role).toBe("sales"); // narrow patch — nothing else changes
  });

  it("stale version rejects with Version conflict, state unchanged", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wrapper = createWrapper(repos);
    const { result } = renderHook(() => useSetOperatorQuoteLimit(), { wrapper });

    const vance = (await repos.operators.get("op-vance"))!;
    await expect(
      result.current.mutateAsync({ operator: { ...vance, version: 99 }, quoteAuthLimitCents: 1 }),
    ).rejects.toThrow("Version conflict");
    expect((await repos.operators.get("op-vance"))!.quoteAuthLimitCents).toBe(25_000_00);
  });
});
