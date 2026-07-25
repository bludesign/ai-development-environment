export const worktreeHighlightSurfaceClasses: Record<string, string> = {
  gray: "border-slate-500/30 bg-slate-500/10 hover:border-slate-500/50 hover:bg-slate-500/20",
  stone:
    "border-stone-500/30 bg-stone-500/10 hover:border-stone-500/50 hover:bg-stone-500/20",
  red: "border-red-500/30 bg-red-500/10 hover:border-red-500/50 hover:bg-red-500/20",
  rose: "border-rose-500/30 bg-rose-500/10 hover:border-rose-500/50 hover:bg-rose-500/20",
  orange:
    "border-orange-500/30 bg-orange-500/10 hover:border-orange-500/50 hover:bg-orange-500/20",
  amber:
    "border-amber-500/30 bg-amber-500/10 hover:border-amber-500/50 hover:bg-amber-500/20",
  yellow:
    "border-yellow-500/30 bg-yellow-500/10 hover:border-yellow-500/50 hover:bg-yellow-500/20",
  lime: "border-lime-500/30 bg-lime-500/10 hover:border-lime-500/50 hover:bg-lime-500/20",
  green:
    "border-green-500/30 bg-green-500/10 hover:border-green-500/50 hover:bg-green-500/20",
  emerald:
    "border-emerald-500/30 bg-emerald-500/10 hover:border-emerald-500/50 hover:bg-emerald-500/20",
  teal: "border-teal-500/30 bg-teal-500/10 hover:border-teal-500/50 hover:bg-teal-500/20",
  cyan: "border-cyan-500/30 bg-cyan-500/10 hover:border-cyan-500/50 hover:bg-cyan-500/20",
  sky: "border-sky-500/30 bg-sky-500/10 hover:border-sky-500/50 hover:bg-sky-500/20",
  blue: "border-blue-500/30 bg-blue-500/10 hover:border-blue-500/50 hover:bg-blue-500/20",
  indigo:
    "border-indigo-500/30 bg-indigo-500/10 hover:border-indigo-500/50 hover:bg-indigo-500/20",
  violet:
    "border-violet-500/30 bg-violet-500/10 hover:border-violet-500/50 hover:bg-violet-500/20",
  purple:
    "border-purple-500/30 bg-purple-500/10 hover:border-purple-500/50 hover:bg-purple-500/20",
  fuchsia:
    "border-fuchsia-500/30 bg-fuchsia-500/10 hover:border-fuchsia-500/50 hover:bg-fuchsia-500/20",
  pink: "border-pink-500/30 bg-pink-500/10 hover:border-pink-500/50 hover:bg-pink-500/20",
};

export const worktreeHighlightBackgroundClasses: Record<string, string> = {
  gray: "bg-slate-500/10 hover:bg-slate-500/20",
  stone: "bg-stone-500/10 hover:bg-stone-500/20",
  red: "bg-red-500/10 hover:bg-red-500/20",
  rose: "bg-rose-500/10 hover:bg-rose-500/20",
  orange: "bg-orange-500/10 hover:bg-orange-500/20",
  amber: "bg-amber-500/10 hover:bg-amber-500/20",
  yellow: "bg-yellow-500/10 hover:bg-yellow-500/20",
  lime: "bg-lime-500/10 hover:bg-lime-500/20",
  green: "bg-green-500/10 hover:bg-green-500/20",
  emerald: "bg-emerald-500/10 hover:bg-emerald-500/20",
  teal: "bg-teal-500/10 hover:bg-teal-500/20",
  cyan: "bg-cyan-500/10 hover:bg-cyan-500/20",
  sky: "bg-sky-500/10 hover:bg-sky-500/20",
  blue: "bg-blue-500/10 hover:bg-blue-500/20",
  indigo: "bg-indigo-500/10 hover:bg-indigo-500/20",
  violet: "bg-violet-500/10 hover:bg-violet-500/20",
  purple: "bg-purple-500/10 hover:bg-purple-500/20",
  fuchsia: "bg-fuchsia-500/10 hover:bg-fuchsia-500/20",
  pink: "bg-pink-500/10 hover:bg-pink-500/20",
};

/**
 * The accent stripe for a cell in a `border-collapse` table, painted as an
 * inset shadow rather than the left border `worktreeHighlightAccentClasses`
 * uses. Collapsed borders miter at the corners, so a 4px left border wins the
 * bottom-left corner against the 1px row divider and notches a matching gap
 * out of it; a shadow paints inside the cell and leaves the divider whole.
 */
