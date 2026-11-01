import { afterEach, describe, expect, it, vi } from "vitest";
import { muteSqliteExperimentalWarning, restoreEmitWarning } from "@/server/db/sqlite-warning";

const settle = () => new Promise<void>((r) => setImmediate(r));
const SQLITE_MSG = "SQLite is an experimental feature and might change at any time";

describe("sqlite warning filter", () => {
  const added: Array<(w: Error) => void> = [];
  afterEach(() => {
    for (const l of added) process.removeListener("warning", l);
    added.length = 0;
    muteSqliteExperimentalWarning(); // the test setup installs it; keep it installed for other files
  });

  it("does not add, remove or wrap warning listeners", () => {
    restoreEmitWarning();
    const before = process.listeners("warning");
    muteSqliteExperimentalWarning();
    const after = process.listeners("warning");
    expect(after).toEqual(before);
    expect(after.length).toBe(before.length);
  });

  it("drops only the SQLite ExperimentalWarning, in string and Error form", async () => {
    const spy = vi.fn();
    process.on("warning", spy);
    added.push(spy);
    process.emitWarning(SQLITE_MSG, "ExperimentalWarning");
    process.emitWarning(SQLITE_MSG, { type: "ExperimentalWarning" });
    process.emitWarning(Object.assign(new Error(SQLITE_MSG), { name: "ExperimentalWarning" }));
    await settle();
    expect(spy).not.toHaveBeenCalled();

    process.emitWarning("something else is experimental", "ExperimentalWarning");
    process.emitWarning(SQLITE_MSG, "DeprecationWarning"); // same text, different type: still delivered
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ name: "ExperimentalWarning", message: "something else is experimental" });
    expect(spy.mock.calls[1][0]).toMatchObject({ name: "DeprecationWarning" });
  });

  it("keeps once-listener semantics", async () => {
    const once = vi.fn();
    process.once("warning", once);
    added.push(once);
    process.emitWarning("first ordinary warning");
    process.emitWarning("second ordinary warning");
    await settle();
    expect(once).toHaveBeenCalledTimes(1);
    expect(once.mock.calls[0][0]).toMatchObject({ message: "first ordinary warning" });
    expect(process.listeners("warning")).not.toContain(once);
  });

  it("keeps removeListener semantics", async () => {
    const spy = vi.fn();
    process.on("warning", spy);
    process.emitWarning("before removal");
    await settle();
    process.removeListener("warning", spy);
    process.emitWarning("after removal");
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(process.listeners("warning")).not.toContain(spy);
  });
});
