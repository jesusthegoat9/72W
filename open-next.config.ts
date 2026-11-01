import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal config: SSR only. No incremental cache is configured because the app
// renders DB-backed routes dynamically and does not use ISR or "use cache".
const config = defineCloudflareConfig({});

export default config;
