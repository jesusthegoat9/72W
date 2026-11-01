/**
 * Original, procedurally drawn thumbnail art. Deterministic per seed so a
 * video always gets the same picture. No external assets.
 */
function prng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ThumbVariant = "rack" | "liquid" | "gpu" | "memory" | "cables" | "chip" | "load" | "night";

export function variantFor(categorySlug: string): ThumbVariant {
  switch (categorySlug) {
    case "liquid-cooling": return "liquid";
    case "bare-metal": return "chip";
    case "big-memory": return "memory";
    case "cable-management": return "cables";
    case "overclocked": return "gpu";
    case "full-load": return "load";
    case "data-center-after-dark": return "night";
    default: return "rack";
  }
}

export function Thumb({ seed, accent = "#ff5a1f", variant = "rack", className = "" }: { seed: string; accent?: string; variant?: ThumbVariant; className?: string }) {
  const r = prng(seed + variant);
  const hue = Math.floor(r() * 360);
  const bg1 = `hsl(${hue} 30% 8%)`;
  const bg2 = `hsl(${(hue + 40) % 360} 35% 14%)`;
  const id = `g${seed.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
  const items: string[] = [];

  if (variant === "rack" || variant === "load" || variant === "night") {
    const rows = 9 + Math.floor(r() * 4);
    for (let i = 0; i < rows; i++) {
      const y = 18 + i * (144 / rows);
      const h = 144 / rows - 4;
      items.push(`<rect x="40" y="${y}" width="240" height="${h}" rx="2" fill="#0c0f12" stroke="#2a323a"/>`);
      const leds = 3 + Math.floor(r() * 5);
      for (let l = 0; l < leds; l++) {
        const on = variant === "night" ? r() > 0.3 : variant === "load" ? true : r() > 0.5;
        const c = on ? (variant === "load" && r() > 0.6 ? accent : variant === "night" ? "#4ea8ff" : "#39d98a") : "#1f2a30";
        items.push(`<circle cx="${52 + l * 10}" cy="${y + h / 2}" r="2.2" fill="${c}"/>`);
      }
      if (r() > 0.5) items.push(`<rect x="${150 + r() * 80}" y="${y + 3}" width="${30 + r() * 60}" height="${h - 6}" rx="1" fill="#171c21"/>`);
    }
    if (variant === "load") items.push(`<text x="160" y="100" text-anchor="middle" font-family="monospace" font-size="34" font-weight="700" fill="${accent}" opacity="0.9">100%</text>`);
  } else if (variant === "liquid") {
    items.push(`<rect x="60" y="30" width="200" height="120" rx="8" fill="#071a22" stroke="#1d4a5c"/>`);
    items.push(`<rect x="60" y="${70 + r() * 20}" width="200" height="80" rx="0" fill="#0a3340" opacity="0.8"/>`);
    for (let i = 0; i < 4; i++) items.push(`<rect x="${80 + i * 45}" y="60" width="26" height="80" rx="2" fill="#0c0f12" stroke="#2a323a"/>`);
    for (let i = 0; i < 14; i++) items.push(`<circle cx="${70 + r() * 180}" cy="${80 + r() * 60}" r="${1 + r() * 2.5}" fill="#4cc9f0" opacity="${0.3 + r() * 0.6}"/>`);
    items.push(`<path d="M20 90 C 40 60, 60 120, 60 90" stroke="${accent}" stroke-width="4" fill="none"/>`);
  } else if (variant === "gpu" || variant === "chip") {
    items.push(`<rect x="50" y="50" width="220" height="80" rx="6" fill="#0c0f12" stroke="#2a323a"/>`);
    const fans = variant === "gpu" ? 2 + Math.floor(r() * 2) : 0;
    for (let i = 0; i < fans; i++) {
      const cx = 90 + i * 70;
      items.push(`<circle cx="${cx}" cy="90" r="28" fill="#111519" stroke="#2a323a"/>`);
      for (let b = 0; b < 7; b++) {
        const a = (b / 7) * Math.PI * 2 + r();
        items.push(`<line x1="${cx}" y1="90" x2="${cx + Math.cos(a) * 24}" y2="${90 + Math.sin(a) * 24}" stroke="#2f3a44" stroke-width="5" stroke-linecap="round"/>`);
      }
    }
    if (variant === "chip") {
      items.push(`<rect x="130" y="70" width="60" height="40" rx="2" fill="#1a1f25" stroke="${accent}"/>`);
      items.push(`<rect x="145" y="80" width="30" height="20" fill="${accent}" opacity="0.8"/>`);
      for (let i = 0; i < 12; i++) items.push(`<rect x="${132 + i * 5}" y="46" width="2" height="6" fill="#8a94a0"/><rect x="${132 + i * 5}" y="128" width="2" height="6" fill="#8a94a0"/>`);
    }
    items.push(`<rect x="50" y="130" width="140" height="8" fill="#b8860b"/>`);
    items.push(`<text x="258" y="68" text-anchor="end" font-family="monospace" font-size="12" fill="${accent}">${variant === "gpu" ? `${(5.2 + r() * 1.2).toFixed(1)}GHz` : "SOCKET"}</text>`);
  } else if (variant === "memory") {
    for (let i = 0; i < 8; i++) {
      const x = 44 + i * 30;
      items.push(`<rect x="${x}" y="40" width="20" height="100" rx="1" fill="#0f2a1c" stroke="#1f5a3a"/>`);
      for (let c = 0; c < 6; c++) items.push(`<rect x="${x + 4}" y="${48 + c * 14}" width="12" height="9" fill="#111519" stroke="#2a323a"/>`);
      items.push(`<rect x="${x}" y="140" width="20" height="4" fill="#b8860b"/>`);
    }
    items.push(`<text x="160" y="30" text-anchor="middle" font-family="monospace" font-size="12" fill="${accent}">${64 * (1 + Math.floor(r() * 32))}GB</text>`);
  } else if (variant === "cables") {
    items.push(`<rect x="40" y="20" width="240" height="140" rx="3" fill="#0c0f12" stroke="#2a323a"/>`);
    const colors = [accent, "#4ea8ff", "#39d98a", "#ffd166", "#ffffff"];
    for (let i = 0; i < 24; i++) {
      const x = 52 + i * 9.6;
      const c = colors[Math.floor(r() * colors.length)];
      items.push(`<rect x="${x}" y="40" width="6" height="10" fill="#1f2a30"/>`);
      items.push(`<path d="M${x + 3} 50 C ${x + 3} 90, ${160} 90, 160 150" stroke="${c}" stroke-width="2.2" fill="none" opacity="0.9"/>`);
    }
    items.push(`<rect x="150" y="135" width="20" height="10" rx="2" fill="#333" stroke="#555"/>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
<rect width="320" height="180" fill="url(#${id})"/>
${items.join("\n")}
<rect width="320" height="180" fill="url(#${id})" opacity="0.15"/>
</svg>`;
  return <div className={`h-full w-full ${className}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