export const worktreeHighlightInsetAccentClasses: Record<string, string> = {
  gray: "shadow-[inset_4px_0_0_var(--color-slate-500)]",
  stone: "shadow-[inset_4px_0_0_var(--color-stone-500)]",
  red: "shadow-[inset_4px_0_0_var(--color-red-500)]",
  rose: "shadow-[inset_4px_0_0_var(--color-rose-500)]",
  orange: "shadow-[inset_4px_0_0_var(--color-orange-500)]",
  amber: "shadow-[inset_4px_0_0_var(--color-amber-500)]",
  yellow: "shadow-[inset_4px_0_0_var(--color-yellow-500)]",
  lime: "shadow-[inset_4px_0_0_var(--color-lime-500)]",
  green: "shadow-[inset_4px_0_0_var(--color-green-500)]",
  emerald: "shadow-[inset_4px_0_0_var(--color-emerald-500)]",
  teal: "shadow-[inset_4px_0_0_var(--color-teal-500)]",
  cyan: "shadow-[inset_4px_0_0_var(--color-cyan-500)]",
  sky: "shadow-[inset_4px_0_0_var(--color-sky-500)]",
  blue: "shadow-[inset_4px_0_0_var(--color-blue-500)]",
  indigo: "shadow-[inset_4px_0_0_var(--color-indigo-500)]",
  violet: "shadow-[inset_4px_0_0_var(--color-violet-500)]",
  purple: "shadow-[inset_4px_0_0_var(--color-purple-500)]",
  fuchsia: "shadow-[inset_4px_0_0_var(--color-fuchsia-500)]",
  pink: "shadow-[inset_4px_0_0_var(--color-pink-500)]",
};

/**
 * The transient wash used while a highlighted row animates in — the same hue as
 * `worktreeHighlightBackgroundClasses` at a heavier weight so the arrival reads
 * as that worktree's color instead of the generic primary flash.
 */
export const worktreeHighlightArrivalClasses: Record<string, string> = {
  gray: "bg-slate-500/30 ring-slate-500/50 hover:bg-slate-500/30",
  stone: "bg-stone-500/30 ring-stone-500/50 hover:bg-stone-500/30",
  red: "bg-red-500/30 ring-red-500/50 hover:bg-red-500/30",
  rose: "bg-rose-500/30 ring-rose-500/50 hover:bg-rose-500/30",
  orange: "bg-orange-500/30 ring-orange-500/50 hover:bg-orange-500/30",
  amber: "bg-amber-500/30 ring-amber-500/50 hover:bg-amber-500/30",
  yellow: "bg-yellow-500/30 ring-yellow-500/50 hover:bg-yellow-500/30",
  lime: "bg-lime-500/30 ring-lime-500/50 hover:bg-lime-500/30",
  green: "bg-green-500/30 ring-green-500/50 hover:bg-green-500/30",
  emerald: "bg-emerald-500/30 ring-emerald-500/50 hover:bg-emerald-500/30",
  teal: "bg-teal-500/30 ring-teal-500/50 hover:bg-teal-500/30",
  cyan: "bg-cyan-500/30 ring-cyan-500/50 hover:bg-cyan-500/30",
  sky: "bg-sky-500/30 ring-sky-500/50 hover:bg-sky-500/30",
  blue: "bg-blue-500/30 ring-blue-500/50 hover:bg-blue-500/30",
  indigo: "bg-indigo-500/30 ring-indigo-500/50 hover:bg-indigo-500/30",
  violet: "bg-violet-500/30 ring-violet-500/50 hover:bg-violet-500/30",
  purple: "bg-purple-500/30 ring-purple-500/50 hover:bg-purple-500/30",
  fuchsia: "bg-fuchsia-500/30 ring-fuchsia-500/50 hover:bg-fuchsia-500/30",
  pink: "bg-pink-500/30 ring-pink-500/50 hover:bg-pink-500/30",
};

export const worktreeHighlightAccentClasses: Record<string, string> = {
  gray: "border-l-slate-500",
  stone: "border-l-stone-500",
  red: "border-l-red-500",
  rose: "border-l-rose-500",
  orange: "border-l-orange-500",
  amber: "border-l-amber-500",
  yellow: "border-l-yellow-500",
  lime: "border-l-lime-500",
  green: "border-l-green-500",
  emerald: "border-l-emerald-500",
  teal: "border-l-teal-500",
  cyan: "border-l-cyan-500",
  sky: "border-l-sky-500",
  blue: "border-l-blue-500",
  indigo: "border-l-indigo-500",
  violet: "border-l-violet-500",
  purple: "border-l-purple-500",
  fuchsia: "border-l-fuchsia-500",
  pink: "border-l-pink-500",
};
