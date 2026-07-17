import { Spinner } from "@/components/ui/spinner";

export default function WorktreeDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
    </div>
  );
}
