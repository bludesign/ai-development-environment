"use client";

import { Braces, Minus, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SSE_STORAGE_QUERY } from "./graphql";
import { SsePageShell } from "./sse-shell";
import type { SseStorageEntry } from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

export function SseStoragePage() {
  const [entries, setEntries] = useState<SseStorageEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const [key, setKey] = useState("");
  const [value, setValue] = useState("{}\n");
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        sseStorageEntries: SseStorageEntry[];
      }>(SSE_STORAGE_QUERY);
      setEntries(data.sseStorageEntries);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("storage", () => void load());
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => {
      setKey(selected.key);
      setValue(`${JSON.stringify(selected.value, null, 2)}\n`);
      setExpectedVersion(selected.version);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected]);

  function createNew() {
    setSelectedKey(null);
    setKey("");
    setValue("{}\n");
    setExpectedVersion(null);
  }

  async function save() {
    setBusy(true);
    try {
      const parsed = JSON.parse(value) as unknown;
      await controlPlaneRequest(
        `mutation SaveSseStorage($key: String!, $expectedVersion: Int, $value: JSON!) {
          compareAndSetSseStorageValue(key: $key, expectedVersion: $expectedVersion, value: $value) { key version }
        }`,
        { key, expectedVersion, value: parsed },
      );
      setSelectedKey(key);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function increment(delta: number) {
    if (!key) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation IncrementSseStorage($key: String!, $delta: Float!) { incrementSseStorageValue(key: $key, delta: $delta) { key version value } }`,
        { key, delta },
      );
      setSelectedKey(key);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!key) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation DeleteSseStorage($key: String!) { deleteSseStorageValue(key: $key) }`,
        { key },
      );
      createNew();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SsePageShell
      action={
        <Button onClick={createNew}>
          <Plus /> New value
        </Button>
      }
      description="Inspect and atomically manage the versioned JSON store shared by request, response-event, and mock scripts across every SSE endpoint."
      title="SSE script storage"
    >
      <Alert>
        <Braces />
        <AlertDescription>
          All values are visible to every SSE script. Compare-and-set version
          checks prevent this editor from overwriting concurrent script updates.
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Stored values</CardTitle>
            <CardDescription>
              {entries.length} shared{" "}
              {entries.length === 1 ? "entry" : "entries"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <p className="flex items-center gap-2 p-4 text-muted-foreground">
                <Spinner /> Loading storage…
              </p>
            ) : entries.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">
                No script storage values yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Updated by</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow
                      className="cursor-pointer"
                      data-state={
                        selectedKey === entry.key ? "selected" : undefined
                      }
                      key={entry.key}
                      onClick={() => setSelectedKey(entry.key)}
                    >
                      <TableCell className="font-mono font-medium">
                        {entry.key}
                      </TableCell>
                      <TableCell>
                        <code className="line-clamp-2 max-w-xl text-xs">
                          {JSON.stringify(entry.value)}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">v{entry.version}</Badge>
                      </TableCell>
                      <TableCell>{entry.updatedBy ?? "script"}</TableCell>
                      <TableCell>
                        {new Date(entry.updatedAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card className="self-start xl:sticky xl:top-4">
          <CardHeader>
            <CardTitle>{selected ? "Edit value" : "Create value"}</CardTitle>
            <CardDescription>
              {selected
                ? `Saving requires version ${selected.version}.`
                : "A new key begins at version 1."}
            </CardDescription>
            {selected ? (
              <CardAction>
                <Badge variant="secondary">v{selected.version}</Badge>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="storage-key">Key</Label>
              <Input
                disabled={Boolean(selected)}
                id="storage-key"
                onChange={(event) => setKey(event.target.value)}
                value={key}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="storage-value">JSON value</Label>
              <Textarea
                className="min-h-72 font-mono text-xs"
                id="storage-value"
                onChange={(event) => setValue(event.target.value)}
                spellCheck={false}
                value={value}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !key.trim()}
                onClick={() => void save()}
              >
                <Save /> Save atomically
              </Button>
              <Button
                disabled={busy || !selected}
                onClick={() => void increment(1)}
                variant="outline"
              >
                <Plus /> Increment
              </Button>
              <Button
                disabled={busy || !selected}
                onClick={() => void increment(-1)}
                variant="outline"
              >
                <Minus /> Decrement
              </Button>
              {selected ? (
                <Button
                  disabled={busy}
                  onClick={() => void remove()}
                  variant="destructive"
                >
                  <Trash2 /> Delete
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </SsePageShell>
  );
}
