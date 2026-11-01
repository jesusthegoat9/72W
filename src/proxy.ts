import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSessionCookie } from "@/lib/session";

const protectedPrefixes = ["/dashboard"];
const authRoutes = ["/login", "/signup"];

/**
 * Optimistic auth gate. Real auth does not exist yet: any non-empty session
 * cookie passes. In development the dashboard is reachable without a cookie
 * so the placeholder UI can be previewed; the page shows a banner saying so.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = readSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
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
