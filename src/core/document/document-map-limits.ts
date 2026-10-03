export const DEFAULT_MAX_DOCUMENT_MAP_HEADINGS = 10_000;
export const MAX_DOCUMENT_MAP_HEADINGS = 100_000;

export interface DocumentMapLimitOptions {
  /** Maximum headings accepted. Defaults to 10,000. */
  readonly maxHeadings?: number;
}
export type MarkdownDocumentMapErrorCode = "invalid_heading_limit" | "too_many_headings";
export abstract class MarkdownDocumentMapError extends Error {
  abstract readonly code: MarkdownDocumentMapErrorCode;
  protected constructor(message: string) { super(message); this.name = "MarkdownDocumentMapError"; }
}
export class InvalidDocumentMapHeadingLimitError extends MarkdownDocumentMapError {
  override readonly code = "invalid_heading_limit";
  constructor(readonly maxHeadings: number) {
    super(`maxHeadings must be an integer from 1 through ${MAX_DOCUMENT_MAP_HEADINGS}`);
    this.name = "InvalidDocumentMapHeadingLimitError";
  }
}
export class MarkdownDocumentMapTooLargeError extends MarkdownDocumentMapError {
  override readonly code = "too_many_headings";
  constructor(readonly maxHeadings: number, readonly observedAtLeast: number) {
    super(`Markdown document exceeds the ${maxHeadings}-heading map limit`);
    this.name = "MarkdownDocumentMapTooLargeError";
  }
}
