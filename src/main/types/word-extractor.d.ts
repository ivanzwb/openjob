declare module 'word-extractor' {
  interface TextboxOptions {
    includeHeadersAndFooters?: boolean;
    includeBody?: boolean;
  }

  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(options?: TextboxOptions): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<WordDocument>;
  }
}
