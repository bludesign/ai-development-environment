import {
  Archive,
  Hammer,
  Play,
  Rocket,
  Smartphone,
  TestTube,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  hammer: Hammer,
  play: Play,
  rocket: Rocket,
  smartphone: Smartphone,
  "test-tube": TestTube,
};

export function ConfigurationIcon({ iconKey }: { iconKey: string | null }) {
  if (!iconKey) return null;
  const Icon = ICONS[iconKey];
  return Icon ? <Icon aria-hidden className="size-4" /> : null;
}
