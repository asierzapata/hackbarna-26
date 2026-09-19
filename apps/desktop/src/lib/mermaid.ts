const diagramKeyword = /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|mindmap|classDiagram|erDiagram|gantt|pie|gitGraph|journey|quadrantChart|timeline|xychart-beta|block-beta|packet-beta|architecture-beta|kanban|sankey-beta|zenuml|requirementDiagram|C4Context)(?![\w-])/i;

export function stripMermaidFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed)
    ?? /```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i.exec(trimmed);
  return match?.[1].trim() ?? trimmed;
}

function cleanMermaidSource(text: string): string {
  return stripMermaidFence(text)
    .replace(/^\uFEFF/, "")
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("%%"))
    .join("\n")
    .trim();
}

export function isMermaidSource(text: string): boolean {
  const source = stripMermaidFence(text);
  const cleaned = cleanMermaidSource(source);
  const match = diagramKeyword.exec(cleaned);
  if (!match) return false;

  const rest = cleaned.slice(match[0].length).trim();
  if (!rest) return false;
  if (/^```/i.test(text.trim())) return true;
  return /\r?\n|-->|---|==>|-.->|->>|\[|\(|\{|:/.test(rest);
}
