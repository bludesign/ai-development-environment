import { CommandEditor } from "@/components/commands/command-editor";

export default async function EditCommandRoute({
  params,
}: {
  params: Promise<{ commandId: string }>;
}) {
  return <CommandEditor commandId={(await params).commandId} />;
}
