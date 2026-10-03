const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const NUMBER = /^\p{N}$/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const INLINE_TAG_OPENING_BOUNDARIES = new Set([
  "(",
  "[",
  "{",
  "'",
  "\"",
  ">",
  "‘",
  "“",
]);

interface SourceLine {
  readonly text: string;
}

interface FrontmatterRegion {
  readonly bodyStartLine: number;
  readonly tagValues: readonly string[];
}

interface FenceState {
  readonly character: "`" | "~";
  readonly length: number;
}

interface InlineState {
  inHtmlComment: boolean;
}

/**
 * Extracts the conservative tag subset supported by the server-side core.
 *
 * Supported sources are the leading YAML `tags` block/flow list and inline
 * hashtags outside fenced code, complete single-line code spans, and HTML
 * comments. Returned names omit `#` and preserve source order/casing.
 * Validation is intentionally narrower than Obsidian's private metadata-cache
 * parser.
 */
export function extractDocumentTags(source: string): readonly string[] {
  const lines = splitSourceLines(source);
  const frontmatter = readFrontmatter(lines);
  const tags = [...frontmatter.tagValues];
  const state: InlineState = {
    inHtmlComment: false,
  };
  let fence: FenceState | undefined;

  for (let lineIndex = frontmatter.bodyStartLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!.text;

    if (fence !== undefined) {
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }

    if (!state.inHtmlComment) {
      const openingFence = readOpeningFence(line);
      if (openingFence !== undefined) {
        fence = openingFence;
        continue;
      }
    }

    scanInlineTags(line, state, tags);
  }

  return Object.freeze(tags);
}

function splitSourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) continue;
    lines.push(Object.freeze({ text: source.slice(start, index) }));
    if (code === 0x0d && source.charCodeAt(index + 1) === 0x0a) index += 1;
    start = index + 1;
  }
  lines.push(Object.freeze({ text: source.slice(start) }));
  return Object.freeze(lines);
}

function readFrontmatter(lines: readonly SourceLine[]): FrontmatterRegion {
  if (lines[0]?.text !== "---") {
    return Object.freeze({ bodyStartLine: 0, tagValues: Object.freeze([]) });
  }

  let closingLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const text = lines[index]!.text;
    if (text === "---" || text === "...") {
      closingLine = index;
      break;
    }
  }
  if (closingLine < 0) {
    return Object.freeze({
      bodyStartLine: lines.length,
      tagValues: Object.freeze([]),
    });
  }

  const tagValues: string[] = [];
  for (let index = 1; index < closingLine; index += 1) {
    const line = lines[index]!.text;
    const property = /^tags:[ \t]*(.*)$/.exec(line);
    if (property === null) continue;
    const remainder = property[1] ?? "";

    if (remainder.trimStart().startsWith("[")) {
      const values = parseFlowSequence(remainder);
      if (values !== undefined) tagValues.push(...values);
      continue;
    }

    if (remainder.trim().length !== 0) continue;
    for (let itemIndex = index + 1; itemIndex < closingLine; itemIndex += 1) {
      const itemLine = lines[itemIndex]!.text;
      if (itemLine.trim().length === 0 || itemLine.trimStart().startsWith("#")) {
        continue;
      }
      const item = /^[ \t]+-[ \t]+(.*)$/.exec(itemLine);
      if (item === null) break;
      const value = parseYamlScalar(item[1] ?? "");
      if (value !== undefined) tagValues.push(value);
      index = itemIndex;
    }
  }

  return Object.freeze({
    bodyStartLine: closingLine + 1,
    tagValues: Object.freeze(
      tagValues.flatMap((value) => {
        const valid = parseWholeTag(value);
        return valid === undefined ? [] : [valid];
      }),
    ),
  });
}

function parseFlowSequence(source: string): readonly string[] | undefined {
  const flow = source.trimStart();
  if (!flow.startsWith("[")) return undefined;
  const tokens: string[] = [];
  let tokenStart = 1;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let closingIndex = -1;

  for (let index = 1; index < flow.length; index += 1) {
    const character = flow[index]!;
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && flow[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ",") {
      const token = flow.slice(tokenStart, index);
      if (token.trim().length === 0) return undefined;
      tokens.push(token);
      tokenStart = index + 1;
    } else if (character === "]") {
      const token = flow.slice(tokenStart, index);
      if (token.trim().length > 0) {
        tokens.push(token);
      } else if (tokens.length === 0 && tokenStart !== 1) {
        return undefined;
      }
      closingIndex = index;
      break;
    } else if (character === "[" || character === "#") {
      return undefined;
    }
  }

  if (quote !== undefined || closingIndex < 0) return undefined;
  const trailing = flow.slice(closingIndex + 1);
  if (!/^[ \t]*$/.test(trailing) && !/^[ \t]+#/.test(trailing)) {
    return undefined;
  }

  const values: string[] = [];
  for (const token of tokens) {
    const value = parseYamlScalar(token);
    if (value === undefined) return undefined;
    const tag = parseWholeTag(value);
    if (tag === undefined) return undefined;
    values.push(tag);
  }
  return Object.freeze(values);
}

