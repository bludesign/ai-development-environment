import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
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
