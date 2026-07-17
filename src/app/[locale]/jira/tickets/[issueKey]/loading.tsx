import { Spinner } from "@/components/ui/spinner";

export default function JiraTicketDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
    </div>
  );
}
