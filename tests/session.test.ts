import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "@/lib/session";

describe("signed session cookies", () => {
  it("round-trips a signed cookie and rejects tampering, expiry and missing secret", async () => {
    const cookie = await signSession("user_1", "s3cret", { ttlMs: 60_000 });
    expect((await verifySession(cookie, "s3cret"))?.userId).toBe("user_1");
    expect(await verifySession(cookie, "other")).toBeNull();
    expect(await verifySession(cookie, undefined)).toBeNull();
    expect(await verifySession(`${cookie}x`, "s3cret")).toBeNull();
    expect(await verifySession(cookie.replace("user_1", "user_2"), "s3cret")).toBeNull();
    expect(await verifySession("abc", "s3cret")).toBeNull();
    expect(await verifySession(undefined, "s3cret")).toBeNull();
    const expired = await signSession("user_1", "s3cret", { expiresAt: new Date(Date.now() - 1000) });
    expect(await verifySession(expired, "s3cret")).toBeNull();
  });
});
