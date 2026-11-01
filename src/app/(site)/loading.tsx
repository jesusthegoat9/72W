import { VideoGridSkeleton } from "@/components/video-card";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-7 w-48 rounded bg-surface-2" />
      <VideoGridSkeleton count={8} />
    </div>
  );
}
