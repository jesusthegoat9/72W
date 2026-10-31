import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSessionCookie } from "@/lib/session";

const protectedPrefixes = ["/dashboard"];
const authRoutes = ["/login", "/signup"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = readSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);

  const isProtected = protectedPrefixes.some((p) => pathname.startsWith(p));
  const isAuthRoute = authRoutes.includes(pathname);

  if (isProtected && !session) {
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
