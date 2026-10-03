import { fromMarkdown } from "mdast-util-from-markdown";
import { buildModel, type SectionNode } from "markdown-patch";
import { frontmatterRegion, withoutBom } from "../document/note-json.js";
import { ReferenceQueryError, type ParsedReference, type ParsedReferences } from "./types.js";

interface Node {
  type: string;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
  children?: Node[] | undefined;
  url?: string | undefined;
  identifier?: string | undefined;
}
const range = (node: Node): [number, number] => [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
const escaped = (source: string, at: number): boolean => {
  let slashes = 0;
  while (at > 0 && source[--at] === "\\") slashes++;
  return slashes % 2 === 1;
};
const blank = (value: string): string => value.replace(/[^\r\n]/g, " "); // Preserve UTF-16 width, including emoji.
function walk(root: Node, visit: (node: Node) => void): void {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    if (++count > 100_000) throw new ReferenceQueryError("parse_limit", "nodes");
    const node = pending.pop()!;
    visit(node);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]!);
  }
}

/** Source spans always index the original string. No normalized-text substring search. */
export function parseReferences(source: string, includeTargets = false): ParsedReferences {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const bodyStart = bom + (frontmatterRegion(withoutBom(source))?.bodyStart ?? 0);
  let text = blank(source.slice(0, bodyStart)) + source.slice(bodyStart);
  const protectedBytes = new Uint8Array(source.length);
  protectedBytes.fill(1, 0, bodyStart);
  const markdownBySpan = new Map<string, Node>();
  const protect = (root: Node): void => walk(root, node => {
    if (["code", "inlineCode", "html", "definition"].includes(node.type)) protectedBytes.fill(1, ...range(node));
    if (["link", "image", "linkReference", "imageReference"].includes(node.type)) {
      const [start, end] = range(node);
      // Keep only destinations parsed from original text, including links that
      // cease to parse after an overlapping comment/math region is blanked.
      if (source.slice(start, end) === text.slice(start, end)) markdownBySpan.set(`${start}:${end}`, node);
    }
  });
  const comments: [number, number][] = [];
  for (let pass = 0; pass < 8; pass++) {
    protectedBytes.fill(0);
    protectedBytes.fill(1, 0, bodyStart);
    protect(fromMarkdown(text));
    const discovered: [number, number][] = [];
    for (let i = bodyStart; i < text.length; i++) {
      if (protectedBytes[i] || escaped(text, i)) continue;
      if (text.startsWith("%%", i)) {
        let end = text.indexOf("%%", i + 2);
        while (end >= 0 && escaped(text, end)) end = text.indexOf("%%", end + 2);
        end = end < 0 ? text.length : end + 2;
        discovered.push([i, end]); i = end - 1;
      } else if (text[i] === "$") {
        const delimiter = text[i + 1] === "$" ? "$$" : "$";
        let end = text.indexOf(delimiter, i + delimiter.length);
        while (end >= 0 && escaped(text, end)) end = text.indexOf(delimiter, end + delimiter.length);
        if (end >= 0 && (delimiter === "$$" || !/[\r\n]/u.test(text.slice(i, end)))) {
          end += delimiter.length; discovered.push([i, end]); i = end - 1;
        }
      }
    }
    if (discovered.length === 0) break;
    if (pass === 7) throw new ReferenceQueryError("parse_limit", "opaque_regions");
    // Mask in one pass. A fresh parse releases text hidden by fences inside comments/math.
    const parts: string[] = [];
    let previous = 0;
    for (const [start, end] of discovered) {
      parts.push(text.slice(previous, start), blank(text.slice(start, end))); previous = end;
    }
    parts.push(text.slice(previous)); text = parts.join("");
    comments.push(...discovered);
  }
  const tree = fromMarkdown(text);
  protectedBytes.fill(0);
  protectedBytes.fill(1, 0, bodyStart);
  protect(tree);
  for (const [start, end] of comments) protectedBytes.fill(1, start, end);
  const markdown = [...markdownBySpan.values()].filter(node => !protectedBytes[range(node)[0]]);
  const definitions = new Map<string, string>();
  walk(tree, node => {
    if (node.type === "definition" && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url!);
  });
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\r") { if (source[i + 1] === "\n") i++; lineStarts.push(i + 1); }
    else if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const links: ParsedReference[] = [];
  const add = (start: number, end: number, href: string, syntax: ParsedReference["syntax"], embed: boolean, unsupported?: string): void => {
    if (links.length >= 10_000 || end - start > 16_384) throw new ReferenceQueryError("parse_limit", "links");
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineStarts[mid]! <= start) low = mid; else high = mid; }
    links.push({ start, end, line: low + 1, column: start - lineStarts[low]! + 1, raw: source.slice(start, end), href,
      syntax, embed, ...(unsupported ? { unsupported } : {}) });
  };
  const wikiSpans: [number, number][] = [];
  for (let i = bodyStart; i < source.length - 1; i++) {
    if (protectedBytes[i] || !source.startsWith("[[", i) || escaped(source, i)) continue;
    if (markdown.some(node => { const [s, e] = range(node); return s <= i && i < e; })) continue;
    let end = i + 2;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r" &&
      !(source.startsWith("]]", end) && !escaped(source, end))) {
      if (end - i > 16_384) throw new ReferenceQueryError("parse_limit", "link_length");
      end++;
    }
    const closed = source.startsWith("]]", end);
    const inner = source.slice(i + 2, end);
    const stop = closed ? end + 2 : end;
    const embed = i > 0 && source[i - 1] === "!" && !escaped(source, i - 1);
    const start = embed ? i - 1 : i;
    const destination = inner.split(/\\?\|/u)[0]!.trim().replace(/\\([\\[\]|])/gu, "$1");
    const nested = inner.includes("[[") || markdown.some(node => { const [s, e] = range(node); return s < stop && e > i; });
    const obscured = protectedBytes.subarray(i, stop).some(value => value !== 0);
    add(start, stop, destination, "wikilink", embed,
      !closed ? "unclosed_wikilink" : nested || obscured ? "nested_wikilink_syntax" : undefined);
    wikiSpans.push([start, stop]); i = stop - 1;
  }
  for (const node of markdown) {
    const [start, end] = range(node);
    if (wikiSpans.some(([s, e]) => start < e && end > s)) continue;
    const href = node.url ?? definitions.get(node.identifier ?? "");
    if (href !== undefined) add(start, end, href, "markdown", node.type.startsWith("image"),
      source.slice(start, end) !== text.slice(start, end) ? "opaque_link_syntax" : undefined);
  }
  const headings: { path: string[]; supported: boolean }[] = [];
  const blocks: string[] = [];
  if (includeTargets) {
    // The established structural parser owns heading hierarchy and block attachment.
    const modelExcluded = new Uint8Array(source.length);
    walk(tree, node => { if (["code", "html", "definition"].includes(node.type)) modelExcluded.fill(1, ...range(node)); });
    const clean = text.split("");
    for (let i = 0; i < clean.length; i++) if (modelExcluded[i] && clean[i] !== "\r" && clean[i] !== "\n") clean[i] = " ";
    const modelText = clean.join("");
    const model = buildModel(modelText);
    const pending: { node: SectionNode; path: string[]; supported: boolean }[] = [{ node: model.root, path: [], supported: true }];
    while (pending.length) {
      const { node, path, supported } = pending.pop()!;
      if (headings.length + blocks.length + node.blocks.length > 10_000) throw new ReferenceQueryError("parse_limit", "targets");
      blocks.push(...node.blocks.map(block => block.id));
      for (let i = node.children.length - 1; i >= 0; i--) {
        if (headings.length + blocks.length >= 10_000) throw new ReferenceQueryError("parse_limit", "targets");
        const child = node.children[i]!, label = child.heading!.text;
        const next = [...path, label];
        const marker = child.marker!;
        // The structural model can trim masked trailing text from an ATX marker.
        // Compare its full physical line(s), without including the next body line.
        let markerStart = marker.start, markerEnd = marker.end;
        while (markerStart > 0 && !/[\r\n]/u.test(source[markerStart - 1]!)) markerStart--;
        if (markerEnd > 0 && !/[\r\n]/u.test(source[markerEnd - 1]!)) {
          while (markerEnd < source.length && !/[\r\n]/u.test(source[markerEnd]!)) markerEnd++;
        }
        const plain = supported && source.slice(markerStart, markerEnd) === modelText.slice(markerStart, markerEnd) &&
          !/[*_`[\]<>~\\]|&(?:#\d+|#x[\da-f]+|[a-z]\w*);/iu.test(label);
        headings.push({ path: next, supported: plain });
        pending.push({ node: child, path: next, supported: plain });
      }
    }
  }
  return { links: links.sort((a, b) => a.start - b.start), headings, blocks };
}
