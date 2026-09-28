"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type {
  TransferAgent,
  TransferDestination,
  TransferDestinationInput,
  TransferItem,
} from "./types";

function destinationDefaults(
  repository: TransferItem,
  agent: TransferAgent,
  coverage: TransferDestination[],
) {
  const known = coverage.find(
    (entry) =>
      entry.repositoryKey === repository.key && entry.agentId === agent.id,
  );
  const incoming =
    repository.incoming && typeof repository.incoming === "object"
      ? (repository.incoming as Record<string, unknown>)
      : {};
  const origin =
    typeof incoming.canonicalOrigin === "string"
      ? incoming.canonicalOrigin
      : repository.label;
  return {
    repositoryKey: repository.key,
    agentId: agent.id,
    relativePath: known?.relativePath ?? origin.split("/").at(-1) ?? "",
    remoteUrl:
      known?.remoteUrl ??
      (typeof incoming.remoteUrl === "string" ? incoming.remoteUrl : ""),
  };
}

export function TransferDestinationEditor({
  agents,
  repositories,
  destinations,
  coverage,
  onChange,
  disabled = false,
}: {
  agents: TransferAgent[];
  repositories: TransferItem[];
  destinations: TransferDestinationInput[];
  coverage: TransferDestination[];
  onChange: (destinations: TransferDestinationInput[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("repositoryTransfer");
  const update = (
    repositoryKey: string,
    agentId: string,
    values: Partial<TransferDestinationInput>,
  ) =>
    onChange(
      destinations.map((entry) =>
        entry.repositoryKey === repositoryKey && entry.agentId === agentId
          ? { ...entry, ...values }
          : entry,
      ),
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("destinationsDescription")}
      </p>
      {!agents.length && (
        <p className="text-sm text-muted-foreground">{t("noAgents")}</p>
      )}
      {agents.map((agent) => {
        const availableRepositories = repositories.filter((repository) => {
          const state = coverage
            .find(
              (entry) =>
                entry.agentId === agent.id &&
                entry.repositoryKey === repository.key,
            )
            ?.status.toUpperCase();
          return !["PRESENT", "EXISTING", "REGISTERED", "AVAILABLE"].includes(
            state ?? "",
          );
        });
        const selectedCount = availableRepositories.filter((repository) =>
          destinations.some(
            (entry) =>
              entry.agentId === agent.id &&
              entry.repositoryKey === repository.key,
          ),
        ).length;
        return (
          <FieldSet className="gap-3 rounded-lg border p-3" key={agent.id}>
            <FieldLegend className="mb-0 px-1">{agent.name}</FieldLegend>
            <div className="flex items-start gap-2">
              <Checkbox
                id={`transfer-agent-${agent.id}`}
                checked={
                  selectedCount === 0
                    ? false
                    : selectedCount === availableRepositories.length
                      ? true
                      : "indeterminate"
                }
                disabled={
                  disabled ||
                  !agent.eligible ||
                  availableRepositories.length === 0
                }
                onCheckedChange={(value) => {
                  const other = destinations.filter(
                    (entry) => entry.agentId !== agent.id,
                  );
                  onChange(
                    value === true
                      ? [
                          ...other,
                          ...availableRepositories.map(
                            (repository) =>
                              destinations.find(
                                (entry) =>
                                  entry.agentId === agent.id &&
                                  entry.repositoryKey === repository.key,
                              ) ??
                              destinationDefaults(repository, agent, coverage),
                          ),
                        ]
                      : other,
                  );
                }}
              />
              <div className="min-w-0">
                <Label htmlFor={`transfer-agent-${agent.id}`}>
                  {t("selectMissing")}
                </Label>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {agent.baseRepoDirectory ?? t("baseDirectoryMissing")}
                </p>
                {!agent.eligible && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {agent.reason ?? t("agentUnavailable")}
                  </p>
                )}
              </div>
            </div>
            {repositories.map((repository) => {
              const value = destinations.find(
                (entry) =>
                  entry.agentId === agent.id &&
                  entry.repositoryKey === repository.key,
              );
              const review = coverage.find(
                (entry) =>
                  entry.agentId === agent.id &&
                  entry.repositoryKey === repository.key,
              );
              const present = [
                "PRESENT",
                "EXISTING",
                "REGISTERED",
                "AVAILABLE",
              ].includes(review?.status.toUpperCase() ?? "");
              const id = `destination-${agent.id}-${repository.key}`;
              return (
                <div
                  className="ml-2 space-y-3 border-l pl-3"
                  key={repository.key}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={Boolean(value)}
                      disabled={disabled || !agent.eligible || present}
                      onCheckedChange={(checked) =>
                        onChange(
                          checked === true
                            ? [
                                ...destinations,
                                destinationDefaults(
                                  repository,
                                  agent,
                                  coverage,
                                ),
                              ]
                            : destinations.filter(
                                (entry) =>
                                  entry.agentId !== agent.id ||
                                  entry.repositoryKey !== repository.key,
                              ),
                        )
                      }
                    />
                    <Label htmlFor={id}>{repository.label}</Label>
                    <Badge variant="secondary">
                      {present ? t("present") : t("missing")}
                    </Badge>
                  </div>
                  {value && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field className="gap-1">
                        <FieldLabel htmlFor={`${id}-path`}>
                          {t("relativePath")}
                        </FieldLabel>
                        <Input
                          id={`${id}-path`}
                          value={value.relativePath ?? ""}
                          disabled={disabled}
                          onChange={(event) =>
                            update(repository.key, agent.id, {
                              relativePath: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field className="gap-1">
                        <FieldLabel htmlFor={`${id}-remote`}>
                          {t("remoteUrl")}
                        </FieldLabel>
                        <Input
                          id={`${id}-remote`}
                          value={value.remoteUrl ?? ""}
                          disabled={disabled}
                          onChange={(event) =>
                            update(repository.key, agent.id, {
                              remoteUrl: event.target.value,
                            })
                          }
                        />
                      </Field>
                    </div>
                  )}
                  {(review?.destinationPath || value) && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {value
                        ? `${agent.baseRepoDirectory ?? ""}/${value.relativePath ?? ""}`
                        : review?.destinationPath}
                    </p>
                  )}
                  {review?.error && value && (
                    <FieldError>{review.error}</FieldError>
                  )}
                </div>
              );
            })}
          </FieldSet>
        );
      })}
    </div>
  );
}
