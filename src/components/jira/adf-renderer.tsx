import type { ReactNode } from "react";

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
};

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function markedText(node: AdfNode, key: string): ReactNode {
  let result: ReactNode = node.text ?? "";
  for (const [index, mark] of (node.marks ?? []).entries()) {
    const markKey = `${key}-mark-${index}`;
    if (mark.type === "strong")
      result = <strong key={markKey}>{result}</strong>;
    else if (mark.type === "em") result = <em key={markKey}>{result}</em>;
    else if (mark.type === "strike") result = <s key={markKey}>{result}</s>;
    else if (mark.type === "code") {
      result = (
        <code key={markKey} className="rounded bg-muted px-1 py-0.5 text-xs">
          {result}
        </code>
      );
    } else if (mark.type === "link") {
      const href = safeHref(mark.attrs?.href);
      if (href) {
        result = (
          <a
            key={markKey}
            className="text-primary underline underline-offset-2"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {result}
          </a>
        );
      }
    }
  }
  return result;
}

function renderNode(node: AdfNode, key: string): ReactNode {
  const children = (node.content ?? []).map((child, index) =>
    renderNode(child, `${key}-${index}`),
  );
  switch (node.type) {
    case "doc":
      return (
        <div key={key} className="space-y-3">
          {children}
        </div>
      );
    case "paragraph":
      return (
        <p key={key} className="whitespace-pre-wrap leading-6">
          {children.length ? children : <br />}
        </p>
      );
    case "heading": {
      const level = Number(node.attrs?.level ?? 3);
      if (level <= 2)
        return (
          <h2 key={key} className="text-lg font-semibold">
            {children}
          </h2>
        );
      if (level === 3)
        return (
          <h3 key={key} className="font-semibold">
            {children}
          </h3>
        );
      return (
        <h4 key={key} className="font-medium">
          {children}
        </h4>
      );
    }
    case "text":
      return <span key={key}>{markedText(node, key)}</span>;
    case "hardBreak":
      return <br key={key} />;
    case "bulletList":
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {children}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {children}
        </ol>
      );
    case "listItem":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">
          {children}
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-lg bg-muted p-3 text-xs"
        >
          <code>{children}</code>
        </pre>
      );
    case "rule":
      return <hr key={key} className="border-border" />;
    case "mention":
      return (
        <span key={key} className="rounded bg-primary/10 px-1 text-primary">
          @{String(node.attrs?.text ?? node.attrs?.id ?? "user")}
        </span>
      );
    case "emoji":
      return (
        <span key={key}>
          {String(node.attrs?.text ?? node.attrs?.shortName ?? "")}
        </span>
      );
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{children}</tr>;
    case "tableHeader":
      return (
        <th key={key} className="border bg-muted p-2 text-left font-medium">
          {children}
        </th>
      );
    case "tableCell":
      return (
        <td key={key} className="border p-2 align-top">
          {children}
        </td>
      );
    default:
      return children.length > 0 ? <span key={key}>{children}</span> : null;
  }
}

export function AdfRenderer({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <p className="whitespace-pre-wrap leading-6">{value}</p>;
  if (!value || typeof value !== "object")
    return <p className="text-muted-foreground">—</p>;
  return renderNode(value as AdfNode, "adf-root");
}
