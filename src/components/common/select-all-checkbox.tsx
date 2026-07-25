"use client";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * The checkbox a table header or day separator uses to take its whole span in
 * or out of a selection. It owns the tri-state arithmetic — all, none, or the
 * partial state a per-row checkbox never has to represent — so every list that
 * grows a selection column agrees on what a half-selected group looks like.
 */
export function SelectAllCheckbox({
  ids,
  label,
  onChange,
  selected,
}: {
  ids: string[];
  label: string;
  onChange: (next: Set<string>) => void;
  selected: Set<string>;
}) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  return (
    <Checkbox
      aria-label={label}
      checked={all ? true : some ? "indeterminate" : false}
      disabled={!ids.length}
      onCheckedChange={(checked) => {
        const next = new Set(selected);
        /* An indeterminate box reports its next state as `true`, so a partly
           selected group fills in rather than clearing — the same way a click
           on a partly checked "select all" behaves everywhere else. */
        for (const id of ids) {
          if (checked === true) next.add(id);
          else next.delete(id);
        }
        onChange(next);
      }}
    />
  );
}
