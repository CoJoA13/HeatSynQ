"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/provider";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { Label } from "@/lib/ui/label";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [id, setId] = useState("op-dana");
  return (
    <div className="grid min-h-screen place-items-center bg-canvas">
      <form className="w-80 space-y-4 rounded-card border border-border bg-surface p-6"
        onSubmit={async (e) => { e.preventDefault(); await login(id); router.push("/today"); }}>
        <div className="font-mono text-primary text-lg font-semibold">HeatSynQ</div>
        <div className="space-y-1">
          <Label htmlFor="op">Operator</Label>
          <Input id="op" value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <Button type="submit" className="w-full">Sign in</Button>
        <p className="text-text-muted text-xs">Demo: op-dana (manager), op-vance (sales), op-office (office)</p>
      </form>
    </div>
  );
}
