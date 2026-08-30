import { SseEndpointEditorPage } from "@/components/sse/sse-endpoint-editor-page";

export default async function SseEndpointRoute({
  params,
}: {
  params: Promise<{ endpointId: string }>;
}) {
  const { endpointId } = await params;
  return <SseEndpointEditorPage endpointId={endpointId} />;
}
