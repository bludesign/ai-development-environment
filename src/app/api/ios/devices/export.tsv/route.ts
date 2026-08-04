import { getServerServices } from "@/services/server-services";
import { requireUserRequest } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  const tsv = await getServerServices().iosDevicesService.exportTsv();
  return new Response(`${tsv}\n`, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": 'attachment; filename="ios-devices.txt"',
      "content-type": "text/tab-separated-values; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
