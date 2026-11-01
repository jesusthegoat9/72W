import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// Every page in this group reads the database, so render on each request.
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6">{children}</main>
      <SiteFooter />
    </>
  );
}
