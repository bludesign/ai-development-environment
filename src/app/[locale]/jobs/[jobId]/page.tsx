import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { JobMonitor } from "@/components/agents/job-monitor";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { locale, jobId } = await params;
  const t = await getTranslations({ locale, namespace: "jobs" });
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/agents">
            <ArrowLeft />
            {t("back")}
          </Link>
        </Button>
      </div>
      <JobMonitor key={jobId} jobId={jobId} />
    </div>
  );
}
