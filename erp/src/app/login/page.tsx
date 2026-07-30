"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100">
      <form onSubmit={submit} className="w-80 rounded-lg bg-white p-6 shadow">
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        <label className="mb-2 block text-sm">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus
            className="mt-1 w-full rounded border px-2 py-1" />
        </label>
        <label className="mb-4 block text-sm">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-2 py-1" />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button className="w-full rounded bg-slate-800 py-2 text-white">Sign in</button>
      </form>
    </main>
  );
}
