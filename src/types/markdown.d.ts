declare module "*.md" {
  import type { ComponentType } from "react";

  const MarkdownContent: ComponentType;
  export default MarkdownContent;
}
