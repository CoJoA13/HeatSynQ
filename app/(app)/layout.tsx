import { AppShellContainer } from "@/components/shell/app-shell-container";
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShellContainer>{children}</AppShellContainer>;
}
