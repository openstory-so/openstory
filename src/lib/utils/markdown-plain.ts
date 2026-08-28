/**
 * Strip common markdown syntax from a string for plain-text previews
 * (e.g. scene card descriptions, list summaries). Not a full markdown
 * parser — keeps the visible characters, drops the syntax sigils.
 */
export function stripMarkdown(input: string): string {
  if (!input) return '';

  let out = input;

  // Fenced code blocks: keep inner content, drop the fences
  out = out.replace(/```[a-z0-9-]*\n([\s\S]*?)```/gi, '$1');
  // Inline code: drop backticks
  out = out.replace(/`([^`]+)`/g, '$1');
  // Images: ![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bold + italic combined (***x*** or ___x___)
  out = out.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
  // Bold (**x** or __x__)
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2');
  // Italic (*x* or _x_) — avoid mid-word underscores like snake_case_name
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2');
  out = out.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1$2');
  // Strikethrough (~~x~~)
  out = out.replace(/~~(.+?)~~/g, '$1');
  // Blockquote markers at line start
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  // List markers (-, *, +, 1.) at line start
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '');
  out = out.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // ATX headings (#, ##, ###...) at line start
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Horizontal rules (---, ***, ___)
  out = out.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, '');

  return out.trim();
}

/**
 * Scene titles are labels, never markdown. Scripts are authored in a
 * markdown editor, so a heading line (`## Office`, `**INT. KITCHEN**`)
 * must not become the stored/shown title.
 */
export function plainSceneTitle(title: string | null | undefined): string {
  return stripMarkdown(title ?? '');
}
