"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { SearchIcon, CheckIcon } from "lucide-react";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * iOS Safari keeps `position: fixed` pinned to the layout viewport, so a
 * top-anchored panel drifts out of sight whenever the visual viewport moves
 * against it — the URL bar collapsing, or the keyboard opening and Safari
 * scrolling the focused field into view. Following the visual viewport keeps
 * the panel where the user can actually see it.
 */
function useVisualViewport(open: boolean) {
  const [viewport, setViewport] = React.useState<{
    top: number;
    height: number;
  } | null>(null);

  React.useEffect(() => {
    const visual = window.visualViewport;
    if (!open || !visual) return;
    const sync = () =>
      setViewport({ top: visual.offsetTop, height: visual.height });
    sync();
    visual.addEventListener("resize", sync);
    visual.addEventListener("scroll", sync);
    return () => {
      visual.removeEventListener("resize", sync);
      visual.removeEventListener("scroll", sync);
    };
  }, [open]);

  return viewport;
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  const viewport = useVisualViewport(props.open ?? false);

  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          // Below sm the panel sits just under the top of the *visible* area and
          // is capped to what is left of it, so the keyboard cannot bury it. The
          // vars are unset until the viewport is measured, and every placement
          // utility is overridden from sm, where the panel is simply centred.
          // The single `minmax(0,1fr)` row lets the panel's content shrink to the
          // capped height instead of overflowing behind the keyboard.
          "top-[calc(var(--command-viewport-top,0px)_+_max(env(safe-area-inset-top,0px),0.75rem))] max-h-[var(--command-viewport-height,85dvh)] grid-rows-[minmax(0,1fr)] translate-y-0 overflow-hidden rounded-xl! p-0 sm:top-1/2 sm:max-h-[85dvh] sm:-translate-y-1/2",
          className,
        )}
        showCloseButton={showCloseButton}
        style={
          viewport
            ? ({
                "--command-viewport-top": `${viewport.top}px`,
                // Leave a matching gutter below the panel.
                "--command-viewport-height": `${viewport.height - 24}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            // text-base below md keeps the font at 16px so iOS Safari does not
            // zoom the page when the field takes focus, matching Input.
            "w-full text-base outline-hidden disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
