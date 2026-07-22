"use client";

import {
  BellRing,
  Check,
  ChevronDown,
  History,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DateTime } from "@/components/common/date-time";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";
import { cn } from "@/lib/utils";

const PUSH_TYPES = [
  "alert",
  "background",
  "complication",
  "controls",
  "fileprovider",
  "liveactivity",
  "location",
  "mdm",
  "pushtotalk",
  "voip",
  "widgets",
] as const;
type PushType = (typeof PUSH_TYPES)[number];
type Registration = {
  id: string;
  displayName: string;
  topic: string;
  environment: string;
  supportedPushTypes: string[];
  tokenMasked: string;
  status: string;
};
type Credential = {
  id: string;
  name: string;
  topic: string;
  environment: string;
  expiresAt: string | null;
};
type Channel = {
  id: string;
  channelId: string;
  bundleId: string;
  environment: string;
  storagePolicy: string;
  createdAt: string;
};
type Preset = {
  id: string;
  name: string;
  editor: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
type Delivery = {
  id: string;
  registrationId: string | null;
  topic: string;
  environment: string;
  status: string;
  apnsId: string | null;
  responseCode: number | null;
  reason: string | null;
  attempts: number;
  durationMs: number | null;
};
type Batch = {
  id: string;
  requestId: string;
  status: string;
  editor: Record<string, unknown>;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  targetMode: string;
  channelId: string | null;
  recipientCount: number;
  successCount: number;
  failureCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  deliveries: Delivery[];
};

type EditorState = {
  pushType: PushType;
  topic: string;
  priority: "1" | "5" | "10";
  apnsId: string;
  expiration: string;
  collapseId: string;
  title: string;
  subtitle: string;
  body: string;
  titleLocKey: string;
  titleLocArgs: string;
  subtitleLocKey: string;
  subtitleLocArgs: string;
  locKey: string;
  locArgs: string;
  launchImage: string;
  summaryArg: string;
  summaryArgCount: string;
  badge: string;
  soundName: string;
  criticalSound: boolean;
  soundVolume: string;
  category: string;
  threadId: string;
  contentAvailable: boolean;
  mutableContent: boolean;
  targetContentId: string;
  interruptionLevel: string;
  relevanceScore: string;
  customJson: string;
  liveTimestamp: string;
  liveEvent: "start" | "update" | "end";
  liveContentState: string;
  liveAttributesType: string;
  liveAttributes: string;
  liveStaleDate: string;
  liveDismissalDate: string;
  liveInputPushToken: boolean;
  credentialId: string;
};

const DEFAULT_EDITOR: EditorState = {
  pushType: "alert",
  topic: "",
  priority: "10",
  apnsId: "",
  expiration: "",
  collapseId: "",
  title: "",
  subtitle: "",
  body: "",
  titleLocKey: "",
  titleLocArgs: "",
  subtitleLocKey: "",
  subtitleLocArgs: "",
  locKey: "",
  locArgs: "",
  launchImage: "",
  summaryArg: "",
  summaryArgCount: "",
  badge: "",
  soundName: "default",
  criticalSound: false,
  soundVolume: "1",
  category: "",
  threadId: "",
  contentAvailable: false,
  mutableContent: false,
  targetContentId: "",
  interruptionLevel: "active",
  relevanceScore: "",
  customJson: "{}",
  liveTimestamp: String(Math.floor(Date.now() / 1000)),
  liveEvent: "update",
  liveContentState: "{}",
  liveAttributesType: "",
  liveAttributes: "{}",
  liveStaleDate: "",
  liveDismissalDate: "",
  liveInputPushToken: false,
  credentialId: "",
};

const PAGE_QUERY = `query PushNotificationsPage {
  apnsRegistrations { id displayName topic environment supportedPushTypes tokenMasked status }
  pushNotificationSettings { certificates { id name topic environment expiresAt } }
  apnsBroadcastChannels { id channelId bundleId environment storagePolicy createdAt }
  pushNotificationPresets { id name editor createdAt updatedAt }
  pushNotificationHistory(limit: 100) {
    id requestId status editor payload headers targetMode channelId recipientCount successCount failureCount error createdAt finishedAt
    deliveries { id registrationId topic environment status apnsId responseCode reason attempts durationMs }
  }
}`;

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function args(value: string): string[] | undefined {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}
function jsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${name} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export function editorStateFromSaved(
  value: Record<string, unknown>,
): EditorState {
  const headers = (value.headers ?? {}) as Record<string, unknown>;
  const aps = (value.aps ?? {}) as Record<string, unknown>;
  const alert = (aps.alert ?? {}) as Record<string, unknown>;
  const live = (value.liveActivity ?? {}) as Record<string, unknown>;
  const sound = aps.sound;
  const soundObject =
    sound && typeof sound === "object" && !Array.isArray(sound)
      ? (sound as Record<string, unknown>)
      : null;
  const locArgs = (raw: unknown) =>
    Array.isArray(raw) ? raw.map(String).join(", ") : "";
  return {
    ...DEFAULT_EDITOR,
    pushType: (value.pushType as PushType) ?? "alert",
    topic: String(headers.topic ?? ""),
    priority: String(headers.priority ?? 10) as EditorState["priority"],
    apnsId: String(headers.id ?? ""),
    expiration: String(headers.expiration ?? ""),
    collapseId: String(headers.collapseId ?? ""),
    title: String(alert.title ?? ""),
    subtitle: String(alert.subtitle ?? ""),
    body: String(alert.body ?? ""),
    titleLocKey: String(alert["title-loc-key"] ?? ""),
    titleLocArgs: locArgs(alert["title-loc-args"]),
    subtitleLocKey: String(alert["subtitle-loc-key"] ?? ""),
    subtitleLocArgs: locArgs(alert["subtitle-loc-args"]),
    locKey: String(alert["loc-key"] ?? ""),
    locArgs: locArgs(alert["loc-args"]),
    launchImage: String(alert["launch-image"] ?? ""),
    summaryArg: String(alert["summary-arg"] ?? ""),
    summaryArgCount:
      alert["summary-arg-count"] === undefined
        ? ""
        : String(alert["summary-arg-count"]),
    badge: aps.badge === undefined ? "" : String(aps.badge),
    soundName:
      typeof sound === "string" ? sound : String(soundObject?.name ?? ""),
    criticalSound: soundObject?.critical === 1,
    soundVolume:
      soundObject?.volume === undefined ? "1" : String(soundObject.volume),
    category: String(aps.category ?? ""),
    threadId: String(aps["thread-id"] ?? ""),
    contentAvailable: aps["content-available"] === 1,
    mutableContent: aps["mutable-content"] === 1,
    targetContentId: String(aps["target-content-id"] ?? ""),
    interruptionLevel: String(aps["interruption-level"] ?? "active"),
    relevanceScore:
      aps["relevance-score"] === undefined
        ? ""
        : String(aps["relevance-score"]),
    customJson: JSON.stringify(value.custom ?? {}, null, 2),
    liveTimestamp: String(live.timestamp ?? Math.floor(Date.now() / 1000)),
    liveEvent: (live.event as EditorState["liveEvent"]) ?? "update",
    liveContentState: JSON.stringify(live["content-state"] ?? {}, null, 2),
    liveAttributesType: String(live["attributes-type"] ?? ""),
    liveAttributes: JSON.stringify(live.attributes ?? {}, null, 2),
    liveStaleDate:
      live["stale-date"] === undefined ? "" : String(live["stale-date"]),
    liveDismissalDate:
      live["dismissal-date"] === undefined
        ? ""
        : String(live["dismissal-date"]),
    liveInputPushToken: live["input-push-token"] === 1,
    credentialId: String(value.credentialId ?? ""),
  };
}

export function editorStateWithPushType(
  state: EditorState,
  pushType: PushType,
): EditorState {
  return {
    ...state,
    pushType,
    ...(pushType === "background" ? { priority: "5" as const } : {}),
    ...(pushType === "mdm" ? {} : { credentialId: "" }),
  };
}

export function PushNotificationsPage() {
  const t = useTranslations("pushNotifications");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [state, setState] = useState(DEFAULT_EDITOR);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [history, setHistory] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allEligible, setAllEligible] = useState(false);
  const [broadcastChannelId, setBroadcastChannelId] = useState("");
  const [directTokenMode, setDirectTokenMode] = useState(false);
  const [directToken, setDirectToken] = useState("");
  const [directTokenEncoding, setDirectTokenEncoding] = useState("HEX");
  const [directEnvironment, setDirectEnvironment] = useState("SANDBOX");
  const [editorTab, setEditorTab] = useState("content");
  const [recordsTab, setRecordsTab] = useState("history");
  const [presetName, setPresetName] = useState("");
  const [expandedPresets, setExpandedPresets] = useState<Set<string>>(
    new Set(),
  );
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        apnsRegistrations: Registration[];
        pushNotificationSettings: { certificates: Credential[] };
        apnsBroadcastChannels: Channel[];
        pushNotificationPresets: Preset[];
        pushNotificationHistory: Batch[];
      }>(PAGE_QUERY);
      setRegistrations(data.apnsRegistrations);
      setCredentials(data.pushNotificationSettings.certificates);
      setChannels(data.apnsBroadcastChannels);
      setPresets(data.pushNotificationPresets);
      setHistory(data.pushNotificationHistory);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: `subscription { pushNotificationsChanged }` },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const update = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((current) => ({ ...current, [key]: value }));
  const editor = useMemo(() => {
    try {
      const alert = Object.fromEntries(
        Object.entries({
          title: state.title || undefined,
          subtitle: state.subtitle || undefined,
          body: state.body || undefined,
          "title-loc-key": state.titleLocKey || undefined,
          "title-loc-args": args(state.titleLocArgs),
          "subtitle-loc-key": state.subtitleLocKey || undefined,
          "subtitle-loc-args": args(state.subtitleLocArgs),
          "loc-key": state.locKey || undefined,
          "loc-args": args(state.locArgs),
          "launch-image": state.launchImage || undefined,
          "summary-arg": state.summaryArg || undefined,
          "summary-arg-count": optionalNumber(state.summaryArgCount),
        }).filter(([, value]) => value !== undefined),
      );
      const standardAps = Object.fromEntries(
        Object.entries({
          alert: Object.keys(alert).length ? alert : undefined,
          badge: optionalNumber(state.badge),
          sound: state.soundName
            ? state.criticalSound
              ? {
                  critical: 1,
                  name: state.soundName,
                  volume: Number(state.soundVolume),
                }
              : state.soundName
            : undefined,
          category: state.category || undefined,
          "thread-id": state.threadId || undefined,
          "content-available": state.contentAvailable ? 1 : undefined,
          "mutable-content": state.mutableContent ? 1 : undefined,
          "target-content-id": state.targetContentId || undefined,
          "interruption-level": state.interruptionLevel || undefined,
          "relevance-score": optionalNumber(state.relevanceScore),
        }).filter(([, value]) => value !== undefined),
      );
      const aps = ["background", "mdm"].includes(state.pushType)
        ? {}
        : standardAps;
      return {
        value: {
          pushType: state.pushType,
          headers: {
            id: state.apnsId || undefined,
            topic: state.topic,
            priority: Number(state.priority),
            expiration: state.expiration || undefined,
            collapseId: state.collapseId || undefined,
            broadcastChannelId: broadcastChannelId || undefined,
          },
          aps,
          custom: jsonObject(state.customJson, t("customJson")),
          liveActivity:
            state.pushType === "liveactivity"
              ? {
                  timestamp: Number(state.liveTimestamp),
                  event: state.liveEvent,
                  "content-state": jsonObject(
                    state.liveContentState,
                    t("contentState"),
                  ),
                  "attributes-type": state.liveAttributesType || undefined,
                  attributes:
                    state.liveEvent === "start"
                      ? jsonObject(state.liveAttributes, t("attributes"))
                      : undefined,
                  "stale-date": optionalNumber(state.liveStaleDate),
                  "dismissal-date": optionalNumber(state.liveDismissalDate),
                  "input-push-token": state.liveInputPushToken ? 1 : undefined,
                }
              : undefined,
          credentialId: state.credentialId || null,
        },
        error: null,
      };
    } catch (value) {
      return {
        value: null,
        error: value instanceof Error ? value.message : String(value),
      };
    }
  }, [broadcastChannelId, state, t]);
  const preview = useMemo(() => {
    if (!editor.value) return null;
    const value = editor.value as {
      pushType: PushType;
      aps: Record<string, unknown>;
      custom: Record<string, unknown>;
      liveActivity?: Record<string, unknown>;
    };
    const payload =
      value.pushType === "mdm"
        ? { mdm: "<PushMagic>" }
        : {
            ...value.custom,
            aps:
              value.pushType === "liveactivity"
                ? { ...value.aps, ...value.liveActivity }
                : value.aps,
          };
    const text = JSON.stringify(payload, null, 2);
    return {
      payload,
      text,
      bytes: new TextEncoder().encode(JSON.stringify(payload)).length,
    };
  }, [editor]);
  const eligible = registrations.filter(
    (registration) =>
      registration.status === "ACTIVE" &&
      registration.topic === state.topic &&
      registration.supportedPushTypes.includes(state.pushType),
  );

  const run = async (
    query: string,
    variables?: Record<string, unknown>,
    message?: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await controlPlaneRequest(query, variables);
      if (message) setNotice(message);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!editor.value) {
      setError(editor.error);
      return;
    }
    await run(
      `mutation SendPush($input: SendPushNotificationInput!) { sendPushNotification(input: $input) { id } }`,
      {
        input: {
          requestId: createClientId(),
          editor: editor.value,
          targetMode: broadcastChannelId
            ? "BROADCAST"
            : directTokenMode
              ? "DIRECT"
              : allEligible
                ? "ALL"
                : "DEVICES",
          registrationIds: [...selected],
          channelId: broadcastChannelId || null,
          directToken: directTokenMode ? directToken : null,
          directTokenEncoding: directTokenMode ? directTokenEncoding : null,
          directEnvironment: directTokenMode ? directEnvironment : null,
        },
      },
      t("queued"),
    );
  };
  const loadEditor = (value: Record<string, unknown>) => {
    setSelected(new Set());
    setAllEligible(false);
    setBroadcastChannelId("");
    setDirectTokenMode(false);
    setDirectToken("");
    setState(editorStateFromSaved(value));
  };

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BellRing /> {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
          <CardTitle>{t("editor")}</CardTitle>
          <CardDescription>{t("editorDescription")}</CardDescription>
          <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:row-span-1 max-sm:mt-3 max-sm:justify-self-stretch">
            <div className="grid gap-2 sm:flex">
              <Input
                className="w-full sm:w-48"
                onChange={(event) => setPresetName(event.target.value)}
                placeholder={t("presetName")}
                value={presetName}
              />
              <Button
                disabled={busy || !editor.value || !presetName.trim()}
                onClick={() =>
                  void run(
                    `mutation SavePreset($name: String!, $editor: JSON!) { savePushNotificationPreset(name: $name, editor: $editor) { id } }`,
                    { name: presetName, editor: editor.value },
                    t("presetSaved"),
                  )
                }
                variant="outline"
              >
                <Save /> {t("savePreset")}
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-5">
          <Tabs onValueChange={setEditorTab} value={editorTab}>
            <Select onValueChange={setEditorTab} value={editorTab}>
              <SelectTrigger className="w-full sm:hidden">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="content">{t("content")}</SelectItem>
                <SelectItem value="headers">{t("headers")}</SelectItem>
                <SelectItem value="advanced">{t("advanced")}</SelectItem>
                <SelectItem value="specialized">{t("specialized")}</SelectItem>
              </SelectContent>
            </Select>
            <TabsList className="hidden sm:inline-flex">
              <TabsTrigger value="content">{t("content")}</TabsTrigger>
              <TabsTrigger value="headers">{t("headers")}</TabsTrigger>
              <TabsTrigger value="advanced">{t("advanced")}</TabsTrigger>
              <TabsTrigger value="specialized">{t("specialized")}</TabsTrigger>
            </TabsList>
            <TabsContent className="mt-4 space-y-4" value="content">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t("pushType")}>
                  <Select
                    onValueChange={(value) => {
                      setState((current) =>
                        editorStateWithPushType(current, value as PushType),
                      );
                      if (value !== "liveactivity") {
                        setDirectTokenMode(false);
                        setBroadcastChannelId("");
                      }
                    }}
                    value={state.pushType}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PUSH_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("titleField")}>
                  <Input
                    onChange={(event) => update("title", event.target.value)}
                    value={state.title}
                  />
                </Field>
                <Field label={t("subtitle")}>
                  <Input
                    onChange={(event) => update("subtitle", event.target.value)}
                    value={state.subtitle}
                  />
                </Field>
              </div>
              <Field label={t("body")}>
                <Textarea
                  onChange={(event) => update("body", event.target.value)}
                  rows={4}
                  value={state.body}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t("badge")}>
                  <Input
                    inputMode="numeric"
                    onChange={(event) => update("badge", event.target.value)}
                    value={state.badge}
                  />
                </Field>
                <Field label={t("sound")}>
                  <Input
                    onChange={(event) =>
                      update("soundName", event.target.value)
                    }
                    value={state.soundName}
                  />
                </Field>
                <Field label={t("category")}>
                  <Input
                    onChange={(event) => update("category", event.target.value)}
                    value={state.category}
                  />
                </Field>
                <Field label={t("threadId")}>
                  <Input
                    onChange={(event) => update("threadId", event.target.value)}
                    value={state.threadId}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-5">
                <Toggle
                  checked={state.contentAvailable}
                  label={t("contentAvailable")}
                  onChange={(value) => update("contentAvailable", value)}
                />
                <Toggle
                  checked={state.mutableContent}
                  label={t("mutableContent")}
                  onChange={(value) => update("mutableContent", value)}
                />
                <Toggle
                  checked={state.criticalSound}
                  label={t("criticalSound")}
                  onChange={(value) => update("criticalSound", value)}
                />
              </div>
              {state.criticalSound && (
                <Field label={t("soundVolume")}>
                  <Input
                    className="max-w-40"
                    max="1"
                    min="0"
                    onChange={(event) =>
                      update("soundVolume", event.target.value)
                    }
                    step="0.1"
                    type="number"
                    value={state.soundVolume}
                  />
                </Field>
              )}
            </TabsContent>
            <TabsContent
              className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              value="headers"
            >
              <Field label={t("topic")}>
                <Input
                  onChange={(event) => update("topic", event.target.value)}
                  placeholder="com.example.app"
                  value={state.topic}
                />
              </Field>
              <Field label={t("priority")}>
                <Select
                  onValueChange={(value) =>
                    update("priority", value as EditorState["priority"])
                  }
                  value={state.priority}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["1", "5", "10"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("apnsId")}>
                <Input
                  onChange={(event) => update("apnsId", event.target.value)}
                  value={state.apnsId}
                />
              </Field>
              <Field label={t("expiration")}>
                <Input
                  onChange={(event) => update("expiration", event.target.value)}
                  placeholder="0 / Unix timestamp"
                  value={state.expiration}
                />
              </Field>
              <Field label={t("collapseId")}>
                <Input
                  maxLength={64}
                  onChange={(event) => update("collapseId", event.target.value)}
                  value={state.collapseId}
                />
              </Field>
              {state.pushType === "mdm" && (
                <Field label={t("certificateCredential")}>
                  <Select
                    onValueChange={(value) => update("credentialId", value)}
                    value={state.credentialId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("selectCredential")} />
                    </SelectTrigger>
                    <SelectContent>
                      {credentials.map((credential) => (
                        <SelectItem key={credential.id} value={credential.id}>
                          {credential.name} · {credential.environment}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </TabsContent>
            <TabsContent className="mt-4 space-y-4" value="advanced">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t("titleLocKey")}>
                  <Input
                    onChange={(event) =>
                      update("titleLocKey", event.target.value)
                    }
                    value={state.titleLocKey}
                  />
                </Field>
                <Field label={t("titleLocArgs")}>
                  <Input
                    onChange={(event) =>
                      update("titleLocArgs", event.target.value)
                    }
                    value={state.titleLocArgs}
                  />
                </Field>
                <Field label={t("subtitleLocKey")}>
                  <Input
                    onChange={(event) =>
                      update("subtitleLocKey", event.target.value)
                    }
                    value={state.subtitleLocKey}
                  />
                </Field>
                <Field label={t("subtitleLocArgs")}>
                  <Input
                    onChange={(event) =>
                      update("subtitleLocArgs", event.target.value)
                    }
                    value={state.subtitleLocArgs}
                  />
                </Field>
                <Field label={t("bodyLocKey")}>
                  <Input
                    onChange={(event) => update("locKey", event.target.value)}
                    value={state.locKey}
                  />
                </Field>
                <Field label={t("bodyLocArgs")}>
                  <Input
                    onChange={(event) => update("locArgs", event.target.value)}
                    value={state.locArgs}
                  />
                </Field>
                <Field label={t("launchImage")}>
                  <Input
                    onChange={(event) =>
                      update("launchImage", event.target.value)
                    }
                    value={state.launchImage}
                  />
                </Field>
                <Field label={t("summaryArg")}>
                  <Input
                    onChange={(event) =>
                      update("summaryArg", event.target.value)
                    }
                    value={state.summaryArg}
                  />
                </Field>
                <Field label={t("summaryArgCount")}>
                  <Input
                    onChange={(event) =>
                      update("summaryArgCount", event.target.value)
                    }
                    value={state.summaryArgCount}
                  />
                </Field>
                <Field label={t("targetContentId")}>
                  <Input
                    onChange={(event) =>
                      update("targetContentId", event.target.value)
                    }
                    value={state.targetContentId}
                  />
                </Field>
                <Field label={t("interruptionLevel")}>
                  <Select
                    onValueChange={(value) =>
                      update("interruptionLevel", value)
                    }
                    value={state.interruptionLevel}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["passive", "active", "time-sensitive", "critical"].map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("relevanceScore")}>
                  <Input
                    max="1"
                    min="0"
                    onChange={(event) =>
                      update("relevanceScore", event.target.value)
                    }
                    step="0.1"
                    type="number"
                    value={state.relevanceScore}
                  />
                </Field>
              </div>
              <Field label={t("customJson")}>
                <Textarea
                  className="font-mono text-xs"
                  onChange={(event) => update("customJson", event.target.value)}
                  rows={7}
                  value={state.customJson}
                />
              </Field>
            </TabsContent>
            <TabsContent className="mt-4 space-y-4" value="specialized">
              {state.pushType === "liveactivity" ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label={t("timestamp")}>
                    <Input
                      onChange={(event) =>
                        update("liveTimestamp", event.target.value)
                      }
                      value={state.liveTimestamp}
                    />
                  </Field>
                  <Field label={t("event")}>
                    <Select
                      onValueChange={(value) =>
                        update("liveEvent", value as EditorState["liveEvent"])
                      }
                      value={state.liveEvent}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["start", "update", "end"].map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("attributesType")}>
                    <Input
                      onChange={(event) =>
                        update("liveAttributesType", event.target.value)
                      }
                      value={state.liveAttributesType}
                    />
                  </Field>
                  <Field label={t("contentState")} className="sm:col-span-2">
                    <Textarea
                      className="font-mono text-xs"
                      onChange={(event) =>
                        update("liveContentState", event.target.value)
                      }
                      rows={5}
                      value={state.liveContentState}
                    />
                  </Field>
                  <Field label={t("attributes")}>
                    <Textarea
                      className="font-mono text-xs"
                      disabled={state.liveEvent !== "start"}
                      onChange={(event) =>
                        update("liveAttributes", event.target.value)
                      }
                      rows={5}
                      value={state.liveAttributes}
                    />
                  </Field>
                  <Field label={t("staleDate")}>
                    <Input
                      onChange={(event) =>
                        update("liveStaleDate", event.target.value)
                      }
                      value={state.liveStaleDate}
                    />
                  </Field>
                  <Field label={t("dismissalDate")}>
                    <Input
                      onChange={(event) =>
                        update("liveDismissalDate", event.target.value)
                      }
                      value={state.liveDismissalDate}
                    />
                  </Field>
                  <Toggle
                    checked={state.liveInputPushToken}
                    label={t("inputPushToken")}
                    onChange={(value) => update("liveInputPushToken", value)}
                  />
                </div>
              ) : state.pushType === "mdm" ? (
                <Alert>
                  <AlertDescription>{t("mdmHelp")}</AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertDescription>
                    {t("specializedHelp", { type: state.pushType })}
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>
          </Tabs>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("payloadPreview")}</Label>
                <Badge
                  variant={
                    editor.error
                      ? "destructive"
                      : preview &&
                          preview.bytes >
                            (state.pushType === "voip" ? 5120 : 4096)
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {preview?.bytes ?? 0} /{" "}
                  {state.pushType === "voip" ? 5120 : 4096} bytes
                </Badge>
              </div>
              {editor.error ? (
                <Alert variant="destructive">
                  <AlertDescription>{editor.error}</AlertDescription>
                </Alert>
              ) : (
                <pre className="max-h-80 overflow-auto rounded-xl bg-muted p-4 text-xs">
                  {preview?.text}
                </pre>
              )}
            </div>
            <div className="space-y-3">
              <Label>{t("recipients")}</Label>
              {state.pushType === "liveactivity" && (
                <Select
                  onValueChange={(value) => {
                    setDirectTokenMode(value === "TOKEN");
                    setBroadcastChannelId(
                      value === "DEVICES" || value === "TOKEN" ? "" : value,
                    );
                  }}
                  value={
                    directTokenMode ? "TOKEN" : broadcastChannelId || "DEVICES"
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEVICES">
                      {t("directDevices")}
                    </SelectItem>
                    <SelectItem value="TOKEN">{t("directToken")}</SelectItem>
                    {channels
                      .filter(
                        (channel) =>
                          channel.bundleId ===
                          state.topic.replace(/\.push-type\.liveactivity$/, ""),
                      )
                      .map((channel) => (
                        <SelectItem key={channel.id} value={channel.id}>
                          {channel.channelId} · {channel.storagePolicy}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
              {directTokenMode && (
                <div className="grid gap-3 sm:grid-cols-[1fr_9rem_10rem]">
                  <Input
                    autoComplete="off"
                    onChange={(event) => setDirectToken(event.target.value)}
                    placeholder={t("liveActivityToken")}
                    value={directToken}
                  />
                  <Select
                    onValueChange={setDirectTokenEncoding}
                    value={directTokenEncoding}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HEX">HEX</SelectItem>
                      <SelectItem value="BASE64">Base64</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    onValueChange={setDirectEnvironment}
                    value={directEnvironment}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SANDBOX">Sandbox</SelectItem>
                      <SelectItem value="PRODUCTION">Production</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {!broadcastChannelId && !directTokenMode && (
                <RecipientPicker
                  allEligible={allEligible}
                  eligible={eligible}
                  onAllEligible={setAllEligible}
                  onSelected={setSelected}
                  selected={selected}
                />
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  disabled={busy || !editor.value}
                  onClick={() =>
                    void run(
                      `mutation Draft($editor: JSON!) { savePushNotificationDraft(editor: $editor) { id } }`,
                      { editor: editor.value },
                      t("draftSaved"),
                    )
                  }
                  variant="outline"
                >
                  <Save /> {t("saveDraft")}
                </Button>
                <Button
                  disabled={
                    busy ||
                    !editor.value ||
                    (directTokenMode
                      ? !directToken.trim()
                      : !broadcastChannelId &&
                        !allEligible &&
                        selected.size === 0)
                  }
                  onClick={() => void send()}
                >
                  {busy ? <Spinner /> : <Send />} {t("send")}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <ChannelsCard channels={channels} load={load} />
      <Tabs onValueChange={setRecordsTab} value={recordsTab}>
        <Card className="gap-0 py-0">
          <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
            <CardTitle>
              {recordsTab === "history" ? t("history") : t("presets")}
            </CardTitle>
            <CardDescription>
              {recordsTab === "history"
                ? t("historyDescription")
                : t("presetsDescription")}
            </CardDescription>
            <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:row-span-1 max-sm:mt-3 max-sm:justify-self-stretch">
              <Select onValueChange={setRecordsTab} value={recordsTab}>
                <SelectTrigger className="w-full sm:hidden">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="history">{t("history")}</SelectItem>
                  <SelectItem value="presets">{t("presets")}</SelectItem>
                </SelectContent>
              </Select>
              <TabsList className="hidden sm:inline-flex">
                <TabsTrigger value="history">
                  <History /> {t("history")}
                </TabsTrigger>
                <TabsTrigger value="presets">
                  <Save /> {t("presets")}
                </TabsTrigger>
              </TabsList>
            </CardAction>
          </CardHeader>
          <TabsContent value="history">
            <ExpandableHistory
              batches={history}
              expanded={expandedHistory}
              onDelete={(id) =>
                run(
                  `mutation Delete($id: ID!) { deletePushNotificationHistory(id: $id) }`,
                  { id },
                )
              }
              onLoad={loadEditor}
              onPreset={(batch) => {
                setPresetName(
                  `${t("presetFromHistory")} ${formatDateValue(batch.createdAt, "short", { locale, showTime: false })}`,
                );
                loadEditor(batch.editor);
              }}
              onResend={(id) =>
                run(
                  `mutation Resend($id: ID!, $requestId: ID!) { resendPushNotification(id: $id, requestId: $requestId) { id } }`,
                  { id, requestId: createClientId() },
                  t("queued"),
                )
              }
              setExpanded={setExpandedHistory}
            />
            {history.length > 0 && (
              <div className="flex justify-end border-t p-3">
                <ConfirmationDialog
                  actionLabel={t("clearHistory")}
                  cancelLabel={tc("cancel")}
                  description={t("clearHistoryDescription")}
                  onConfirm={() =>
                    run(`mutation { clearPushNotificationHistory }`)
                  }
                  title={t("clearHistory")}
                  trigger={
                    <Button variant="outline">
                      <Trash2 /> {t("clearHistory")}
                    </Button>
                  }
                />
              </div>
            )}
          </TabsContent>
          <TabsContent value="presets">
            <ExpandablePresets
              expanded={expandedPresets}
              onDelete={(id) =>
                run(
                  `mutation Delete($id: ID!) { deletePushNotificationPreset(id: $id) }`,
                  { id },
                )
              }
              onLoad={loadEditor}
              onSend={(preset, sendAll, registrationIds) =>
                run(
                  `mutation SendPreset($input: SendPushNotificationInput!) { sendPushNotification(input: $input) { id } }`,
                  {
                    input: {
                      requestId: createClientId(),
                      editor: preset.editor,
                      targetMode: sendAll ? "ALL" : "DEVICES",
                      registrationIds,
                    },
                  },
                  t("queued"),
                )
              }
              presets={presets}
              registrations={registrations}
              setExpanded={setExpandedPresets}
            />
          </TabsContent>
        </Card>
      </Tabs>
      {loading && (
        <div className="fixed bottom-4 right-4 rounded-full bg-background p-3 shadow">
          <Spinner />
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(Boolean(value))}
      />
      {label}
    </label>
  );
}

function RecipientPicker({
  eligible,
  selected,
  allEligible,
  onSelected,
  onAllEligible,
}: {
  eligible: Registration[];
  selected: Set<string>;
  allEligible: boolean;
  onSelected: (value: Set<string>) => void;
  onAllEligible: (value: boolean) => void;
}) {
  const t = useTranslations("pushNotifications");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="w-full justify-between" variant="outline">
          {allEligible
            ? t("allEligibleDevices", { count: eligible.length })
            : t("selectedDevices", { count: selected.size })}
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder={t("searchDevices")} />
          <CommandList>
            <CommandEmpty>{t("noEligibleDevices")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                data-checked={allEligible}
                onSelect={() => {
                  onAllEligible(!allEligible);
                  if (!allEligible) onSelected(new Set());
                }}
                value="all-eligible"
              >
                {t("allEligibleDevices", { count: eligible.length })}
              </CommandItem>
              {eligible.map((registration) => (
                <CommandItem
                  data-checked={selected.has(registration.id)}
                  key={registration.id}
                  onSelect={() => {
                    onAllEligible(false);
                    const next = new Set(selected);
                    if (next.has(registration.id)) next.delete(registration.id);
                    else next.add(registration.id);
                    onSelected(next);
                  }}
                  value={`${registration.displayName} ${registration.tokenMasked}`}
                >
                  {registration.displayName}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {registration.environment}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ChannelsCard({
  channels,
  load,
}: {
  channels: Channel[];
  load: () => Promise<void>;
}) {
  const t = useTranslations("pushNotifications");
  const tc = useTranslations("common");
  const [bundleId, setBundleId] = useState("");
  const [environment, setEnvironment] = useState("SANDBOX");
  const [policy, setPolicy] = useState("NO_STORAGE");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation Create($input: CreateApnsBroadcastChannelInput!) { createApnsBroadcastChannel(input: $input) { id } }`,
        { input: { bundleId, environment, storagePolicy: policy } },
      );
      setBundleId("");
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("broadcastChannels")}</CardTitle>
        <CardDescription>{t("broadcastDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Input
            onChange={(event) => setBundleId(event.target.value)}
            placeholder={t("bundleId")}
            value={bundleId}
          />
          <Select onValueChange={setEnvironment} value={environment}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SANDBOX">Sandbox</SelectItem>
              <SelectItem value="PRODUCTION">Production</SelectItem>
            </SelectContent>
          </Select>
          <Select onValueChange={setPolicy} value={policy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NO_STORAGE">{t("noStorage")}</SelectItem>
              <SelectItem value="MOST_RECENT">{t("mostRecent")}</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={busy || !bundleId} onClick={() => void create()}>
            {t("createChannel")}
          </Button>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {channels.map((channel) => (
            <div
              className="flex items-center justify-between gap-2 rounded-lg border p-3"
              key={channel.id}
            >
              <div>
                <p className="font-mono text-xs">{channel.channelId}</p>
                <p className="text-xs text-muted-foreground">
                  {channel.bundleId} · {channel.environment} ·{" "}
                  {channel.storagePolicy}
                </p>
              </div>
              <ConfirmationDialog
                actionLabel={t("delete")}
                cancelLabel={tc("cancel")}
                description={t("deleteChannelDescription")}
                onConfirm={async () => {
                  await controlPlaneRequest(
                    `mutation Delete($id: ID!) { deleteApnsBroadcastChannel(id: $id) }`,
                    { id: channel.id },
                  );
                  await load();
                }}
                title={t("deleteChannel")}
                trigger={
                  <Button size="icon-sm" variant="ghost">
                    <Trash2 />
                  </Button>
                }
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ExpandableHistory({
  batches,
  expanded,
  setExpanded,
  onLoad,
  onResend,
  onPreset,
  onDelete,
}: {
  batches: Batch[];
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  onLoad: (editor: Record<string, unknown>) => void;
  onResend: (id: string) => Promise<void>;
  onPreset: (batch: Batch) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const t = useTranslations("pushNotifications");
  const tc = useTranslations("common");
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (batches.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        {t("noHistory")}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12" />
          <TableHead>{t("created")}</TableHead>
          <TableHead>{t("pushType")}</TableHead>
          <TableHead>{t("deliveryMode")}</TableHead>
          <TableHead>{t("recipients")}</TableHead>
          <TableHead>{t("result")}</TableHead>
          <TableHead>{t("status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <Fragment key={batch.id}>
            <TableRow
              className="h-16 cursor-pointer"
              onClick={() => toggle(batch.id)}
            >
              <TableCell>
                <ChevronDown
                  className={cn(
                    "transition-transform",
                    expanded.has(batch.id) && "rotate-180",
                  )}
                />
              </TableCell>
              <TableCell>
                <DateTime value={batch.createdAt} />
              </TableCell>
              <TableCell>
                <Badge variant="secondary">
                  {String(batch.editor.pushType ?? "—")}
                </Badge>
              </TableCell>
              <TableCell>{batch.targetMode}</TableCell>
              <TableCell>{batch.recipientCount}</TableCell>
              <TableCell>
                {batch.successCount} / {batch.failureCount}
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    batch.status === "FAILED" ? "destructive" : "outline"
                  }
                >
                  {batch.status}
                </Badge>
              </TableCell>
            </TableRow>
            {expanded.has(batch.id) && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="bg-muted/20 p-5">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <Label>{t("payload")}</Label>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-background p-3 text-xs">
                        {JSON.stringify(batch.payload, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <Label>{t("headers")}</Label>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-background p-3 text-xs">
                        {JSON.stringify(batch.headers, null, 2)}
                      </pre>
                    </div>
                  </div>
                  {batch.deliveries.length > 0 && (
                    <div className="mt-4 grid gap-2 md:grid-cols-2">
                      {batch.deliveries.map((delivery) => (
                        <div
                          className="rounded-lg border bg-background p-3"
                          key={delivery.id}
                        >
                          <div className="flex justify-between">
                            <span className="font-mono text-xs">
                              {delivery.topic}
                            </span>
                            <Badge
                              variant={
                                delivery.status === "SUCCEEDED"
                                  ? "default"
                                  : "destructive"
                              }
                            >
                              {delivery.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            HTTP {delivery.responseCode ?? "—"} ·{" "}
                            {delivery.reason ?? "—"} · {delivery.attempts}{" "}
                            {t("attempts")} · {delivery.durationMs ?? "—"} ms
                          </p>
                          {delivery.apnsId && (
                            <p className="font-mono text-xs">
                              {delivery.apnsId}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                      onClick={() => onLoad(batch.editor)}
                      variant="outline"
                    >
                      {t("load")}
                    </Button>
                    <Button onClick={() => onPreset(batch)} variant="outline">
                      <Save /> {t("saveAsPreset")}
                    </Button>
                    {batch.targetMode !== "DRAFT" && (
                      <Button onClick={() => void onResend(batch.id)}>
                        <Send /> {t("resend")}
                      </Button>
                    )}
                    <ConfirmationDialog
                      actionLabel={t("delete")}
                      cancelLabel={tc("cancel")}
                      description={t("deleteHistoryDescription")}
                      onConfirm={() => onDelete(batch.id)}
                      title={t("deleteHistory")}
                      trigger={
                        <Button
                          disabled={["QUEUED", "SENDING"].includes(
                            batch.status,
                          )}
                          variant="ghost"
                        >
                          <Trash2 /> {t("delete")}
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function ExpandablePresets({
  presets,
  registrations,
  expanded,
  setExpanded,
  onLoad,
  onSend,
  onDelete,
}: {
  presets: Preset[];
  registrations: Registration[];
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  onLoad: (editor: Record<string, unknown>) => void;
  onSend: (
    preset: Preset,
    allEligible: boolean,
    registrationIds: string[],
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const t = useTranslations("pushNotifications");
  const tc = useTranslations("common");
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (presets.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        {t("noPresets")}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12" />
          <TableHead>{t("name")}</TableHead>
          <TableHead>{t("pushType")}</TableHead>
          <TableHead>{t("topic")}</TableHead>
          <TableHead>{t("updated")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {presets.map((preset) => (
          <Fragment key={preset.id}>
            <TableRow
              className="h-16 cursor-pointer"
              onClick={() => toggle(preset.id)}
            >
              <TableCell>
                <ChevronDown
                  className={cn(
                    "transition-transform",
                    expanded.has(preset.id) && "rotate-180",
                  )}
                />
              </TableCell>
              <TableCell className="font-medium">{preset.name}</TableCell>
              <TableCell>{String(preset.editor.pushType ?? "—")}</TableCell>
              <TableCell className="font-mono text-xs">
                {String(
                  (preset.editor.headers as Record<string, unknown> | undefined)
                    ?.topic ?? "—",
                )}
              </TableCell>
              <TableCell>
                <DateTime value={preset.updatedAt} />
              </TableCell>
            </TableRow>
            {expanded.has(preset.id) && (
              <TableRow>
                <TableCell className="bg-muted/20 p-5" colSpan={5}>
                  <pre className="max-h-72 overflow-auto rounded-xl bg-background p-3 text-xs">
                    {JSON.stringify(preset.editor, null, 2)}
                  </pre>
                  <div className="mt-4 flex flex-wrap items-end justify-end gap-2">
                    <PresetSendControls
                      onSend={(allEligible, registrationIds) =>
                        onSend(preset, allEligible, registrationIds)
                      }
                      preset={preset}
                      registrations={registrations}
                    />
                    <Button onClick={() => onLoad(preset.editor)}>
                      <Check /> {t("loadEdit")}
                    </Button>
                    <ConfirmationDialog
                      actionLabel={t("delete")}
                      cancelLabel={tc("cancel")}
                      description={t("deletePresetDescription")}
                      onConfirm={() => onDelete(preset.id)}
                      title={t("deletePreset")}
                      trigger={
                        <Button variant="ghost">
                          <Trash2 /> {t("delete")}
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function PresetSendControls({
  preset,
  registrations,
  onSend,
}: {
  preset: Preset;
  registrations: Registration[];
  onSend: (allEligible: boolean, registrationIds: string[]) => Promise<void>;
}) {
  const t = useTranslations("pushNotifications");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allEligible, setAllEligible] = useState(false);
  const [sending, setSending] = useState(false);
  const headers = (preset.editor.headers ?? {}) as Record<string, unknown>;
  const topic = String(headers.topic ?? "");
  const pushType = String(preset.editor.pushType ?? "");
  const eligible = registrations.filter(
    (registration) =>
      registration.status === "ACTIVE" &&
      registration.topic === topic &&
      registration.supportedPushTypes.includes(pushType),
  );
  return (
    <div className="grid min-w-72 flex-1 gap-2 sm:max-w-xl sm:grid-cols-[1fr_auto]">
      <RecipientPicker
        allEligible={allEligible}
        eligible={eligible}
        onAllEligible={setAllEligible}
        onSelected={setSelected}
        selected={selected}
      />
      <Button
        disabled={sending || (!allEligible && selected.size === 0)}
        onClick={() =>
          void (async () => {
            setSending(true);
            try {
              await onSend(allEligible, [...selected]);
              setAllEligible(false);
              setSelected(new Set());
            } finally {
              setSending(false);
            }
          })()
        }
      >
        {sending ? <Spinner /> : <Send />} {t("send")}
      </Button>
    </div>
  );
}
