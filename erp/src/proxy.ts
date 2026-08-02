import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Duplicated from `SESSION_COOKIE` in `@/server/http` rather than imported: that module
// pulls in `./sessions` -> `./db` (Prisma), and this runs on the Edge runtime, which cannot
// load the Prisma client. Keep this in sync with `SESSION_COOKIE` by hand.
const SESSION_COOKIE = "erp_session";

// Next 16 renamed the `middleware` file convention to `proxy` — same execution model, same
// `config.matcher`, only the file and function names changed.
//
// Coarse gate only: cookie presence, not validity — this cannot reach the DB. Real
// authorization happens in every API route via requireUser/mustCan; any future server-rendered
// page that fetches data must call requireUser itself.
export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/login") return NextResponse.next();

  if (!req.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
