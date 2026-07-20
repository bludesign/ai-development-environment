import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";
import {
  Apple,
  AppWindow,
  Archive,
  Beaker,
  Box,
  Bug,
  Code2,
  Gauge,
  Hammer,
  Layers3,
  Package,
  Play,
  Rocket,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  TestTube,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  apple: Apple,
  "app-window": AppWindow,
  archive: Archive,
  beaker: Beaker,
  box: Box,
  bug: Bug,
  code: Code2,
  gauge: Gauge,
  hammer: Hammer,
  layers: Layers3,
  package: Package,
  play: Play,
  rocket: Rocket,
  shield: ShieldCheck,
  smartphone: Smartphone,
  sparkles: Sparkles,
  terminal: Terminal,
  "test-tube": TestTube,
  wrench: Wrench,
};

export { BUILD_CONFIGURATION_ICON_KEYS };

export function ConfigurationIcon({ iconKey }: { iconKey: string | null }) {
  if (!iconKey) return null;
  const Icon = ICONS[iconKey];
  return Icon ? <Icon aria-hidden className="size-4" /> : null;
}
