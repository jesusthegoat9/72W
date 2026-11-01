import type { TextGenerationRequest, TextGenerationResult, TextProvider } from "./text";

/**
 * Deterministic mock "model". Produces hardware-themed parody listings from
 * templates, seeded by the prompt so the same job always yields the same
 * output (useful for idempotency tests). No network, no cost.
 */
export class MockTextProvider implements TextProvider {
  readonly name = "mock" as const;

  constructor(private readonly opts: { failWhenPromptIncludes?: string } = {}) {}

  async generate(req: TextGenerationRequest): Promise<TextGenerationResult> {
    if (this.opts.failWhenPromptIncludes && req.userPrompt.includes(this.opts.failWhenPromptIncludes)) {
      throw new Error("mock text provider: simulated failure");
    }
    const rng = mulberry32(hash(req.systemPrompt + req.userPrompt));
    const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
    const category = /category:\s*([a-z-]+)/i.exec(req.userPrompt)?.[1] ?? "hot-racks";
    const voice = /voice:\s*([^\n]+)/i.exec(req.systemPrompt)?.[1] ?? "";

    const subject = pick(SUBJECTS[category] ?? SUBJECTS["hot-racks"]);
    const hook = pick(HOOKS);
    const payoff = pick(PAYOFFS);
    let title = `${hook}: ${subject}`;
    let description = `${subject} ${payoff} ${pick(CLOSERS)}`;

    if (/loud|hype/.test(voice)) {
      title = title.replace(/\b(full|every|all|massive|load)\b/gi, (m) => m.toUpperCase());
      description = `${description} BIG FELLA DELIVERS.`;
    } else if (/asmr|whisper/.test(voice)) {
      title = title.toLowerCase();
      description = `shhh. ${description.toLowerCase()}`;
    } else if (/gothic|nocturnal/.test(voice)) {
      description = `${description} VRAMpire watched the whole thing from the dark.`;
    } else if (/manic|scientific/.test(voice)) {
      description = `${description} HA HA HA. Science!`;
    } else if (/zen|minimal/.test(voice)) {
      description = `${description.split(". ")[0]}. The rack is quiet now.`;
    }

    const text = JSON.stringify({ title, description, tags: [category, ...subject.toLowerCase().split(" ").slice(0, 2)] });
    const inputTokens = Math.ceil((req.systemPrompt.length + req.userPrompt.length) / 4);
    return {
      text,
      provider: "mock",
      model: "mock-listing-v1",
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) },
      estimatedCostUsd: 0,
      simulated: true,
    };
  }
}

const SUBJECTS: Record<string, string[]> = {
  "hot-racks": ["A 42U Rack With Nothing Left To Give", "Sixteen Blades In One Chassis", "The Hot Aisle At Peak Density"],
  "liquid-cooling": ["A 480mm Radiator In Silence", "An Immersion Tank Reveal", "The Quietest D5 Pump Alive"],
  "bare-metal": ["A Dual-Socket Board Fresh From The Crate", "First POST On Bare Silicon", "256 Cores And No Hypervisor"],
  "big-memory": ["Thirty-Two DIMMs Fully Populated", "80GB Of HBM Under The Macro Lens", "Zero Bytes Of Swap"],
  "cable-management": ["A 48-Port Panel Dressed By Hand", "Velcro Only, No Zip Ties", "One Vertical Bundle, Labelled"],
  overclocked: ["6.1GHz On A Frosted Pot", "A Voltage Curve With No Fear", "Timings Tightened Past Reason"],
  "full-load": ["Eight Accelerators At 100%", "Fans With The Curve Removed", "A 72-Hour Training Run"],
  "data-center-after-dark": ["Blinkenlights After Midnight", "The Night Shift At An Empty NOC", "Eleven Hours Of Server Hum"],
};
const HOOKS = ["Full Load", "Barely Specced", "Fresh Out Of The Crate", "After Hours", "No Throttle", "Maxed Out", "Sustained Boost"];
const PAYOFFS = [
  "runs hotter than the spec sheet admits and never once backs down.",
  "gets pushed to its absolute limit while the sensors scream.",
  "is filmed up close, slowly, with every LED in frame.",
  "goes all night at 100% and the power meter is rude about it.",
];
const CLOSERS = ["Uncut.", "No commentary, just hardware.", "You will want the long version.", "Headphones recommended."];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
