import { SseStreamHistoryPage } from "@/components/sse/sse-stream-history-page";

export default async function SseStreamHistoryRoute({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  return <SseStreamHistoryPage requestId={requestId} />;
}
