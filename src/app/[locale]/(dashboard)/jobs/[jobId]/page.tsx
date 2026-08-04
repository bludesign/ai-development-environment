import { JobMonitor } from "@/components/agents/job-monitor";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { jobId } = await params;
  return (
    <div className="flex w-full flex-col gap-4">
      <JobMonitor key={jobId} jobId={jobId} />
    </div>
  );
}