function parseYamlScalar(source: string): string | undefined {
  let trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;

  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return undefined;
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith("\"")) {
    if (!trimmed.endsWith("\"") || trimmed.length < 2) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  const comment = /[ \t]+#/.exec(trimmed);
  if (comment?.index !== undefined) trimmed = trimmed.slice(0, comment.index).trimEnd();
  return trimmed.length === 0 ? undefined : trimmed;
}

function scanInlineTags(
  line: string,
  state: InlineState,
  output: string[],
): void {
  let index = 0;
  while (index < line.length) {
    if (state.inHtmlComment) {
      const commentEnd = line.indexOf("-->", index);
      if (commentEnd < 0) return;
      state.inHtmlComment = false;
      index = commentEnd + 3;
      continue;
    }

    if (line.startsWith("<!--", index)) {
      state.inHtmlComment = true;
      index += 4;
      continue;
    }
    if (line[index] === "`") {
      const runLength = countRun(line, index, "`");
      if (!isBackslashEscaped(line, index)) {
        const codeSpanEnd = findSingleLineCodeSpanEnd(
          line,
          index + runLength,
          runLength,
        );
        if (codeSpanEnd !== undefined) {
          index = codeSpanEnd;
          continue;
        }
      }
      index += runLength;
      continue;
    }
    if (line[index] === "#" && isInlineTagBoundary(line, index)) {
      const parsed = parseTagAt(line, index + 1);
      if (parsed !== undefined) {
        output.push(parsed.name);
        index = parsed.end;
        continue;
      }
    }
    index += codePointLengthAt(line, index);
  }
}

function readOpeningFence(line: string): FenceState | undefined {
  const indent = countLeadingSpaces(line);
  if (indent > 3) return undefined;
  const character = line[indent];
  if (character !== "`" && character !== "~") return undefined;
  const length = countRun(line, indent, character);
  if (length < 3) return undefined;
  if (character === "`" && line.slice(indent + length).includes("`")) {
    return undefined;
  }
  return Object.freeze({ character, length });
}

function findSingleLineCodeSpanEnd(
  line: string,
  start: number,
  openingLength: number,
): number | undefined {
  let index = start;
  while (index < line.length) {
    const candidate = line.indexOf("`", index);
    if (candidate < 0) return undefined;
    const length = countRun(line, candidate, "`");
    if (length === openingLength && !isBackslashEscaped(line, candidate)) {
      return candidate + length;
    }
    index = candidate + length;
  }
  return undefined;
}

function isBackslashEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const indent = countLeadingSpaces(line);
  if (indent > 3 || line[indent] !== fence.character) return false;
  const length = countRun(line, indent, fence.character);
  return length >= fence.length && /^[ \t]*$/.test(line.slice(indent + length));
}

function countLeadingSpaces(line: string): number {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

function countRun(line: string, start: number, character: string): number {
  let end = start;
  while (line[end] === character) end += 1;
  return end - start;
}

function isInlineTagBoundary(line: string, index: number): boolean {
  if (index === 0) return true;
  const previous = line[index - 1]!;
  return /\s/u.test(previous) || INLINE_TAG_OPENING_BOUNDARIES.has(previous);
}

function parseWholeTag(source: string): string | undefined {
  const candidate = source.startsWith("#") ? source.slice(1) : source;
  const parsed = parseTagAt(candidate, 0);
  return parsed !== undefined && parsed.end === candidate.length
    ? parsed.name
    : undefined;
}

function parseTagAt(
  source: string,
  start: number,
): { readonly end: number; readonly name: string } | undefined {
  let index = start;
  let segmentHasAtom = false;
  let hasNonNumericAtom = false;

  while (index < source.length) {
    const codePoint = String.fromCodePoint(source.codePointAt(index)!);
    if (isTagAtom(codePoint)) {
      segmentHasAtom = true;
      if (!NUMBER.test(codePoint) && !isEmojiJoiner(codePoint)) {
        hasNonNumericAtom = true;
      }
      index += codePoint.length;
      continue;
    }
    if (codePoint === "/" && segmentHasAtom && hasTagAtomAt(source, index + 1)) {
      segmentHasAtom = false;
      index += 1;
      continue;
    }
    break;
  }

  if (index === start || !segmentHasAtom || !hasNonNumericAtom) return undefined;
  return Object.freeze({ end: index, name: source.slice(start, index) });
}

function hasTagAtomAt(source: string, index: number): boolean {
  if (index >= source.length) return false;
  const codePoint = String.fromCodePoint(source.codePointAt(index)!);
  return isTagAtom(codePoint) && !isEmojiJoiner(codePoint);
}

function isTagAtom(codePoint: string): boolean {
  return (
    LETTER_OR_MARK.test(codePoint) ||
    NUMBER.test(codePoint) ||
    EXTENDED_PICTOGRAPHIC.test(codePoint) ||
    codePoint === "_" ||
    codePoint === "-" ||
    isEmojiJoiner(codePoint)
  );
}

function isEmojiJoiner(codePoint: string): boolean {
  return codePoint === "\u200d" || codePoint === "\ufe0f";
}

function codePointLengthAt(source: string, index: number): number {
  const codePoint = source.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}
