import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets an isolated in-memory database and a throwaway media dir.
process.env.SQLITE_PATH = ":memory:";
process.env.MEDIA_ROOT = mkdtempSync(path.join(os.tmpdir(), "x86xx-media-"));
process.env.JOBS_API_TOKEN = "test-token";
process.env.GENERATION_LIVE = "false";
process.env.GENERATION_DRY_RUN = "true";
process.env.GENERATION_RETRY_BACKOFF_SECONDS = "0";
process.env.SESSION_SECRET = "test-session-secret";
