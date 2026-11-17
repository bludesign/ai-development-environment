import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/browser-utils";
import type { TailscaleAddress } from "@/lib/tailscale-addresses";

export function TailscaleEndpointCopy({
  address,
  kindLabel = address.kind,
  menuItem = false,
}: {
  address: TailscaleAddress;
  kindLabel?: string;
  menuItem?: boolean;
}) {
  const t = useTranslations("tailscale");
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const label = t("copyEndpoint", { endpoint: address.endpoint });
  const protocol = address.protocol === "TLS_TERMINATED_TCP" ? "TLS" : "TCP";
  const copy = async () => {
    setResult(null);
    try {
      await copyText(address.endpoint);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  };
  const content = (
    <>
      {result === "copied" ? <Check /> : <Copy />}
      <span className="min-w-0 break-all">
        {kindLabel} · {address.endpoint} ({protocol})
        {result === "copied" && (
          <span className="sr-only" role="status">
            {t("endpointCopied")}
          </span>
        )}
        {result === "failed" && (
          <span className="block text-xs text-destructive" role="alert">
            {t("endpointCopyFailed")}
          </span>
        )}
      </span>
    </>
  );

  return menuItem ? (
    <DropdownMenuItem
      aria-label={label}
      title={label}
      onSelect={(event) => {
        event.preventDefault();
        void copy();
      }}
    >
      {content}
    </DropdownMenuItem>
  ) : (
    <Button
      aria-label={label}
      className="h-auto max-w-full justify-start px-0 text-left font-normal whitespace-normal"
      title={label}
      type="button"
      variant="link"
      onClick={() => void copy()}
    >
      {content}
    </Button>
  );
}
