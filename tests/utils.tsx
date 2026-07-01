import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoriesProvider } from "@/lib/data/provider";
import { AuthProvider } from "@/lib/auth/provider";
import { createMockRepositories } from "@/lib/data/mock/repositories";
import type { Repositories } from "@/lib/data/repositories";

export function renderWithProviders(
  ui: ReactNode,
  opts: { repositories?: Repositories } = {},
): RenderResult {
  const repositories = opts.repositories ?? createMockRepositories({ latencyMs: 0 });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RepositoriesProvider repositories={repositories}>
        <AuthProvider>{ui}</AuthProvider>
      </RepositoriesProvider>
    </QueryClientProvider>,
  );
}
