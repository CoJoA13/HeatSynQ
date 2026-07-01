"use client";
import { useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children, badges }: { children: React.ReactNode; badges?: Record<string, number> }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar badges={badges} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1060px]">{children}</div>
        </main>
      </div>
      {/* CommandPalette mounted here in Task 17 using paletteOpen/setPaletteOpen */}
    </div>
  );
}
