import { initials } from "@/lib/format";

export function Avatar({ name, accent, size = 32, className = "" }: { name: string; accent: string; size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold text-black ${className}`}
      style={{ width: size, height: size, background: accent, fontSize: Math.max(10, size * 0.38) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
