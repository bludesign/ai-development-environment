"use client";

import { cloneElement, type ReactElement } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type WorkflowTriggerChoice = {
  key: string;
  label: string;
  description: string;
};

/**
 * Wraps a run button so that a workflow whose manual trigger offers choices
 * asks which one first, in a menu that opens against the button. A workflow
 * with no choices keeps a plain button that starts the run on click, so every
 * call site can render one control either way.
 */
export function WorkflowChoiceMenu({
  button,
  choices,
  onRun,
}: {
  button: ReactElement<{ onClick?: () => void }>;
  choices: readonly WorkflowTriggerChoice[];
  onRun: (choice: string | null) => void;
}) {
  if (!choices.length)
    return cloneElement(button, { onClick: () => onRun(null) });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-64">
        {choices.map((choice) => (
          <DropdownMenuItem key={choice.key} onSelect={() => onRun(choice.key)}>
            <div className="min-w-0">
              <p className="truncate">{choice.label}</p>
              {choice.description && (
                <p className="truncate text-xs text-muted-foreground">
                  {choice.description}
                </p>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
