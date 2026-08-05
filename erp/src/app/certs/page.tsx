import { CertList } from "./CertList";

// Thin wrapper — the customers/parts precedent of keeping `page.tsx` as the route's entry point
// while the actual "use client" component lives in its own file (CertList.tsx), so a future
// server-only concern (metadata, a server-rendered shell) has somewhere to land without
// disturbing the client component itself.
export default function CertsPage() {
  return <CertList />;
}
