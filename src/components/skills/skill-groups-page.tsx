"use client";

import { ArrowLeft, FolderTree, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { SkillGroupSummary } from "./types";

export function SkillGroupsPage() {
  const t = useTranslations("skills");
  const router = useRouter();
  const [groups, setGroups] = useState<SkillGroupSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        skillsOverview: { groups: SkillGroupSummary[] };
      }>(`query SkillGroups { skillsOverview { groups {
        id name createdAt updatedAt
        skills { id name }
        repositories { id name displayOrigin }
      } } }`);
      setGroups(data.skillsOverview.groups);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveSkillGroup: SkillGroupSummary;
      }>(
        `mutation CreateSkillGroup($input: SaveSkillGroupInput!) {
          saveSkillGroup(input: $input) { id name }
        }`,
        { input: { name, skillIds: [], repositoryIds: [] } },
      );
      setOpen(false);
      router.push(`/skills/groups/${data.saveSkillGroup.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost">
            <Link aria-label={t("backToSkills")} href="/skills">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{t("skillGroups")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("groupsDescription")}
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> {t("addGroup")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="flex gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loadingGroups")}
        </div>
      ) : (
        <Card className="gap-0 py-0">
          <CardHeader>
            <CardTitle>{t("skillGroups")}</CardTitle>
            <CardDescription>{t("groupsTableDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("skillsCount")}</TableHead>
                  <TableHead>{t("repositoriesCount")}</TableHead>
                  <TableHead>{t("updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow
                    className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    key={group.id}
                    onClick={() => router.push(`/skills/groups/${group.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        router.push(`/skills/groups/${group.id}`);
                      }
                    }}
                    role="link"
                    tabIndex={0}
                  >
                    <TableCell>
                      <span className="inline-flex items-center gap-2 font-medium text-primary">
                        <FolderTree /> {group.name}
                      </span>
                    </TableCell>
                    <TableCell>{group.skills?.length ?? 0}</TableCell>
                    <TableCell>{group.repositories?.length ?? 0}</TableCell>
                    <TableCell>
                      <DateTime value={group.updatedAt} />
                    </TableCell>
                  </TableRow>
                ))}
                {!groups.length && (
                  <TableRow>
                    <TableCell
                      className="py-10 text-center text-muted-foreground"
                      colSpan={4}
                    >
                      {t("noGroups")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newGroup")}</DialogTitle>
            <DialogDescription>{t("newGroupDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-skill-group">{t("name")}</Label>
            <Input
              id="new-skill-group"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={busy || !name.trim()}
              onClick={() => void create()}
            >
              {busy && <Spinner />} {t("createGroup")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
