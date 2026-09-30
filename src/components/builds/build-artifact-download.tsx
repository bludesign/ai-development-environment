"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { ServerUrlPicker } from "@/components/server-urls/server-url-controls";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { serverUrlOptions, type ServerUrlKind } from "@/lib/server-urls";

export function BuildArtifactDownload({
  buildId,
  artifactId,
  children,
}: {
  buildId: string;
  artifactId: string;
  children: React.ReactNode;
}) {
  const { settings } = useServerUrlSettings();
  const [kind, setKind] = useState<ServerUrlKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        buildArtifactLinks: { downloadUrl: string };
      }>(
        `query DownloadBuildArtifact($buildId: ID!, $artifactId: ID!, $kind: ServerUrlKind) { buildArtifactLinks(buildId: $buildId, artifactId: $artifactId, serverUrlKind: $kind) { downloadUrl } }`,
        { buildId, artifactId, kind: kind ?? settings?.defaultServerUrlKind },
      );
      window.location.assign(data.buildArtifactLinks.downloadUrl);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Download />
          {children}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="space-y-3">
        <ServerUrlPicker value={kind} onValueChange={setKind} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          disabled={
            busy ||
            !settings ||
            !serverUrlOptions(settings).some(
              (option) =>
                option.kind === (kind ?? settings.defaultServerUrlKind),
            )
          }
          onClick={() => void download()}
        >
          <Download />
          {children}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
