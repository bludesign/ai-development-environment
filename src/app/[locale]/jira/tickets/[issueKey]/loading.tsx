import { Spinner } from "@/components/ui/spinner";

export default function JiraTicketDetailLoading() {
  return (
    <div className="flex w-full items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
    </div>
  );
}
