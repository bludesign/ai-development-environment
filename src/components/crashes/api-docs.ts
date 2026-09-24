/**
 * The resumable dSYM upload as a shell script, for CI runners uploading zips
 * larger than a proxy lets through in one request. Needs `curl` and `jq`,
 * which GitHub's macOS and Ubuntu runners ship with.
 */
export const DSYM_UPLOAD_SCRIPT = `#!/usr/bin/env bash
# Usage: AIDE_URL=… AIDE_API_KEY=… ./upload-dsyms.sh dSYMs.zip
# Optional: PROJECT_NAME, BUILD_ID, BUILD_URL
set -euo pipefail
ZIP="$1"
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
SHA=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
CHUNK=$((16 * 1024 * 1024))
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BODY=$(jq -n --arg filename "$(basename "$ZIP")" --argjson sizeBytes "$SIZE" \\
  --arg sha256 "$SHA" --arg projectName "\${PROJECT_NAME:-}" \\
  --arg buildId "\${BUILD_ID:-}" --arg url "\${BUILD_URL:-}" '$ARGS.named')
ID=$(curl -sSf -H "X-API-Key: $AIDE_API_KEY" -H 'content-type: application/json' \\
  -d "$BODY" "$AIDE_URL/api/dsyms/uploads" | jq -r .id)
OFFSET=0
while [ "$OFFSET" -lt "$SIZE" ]; do
  dd if="$ZIP" of="$TMP/chunk" bs="$CHUNK" skip=$((OFFSET / CHUNK)) count=1 2>/dev/null
  curl -sSf --retry 3 --retry-all-errors -X PATCH \\
    -H "X-API-Key: $AIDE_API_KEY" -H "Upload-Offset: $OFFSET" \\
    -H 'content-type: application/offset+octet-stream' \\
    --data-binary @"$TMP/chunk" "$AIDE_URL/api/dsyms/uploads/$ID"
  OFFSET=$((OFFSET + $(wc -c < "$TMP/chunk")))
done
curl -sSf -X POST -H "X-API-Key: $AIDE_API_KEY" \\
  "$AIDE_URL/api/dsyms/uploads/$ID/complete"
`;

export function crashApiDocumentation(baseUrl: string): string {
  const crashes = `${baseUrl}/api/public/crashes`;
  const dsyms = `${baseUrl}/api/dsyms`;
  return `# Crash and dSYM upload API

## Crash reports

\`POST ${crashes}\` takes one crash report as the raw body: an \`.ips\` report, a \`.crash\` text report, or MetricKit JSON (an \`MXDiagnosticPayload\` or a single \`MXCrashDiagnostic\`). The body may be gzip-compressed and is capped at 5 MiB after decoding. No credential is needed, so shipped apps can report; send \`X-API-Key\` to record which key uploaded it. Anonymous uploads are limited to 30 a minute per address and are refused with 202 while crash collection is off.

\`\`\`bash
curl --request POST '${crashes}' \\
  --header 'content-type: application/json' \\
  --header 'x-crash-filename: MyApp-2026-09-20.ips' \\
  --data-binary @MyApp-2026-09-20.ips
\`\`\`

From an app, forward MetricKit crash diagnostics when they arrive:

\`\`\`swift
import MetricKit

final class CrashReporter: NSObject, MXMetricManagerSubscriber {
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for payload in payloads where !(payload.crashDiagnostics ?? []).isEmpty {
      var request = URLRequest(url: URL(string: "${crashes}")!)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = payload.jsonRepresentation()
      URLSession.shared.dataTask(with: request).resume()
    }
  }
}
// At launch: MXMetricManager.shared.add(crashReporter)
\`\`\`

Responses: 201 with \`{ "crashes": [{ "id", "status", "url" }] }\`, 200 for a report already uploaded, 413 over 5 MiB, 415 for an unrecognized format, 422 for an .ips that is not a crash, and 429 when rate limited.

## dSYMs

\`POST ${dsyms}\` takes a zip of one or more \`.dSYM\` bundles. An \`X-API-Key\` from the API Keys page is required. \`buildId\`, \`url\`, and \`projectName\` are optional and are shown on the dSYM.

\`\`\`bash
(cd MyApp.xcarchive/dSYMs && zip -qry ../../dSYMs.zip .)
curl --fail-with-body --header "X-API-Key: $AIDE_API_KEY" \\
  --form file=@dSYMs.zip --form projectName=MyApp \\
  --form buildId=1234 --form url=https://ci.example.com/runs/1234 \\
  '${dsyms}'
\`\`\`

The response lists every dSYM with its UUIDs, which match \`xcrun dwarfdump --uuid\`. Crashes waiting on those UUIDs are symbolicated again automatically.

### GitHub Actions

The \`bludesign/ai-development-environment-upload-dsyms\` action finds and zips the dSYMs, uploads them through the resumable protocol below, and retries through proxies such as Cloudflare. It records the repository, run ID, and run link. Store the key as the \`AIDE_API_KEY\` secret:

\`\`\`yaml
- name: Upload dSYMs
  uses: bludesign/ai-development-environment-upload-dsyms@v1
  with:
    url: ${baseUrl}
    api_key: \${{ secrets.AIDE_API_KEY }}
    dsym_paths: \${{ runner.temp }}/MyApp.xcarchive
    # Behind Cloudflare Access, send a service token's headers:
    # headers: |
    #   CF-Access-Client-Id: \${{ secrets.CF_ACCESS_CLIENT_ID }}
    #   CF-Access-Client-Secret: \${{ secrets.CF_ACCESS_CLIENT_SECRET }}
\`\`\`

### Large zips

A single request is limited to 2 GiB by default, and proxies such as Cloudflare cap requests at 100 MB. Larger zips use the resumable protocol: \`POST ${dsyms}/uploads\` with \`{ filename, sizeBytes, sha256? }\`, then \`PATCH ${dsyms}/uploads/{id}\` with 16 MiB chunks and an \`Upload-Offset\` header, then \`POST ${dsyms}/uploads/{id}/complete\`. \`HEAD\` on the upload returns the offset to resume from.

\`\`\`bash
${DSYM_UPLOAD_SCRIPT}\`\`\`
`;
}
