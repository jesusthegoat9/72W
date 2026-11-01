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

export type ThumbVariant = "rack" | "liquid" | "gpu" | "memory" | "cables" | "chip" | "load" | "night" | "box" | "cores" | "cluster" | "drives" | "paste" | "context" | "traffic" | "build";

export function variantFor(categorySlug: string): ThumbVariant {
  switch (categorySlug) {
    case "liquid-cooling": return "liquid";
    case "bare-metal": return "chip";
    case "big-memory": return "memory";
    case "cable-management": return "cables";
    case "overclocked": return "gpu";
    case "full-load": return "load";
    case "data-center-after-dark": return "night";
    case "fresh-out-the-box": return "box";
    case "hardcore-processing": return "cores";
    case "group-compute": return "cluster";
    case "hot-swaps": return "drives";
    case "thermal-paste": return "paste";
    case "unlimited-context": return "context";
    case "no-rate-limits": return "traffic";
    case "clean-builds": return "build";
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
  } else if (variant === "box") {
    // Open cardboard box with a chassis peeking out, flaps up.
    items.push(`<path d="M70 150 L70 90 L250 90 L250 150 Z" fill="#6b4a2b" stroke="#8a6a45"/>`);
    items.push(`<path d="M70 90 L40 55 L120 55 L160 90 Z" fill="#7d5a36" stroke="#8a6a45"/>`);
    items.push(`<path d="M250 90 L280 55 L200 55 L160 90 Z" fill="#5c3f24" stroke="#8a6a45"/>`);
    items.push(`<rect x="90" y="70" width="140" height="40" rx="2" fill="#0c0f12" stroke="#2a323a"/>`);
    for (let l = 0; l < 6; l++) items.push(`<circle cx="${102 + l * 10}" cy="90" r="2.2" fill="${l === 0 ? accent : "#1f2a30"}"/>`);
    items.push(`<rect x="95" y="62" width="130" height="6" fill="#dfe7ee" opacity="0.5"/>`);
    items.push(`<text x="160" y="170" text-anchor="middle" font-family="monospace" font-size="11" fill="${accent}">FRAGILE · THIS SIDE UP</text>`);
  } else if (variant === "cores") {
    // Die shot: a grid of cores, all lit.
    items.push(`<rect x="70" y="30" width="180" height="120" rx="3" fill="#121519" stroke="#2a323a"/>`);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 8; x++) {
        const hot = r() > 0.25;
        items.push(`<rect x="${78 + x * 21}" y="${38 + y * 27}" width="17" height="22" rx="1" fill="${hot ? accent : "#1f2a30"}" opacity="${hot ? 0.55 + r() * 0.45 : 1}"/>`);
      }
    items.push(`<text x="160" y="168" text-anchor="middle" font-family="monospace" font-size="11" fill="${accent}">${64 + Math.floor(r() * 4) * 32}C / ${(128 + Math.floor(r() * 4) * 64)}T · 100%</text>`);
  } else if (variant === "cluster") {
    // Nodes in a ring with links between them.
    const n = 6;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return [160 + Math.cos(a) * 60, 92 + Math.sin(a) * 52];
    });
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) items.push(`<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[j][0]}" y2="${pts[j][1]}" stroke="${r() > 0.5 ? accent : "#2f3a44"}" stroke-width="1.2" opacity="0.7"/>`);
    for (const [x, y] of pts) {
      items.push(`<rect x="${x - 16}" y="${y - 10}" width="32" height="20" rx="2" fill="#0c0f12" stroke="#3a4650"/>`);
      items.push(`<circle cx="${x - 9}" cy="${y}" r="2" fill="#39d98a"/><circle cx="${x - 2}" cy="${y}" r="2" fill="${accent}"/>`);
    }
  } else if (variant === "drives") {
    // Drive bays with one sled pulled half out.
    const pulled = Math.floor(r() * 8);
    for (let i = 0; i < 8; i++) {
      const x = 44 + (i % 4) * 60;
      const y = 40 + Math.floor(i / 4) * 55;
      const off = i === pulled ? 22 : 0;
      items.push(`<rect x="${x}" y="${y}" width="52" height="44" rx="2" fill="#0c0f12" stroke="#2a323a"/>`);
      items.push(`<rect x="${x + 4 + off}" y="${y + 4}" width="44" height="36" rx="2" fill="${i === pulled ? "#1a1f25" : "#141a20"}" stroke="${i === pulled ? accent : "#3a4650"}"/>`);
      items.push(`<circle cx="${x + 12 + off}" cy="${y + 34}" r="2" fill="${i === pulled ? "#ffb347" : "#39d98a"}"/>`);
      items.push(`<rect x="${x + 36 + off}" y="${y + 10}" width="6" height="20" rx="1" fill="#2f3a44"/>`);
    }
  } else if (variant === "paste") {
    // CPU with an IHS and a blob of paste.
    items.push(`<rect x="90" y="40" width="140" height="110" rx="4" fill="#1b4d2b" stroke="#2f7a46"/>`);
    items.push(`<rect x="110" y="58" width="100" height="76" rx="2" fill="#9aa5ad" stroke="#c9d1d8"/>`);
    items.push(`<text x="160" y="80" text-anchor="middle" font-family="monospace" font-size="8" fill="#5a646c">x86xx-9000X</text>`);
    const style = Math.floor(r() * 3);
    if (style === 0) items.push(`<ellipse cx="160" cy="100" rx="14" ry="11" fill="#e8e8ea"/>`);
    else if (style === 1) items.push(`<rect x="130" y="95" width="60" height="9" rx="4.5" fill="#e8e8ea"/>`);
    else items.push(`<path d="M135 85 L185 115 M185 85 L135 115" stroke="#e8e8ea" stroke-width="8" stroke-linecap="round"/>`);
    items.push(`<rect x="60" y="100" width="22" height="70" rx="3" fill="#2a323a" stroke="#4a555f" transform="rotate(-25 71 135)"/>`);
    items.push(`<rect x="66" y="96" width="10" height="10" fill="${accent}" transform="rotate(-25 71 135)"/>`);
  } else if (variant === "context") {
    // Token bars scrolling off forever.
    for (let i = 0; i < 11; i++) {
      const y = 22 + i * 13;
      let x = 40;
      while (x < 290) {
        const w = 8 + r() * 30;
        const lit = r() > 0.35;
        items.push(`<rect x="${x}" y="${y}" width="${Math.min(w, 290 - x)}" height="8" rx="2" fill="${lit ? (r() > 0.8 ? accent : "#3a5566") : "#1b2228"}"/>`);
        x += w + 4;
      }
    }
    items.push(`<rect x="230" y="0" width="90" height="180" fill="url(#${id})" opacity="0.6"/>`);
    items.push(`<text x="160" y="170" text-anchor="middle" font-family="monospace" font-size="11" fill="${accent}">${(1 + Math.floor(r() * 9))}M tokens · no truncation</text>`);
  } else if (variant === "traffic") {
    // Throughput chart going vertical.
    items.push(`<line x1="40" y1="150" x2="290" y2="150" stroke="#2f3a44"/><line x1="40" y1="30" x2="40" y2="150" stroke="#2f3a44"/>`);
    const pts: string[] = [];
    let yv = 140;
    for (let x = 40; x <= 280; x += 12) {
      yv = Math.max(34, yv - (x > 160 ? 14 + r() * 10 : r() * 4));
      pts.push(`${x},${yv}`);
    }
    items.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${accent}" stroke-width="3" stroke-linejoin="round"/>`);
    items.push(`<polygon points="40,150 ${pts.join(" ")} 280,150" fill="${accent}" opacity="0.15"/>`);
    items.push(`<text x="286" y="26" text-anchor="end" font-family="monospace" font-size="11" fill="${accent}">${(20 + Math.floor(r() * 80)) * 1000} tok/s</text>`);
    items.push(`<text x="286" y="166" text-anchor="end" font-family="monospace" font-size="10" fill="#5f7384">429: 0</text>`);
  } else if (variant === "build") {
    // Tidy tower: PSU shroud, GPU, CPU block, three aligned fans.
    items.push(`<rect x="70" y="20" width="180" height="140" rx="4" fill="#0e1114" stroke="#3a4650"/>`);
    items.push(`<rect x="70" y="130" width="180" height="30" fill="#141a20" stroke="#2a323a"/>`);
    for (let i = 0; i < 3; i++) items.push(`<circle cx="${100 + i * 50}" cy="${36}" r="12" fill="#111519" stroke="#3a4650"/><circle cx="${100 + i * 50}" cy="36" r="3" fill="${accent}"/>`);
    items.push(`<rect x="90" y="60" width="60" height="50" rx="3" fill="#121519" stroke="#3a4650"/><circle cx="120" cy="85" r="14" fill="none" stroke="${accent}" stroke-width="3"/>`);
    items.push(`<rect x="90" y="112" width="150" height="14" rx="2" fill="#0c0f12" stroke="#3a4650"/><circle cx="110" cy="119" r="4" fill="#1f2a30"/><circle cx="150" cy="119" r="4" fill="#1f2a30"/><circle cx="190" cy="119" r="4" fill="#1f2a30"/>`);
    for (let i = 0; i < 4; i++) items.push(`<path d="M${160 + i * 6} 60 L${160 + i * 6} 100 Q ${160 + i * 6} 108 ${168 + i * 6} 108 L 240 108" stroke="#e8e8ea" stroke-width="1.5" fill="none" opacity="0.6"/>`);
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
