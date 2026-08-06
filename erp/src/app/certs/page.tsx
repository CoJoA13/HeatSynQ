import { CertList } from "./CertList";

// Thin Server Component wrapper — every other page.tsx in this app is itself "use client" with
// its component inline, so this split is not an existing precedent; it is simply the two-file
// layout this task's own brief specified (page.tsx + CertList.tsx). Keeping the split gives a
// future server-only concern (metadata, a server-rendered shell) somewhere to land without
// disturbing the client component itself.
export default function CertsPage() {
  return <CertList />;
}
