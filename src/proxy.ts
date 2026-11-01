import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

const protectedPrefixes = ["/dashboard"];
const authRoutes = ["/login", "/signup"];

/**
 * Auth gate. A session is only valid when its cookie carries a signature
 * made with SESSION_SECRET (see src/lib/session.ts); nothing issues such
 * cookies yet, so in production the dashboard is closed. In `next dev` it is
 * reachable without a cookie so the placeholder UI can be previewed, and the
 * page says so.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  const devBypass = process.env.NODE_ENV === "development";

  const isProtected = protectedPrefixes.some((p) => pathname.startsWith(p));
  const isAuthRoute = authRoutes.includes(pathname);

  if (isProtected && !session && !devBypass) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthRoute && session) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|ico)$).*)"],
};
