import { plistDocument } from "@ai-development-environment/agent-contract/plist";

import { signArtifactToken } from "@/lib/artifact-token";
import {
  configuredServerOrigin,
  ServerUrlSelectionError,
} from "@/server/configured-server-origin";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 30;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Serves the manifest that iOS reads when installing a build over the air.
 *
 * Responses here are consumed by the install daemon rather than a person, so the
 * error bodies are deliberately plain English and untranslated; the equivalents a
 * user actually sees live in the install button.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ buildId: string; artifactId: string }> },
): Promise<Response> {
  try {
    const { buildId, artifactId } = await context.params;
    const services = getServerServices();
    const artifact = await services.buildsService.artifactForInstall(
      buildId,
      artifactId,
    );
    if (!artifact) {
      return new Response("Artifact not found", { status: 404 });
    }
    if (artifact.kind !== "IPA") {
      return new Response("Only IPA artifacts can be installed over the air", {
        status: 400,
      });
    }
    if (artifact.metadata.exportMethod === "APP_STORE_CONNECT") {
      return new Response(
        "App Store Connect builds cannot be installed over the air. Export with Debugging, Release Testing, or Enterprise instead.",
        { status: 409 },
      );
    }
    const bundleIdentifier = text(artifact.metadata.bundleIdentifier);
    if (!bundleIdentifier) {
      return new Response(
        "The bundle identifier is unavailable. Export the archive again to enable installation.",
        { status: 409 },
      );
    }

    const origin = await configuredServerOrigin(
      request.headers,
      new URL(request.url).searchParams.get("serverUrlKind"),
    );
    if (!origin || !origin.secure) {
      return new Response(
        "Over-the-air installation requires an HTTPS server URL. Choose Remote or configure an HTTPS address in Settings.",
        { status: 409 },
      );
    }

    const { token, expires } = signArtifactToken(artifactId);
    const packageUrl = `${origin.origin}/api/public/builds/${encodeURIComponent(buildId)}/artifacts/${encodeURIComponent(artifactId)}?token=${token}&expires=${expires}`;

    const manifest = plistDocument({
      items: [
        {
          assets: [{ kind: "software-package", url: packageUrl }],
          metadata: {
            "bundle-identifier": bundleIdentifier,
            "bundle-version":
              text(artifact.metadata.bundleShortVersion) ??
              text(artifact.metadata.bundleVersion) ??
              "1.0",
            kind: "software",
            title: text(artifact.metadata.applicationName) ?? bundleIdentifier,
          },
        },
      ],
    });

    return new Response(manifest, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/xml",
      },
    });
  } catch (error) {
    if (error instanceof ServerUrlSelectionError)
      return new Response(error.message, { status: error.status });
    console.error("Build artifact manifest failed:", error);
    return new Response("Could not build the install manifest", {
      status: 500,
    });
  }
}
