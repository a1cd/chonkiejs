/**
 * Code chunker that splits code into chunks using tree-sitter AST parsing.
 *
 * API mirrors Python `chonkie.chunker.code.CodeChunker`: tokenizer, chunk size,
 * and a `language` string id, wasm path/URL, or a pre-configured `parser`.
 */

import type { Node, Parser as TreeSitterParser, Language } from 'web-tree-sitter';
import { Tokenizer } from '@/tokenizer';
import { Chunk } from '@/types';

export interface CodeChunkerOptions {
  /** Tokenizer instance or model name (default: 'character') */
  tokenizer?: Tokenizer | string;
  /** Maximum tokens per chunk (default: 2048) */
  chunkSize?: number;
  /**
   * Tree-sitter grammar, like Python `CodeChunker(language=...)`.
   *
   * - Filesystem path or `file:` / `https:` URL to a **web-tree-sitter** language
   *   `.wasm` (build grammars with the same tree-sitter version as `web-tree-sitter`).
   * - A `Language` instance from `Language.load(...)`.
   *
   * Short ids such as `"python"` or `"javascript"` resolve to grammars shipped in
   * the `tree-sitter-wasms` package (install it next to your app; same layout as
   * `tree-sitter-wasms/out/tree-sitter-<id>.wasm`).
   *
   * `"auto"` is not supported in JavaScript.
   */
  language?: string | Language;
  /** Pre-configured Parser with language set; when set, `language` is ignored */
  parser?: TreeSitterParser;
}

type NodeGroup = Node[];

function looksLikeWasmSource(s: string): boolean {
  const t = s.trim();
  return (
    t.endsWith('.wasm') ||
    t.startsWith('file:') ||
    t.startsWith('http:') ||
    t.startsWith('https:') ||
    t.startsWith('/') ||
    t.startsWith('./') ||
    t.startsWith('../') ||
    /^[a-zA-Z]:[\\/]/.test(t)
  );
}

/** Lowercase tree-sitter grammar names allowed for `tree-sitter-wasms` resolution. */
const TREE_SITTER_WASMS_LANG_ID = /^[a-z0-9_-]+$/;

/**
 * Resolve `tree-sitter-wasms/out/tree-sitter-<id>.wasm` when the package is
 * installed (Node.js only). Returns null if the id is invalid or resolve fails.
 */
async function resolveTreeSitterWasmsPath(languageId: string): Promise<string | null> {
  const id = languageId.toLowerCase().trim();
  if (!TREE_SITTER_WASMS_LANG_ID.test(id)) return null;

  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (!isNode) return null;

  try {
    const { createRequire } = await import('node:module');
    const { fileURLToPath } = await import('node:url');
    const nodeRequire = createRequire(fileURLToPath(import.meta.url));
    return nodeRequire.resolve(`tree-sitter-wasms/out/tree-sitter-${id}.wasm`);
  } catch {
    return null;
  }
}

/**
 * Load grammar wasm from a path, file URL, or https URL.
 * On Node.js, local `.wasm` paths are passed as filesystem strings so
 * `web-tree-sitter` opens them itself (avoids broken Windows `file:` URL joins).
 */
async function loadLanguageWasm(
  specifier: string,
  LanguageImpl: typeof import('web-tree-sitter').Language
): Promise<Language> {
  const s = specifier.trim();
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return LanguageImpl.load(s);
  }

  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (isNode) {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { existsSync } = await import('node:fs');

    let filePath: string | undefined;
    if (s.startsWith('file:')) {
      filePath = fileURLToPath(s);
    } else if (
      s.endsWith('.wasm') ||
      path.isAbsolute(s) ||
      s.startsWith('./') ||
      s.startsWith('../') ||
      /^[a-zA-Z]:[\\/]/.test(s) ||
      (s.startsWith('/') && !s.startsWith('//'))
    ) {
      filePath =
        path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || (s.startsWith('/') && !s.startsWith('//'))
          ? s
          : path.resolve(process.cwd(), s);
    }

    if (filePath !== undefined) {
      if (!existsSync(filePath)) {
        throw new Error(`CodeChunker: wasm file not found: ${filePath}`);
      }
      // Pass a path string on Node so web-tree-sitter loads the file (avoids broken
      // `file:` URL handling on Windows when using `pathToFileURL` + string).
      return LanguageImpl.load(filePath);
    }
  }

  return LanguageImpl.load(s);
}

async function loadLanguageFromOption(
  language: string | Language,
  LanguageImpl: typeof import('web-tree-sitter').Language
): Promise<Language> {
  if (typeof language !== 'string') {
    return language;
  }

  const trimmed = language.trim();
  if (trimmed === 'auto') {
    throw new Error(
      'CodeChunker: language "auto" is not supported in JavaScript. ' +
        'Pass a language id (e.g. "javascript") with `tree-sitter-wasms` installed, a .wasm path or URL, or `parser`.'
    );
  }

  if (looksLikeWasmSource(trimmed)) {
    return loadLanguageWasm(trimmed, LanguageImpl);
  }

  const fromWasms = await resolveTreeSitterWasmsPath(trimmed);
  if (fromWasms) {
    return loadLanguageWasm(fromWasms, LanguageImpl);
  }

  throw new Error(
    `CodeChunker: unknown language "${trimmed}". ` +
      'Pass a language id supported by `tree-sitter-wasms` (with that package installed), ' +
      'a path or URL to a web-tree-sitter grammar `.wasm`, a `Language` instance, or use `parser`.'
  );
}

/**
 * Splits code into semantically meaningful chunks using a tree-sitter AST.
 *
 * Recursively groups AST child nodes into chunks that respect the token size
 * limit. Whitespace and formatting between nodes is preserved by using the
 * original byte offsets.
 */
export class CodeChunker {
  public readonly chunkSize: number;
  /** Language id or wasm source passed at creation, or `'parser'` when a parser was supplied */
  public readonly language: string | Language;
  private tokenizer: Tokenizer;
  private parser: TreeSitterParser;

  private constructor(
    tokenizer: Tokenizer,
    chunkSize: number,
    parser: TreeSitterParser,
    language: string | Language
  ) {
    this.tokenizer = tokenizer;
    this.chunkSize = chunkSize;
    this.parser = parser;
    this.language = language;
  }

  /**
   * Create a CodeChunker instance (async: tokenizer + tree-sitter init).
   *
   * Mirrors Python `CodeChunker(tokenizer=..., chunk_size=..., language=...)`:
   * pass a `tree-sitter-wasms` language id, a grammar wasm path/URL (web-tree-sitter format),
   * a `Language` instance, or a pre-built `parser`.
   *
   * @example
   * const chunker = await CodeChunker.create({
   *   language: 'javascript',
   *   chunkSize: 512,
   * });
   *
   * @example
   * const chunker = await CodeChunker.create({
   *   language: '/path/to/tree-sitter-python.wasm',
   *   chunkSize: 512,
   * });
   * const chunks = chunker.chunk(source);
   *
   * @example
   * // Advanced: pre-configured parser
   * const chunker = await CodeChunker.create({ parser, chunkSize: 512 });
   */
  static async create(options: CodeChunkerOptions = {}): Promise<CodeChunker> {
    const { tokenizer = 'character', chunkSize = 2048, parser: parserOpt } = options;

    if (chunkSize <= 0) {
      throw new Error('chunkSize must be greater than 0');
    }

    let tokenizerInstance: Tokenizer;
    if (typeof tokenizer === 'string') {
      tokenizerInstance = await Tokenizer.create(tokenizer);
    } else {
      tokenizerInstance = tokenizer;
    }

    const { Parser: ParserImpl, Language: LanguageImpl } = await import('web-tree-sitter');

    let parser: TreeSitterParser;
    let languageRecord: string | Language;

    if (parserOpt) {
      parser = parserOpt;
      languageRecord = 'parser';
    } else if (options.language !== undefined) {
      await ParserImpl.init();
      const langOpt = options.language;
      const lang = await loadLanguageFromOption(langOpt, LanguageImpl);
      parser = new ParserImpl();
      parser.setLanguage(lang);
      languageRecord = typeof langOpt === 'string' ? langOpt.trim() : langOpt;
    } else {
      throw new Error(
        'CodeChunker requires `language` (wasm path/URL or Language) or `parser`, ' +
          'like Python `CodeChunker(language=...)`. `language="auto"` is not supported in JavaScript.'
      );
    }

    return new CodeChunker(tokenizerInstance, chunkSize, parser, languageRecord);
  }

  /**
   * Recursively groups AST child nodes into groups that fit within chunkSize.
   *
   * For leaf nodes (no children), returns the node itself as a single group.
   * For non-leaf nodes, greedily packs children into groups and then merges
   * small adjacent groups using prefix sums and binary search.
   */
  private groupChildNodes(node: Node): [NodeGroup[], number[]] {
    // Base case: leaf nodes
    if (node.childCount === 0) {
      const tokenCount = this.tokenizer.countTokens(node.text ?? '');
      return [[[node]], [tokenCount]];
    }

    const nodeGroups: NodeGroup[] = [];
    const groupTokenCounts: number[] = [];
    let currentGroup: NodeGroup = [];
    let currentTokenCount = 0;

    for (const child of node.children) {
      if (child == null) continue;
      const tokenCount = this.tokenizer.countTokens(child.text ?? '');

      if (tokenCount > this.chunkSize) {
        // Flush current group first
        if (currentGroup.length > 0) {
          nodeGroups.push(currentGroup);
          groupTokenCounts.push(currentTokenCount);
          currentGroup = [];
          currentTokenCount = 0;
        }
        // Recurse into the oversized child
        const [childGroups, childTokenCounts] = this.groupChildNodes(child);
        nodeGroups.push(...childGroups);
        groupTokenCounts.push(...childTokenCounts);
      } else if (currentTokenCount + tokenCount > this.chunkSize) {
        // Flush and start a new group
        nodeGroups.push(currentGroup);
        groupTokenCounts.push(currentTokenCount);
        currentGroup = [child];
        currentTokenCount = tokenCount;
      } else {
        currentGroup.push(child);
        currentTokenCount += tokenCount;
      }
    }

    if (currentGroup.length > 0) {
      nodeGroups.push(currentGroup);
      groupTokenCounts.push(currentTokenCount);
    }

    // Phase 2: merge small adjacent groups using prefix sums
    // Build cumulative sum array: [0, g0, g0+g1, ...]
    const cumulative: number[] = [0];
    for (const count of groupTokenCounts) {
      cumulative.push(cumulative[cumulative.length - 1] + count);
    }

    const mergedGroups: NodeGroup[] = [];
    const mergedTokenCounts: number[] = [];
    let pos = 0;

    while (pos < nodeGroups.length) {
      const targetCumulative = cumulative[pos] + this.chunkSize;

      // Binary search for the rightmost index where cumulative <= target
      let lo = pos;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumulative[mid] <= targetCumulative) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      // lo is the last index in cumulative where sum <= target
      // The groups from pos to (lo - 1) can be merged
      let index = lo; // index is inclusive end in cumulative, exclusive in nodeGroups slice: nodeGroups[pos..index]
      if (index <= pos) index = pos + 1; // always take at least one group
      index = Math.min(index, nodeGroups.length);

      const groupsToMerge = nodeGroups.slice(pos, index);
      mergedGroups.push(groupsToMerge.flat());

      const actualCount = cumulative[index] - cumulative[pos];
      mergedTokenCounts.push(actualCount);

      pos = index;
    }

    return [mergedGroups, mergedTokenCounts];
  }

  /**
   * Reconstructs chunk texts from node groups using original byte offsets.
   *
   * Extends each group's end to the next group's start to capture whitespace
   * between nodes. Prepends leading bytes to the first chunk and appends
   * trailing bytes to the last chunk.
   */
  private getTextsFromNodeGroups(nodeGroups: NodeGroup[], originalBytes: Uint8Array): string[] {
    if (originalBytes.length === 0) return [];

    const decoder = new TextDecoder('utf-8');
    const chunkTexts: string[] = [];

    for (let i = 0; i < nodeGroups.length; i++) {
      const group = nodeGroups[i];
      if (group.length === 0) continue;

      const startByte = group[0].startIndex;
      let endByte = group[group.length - 1].endIndex;

      if (startByte > endByte || startByte < 0 || endByte > originalBytes.length) {
        throw new Error(
          `CodeChunker: invalid byte offsets for node group at index ${i}: ` +
            `start=${startByte}, end=${endByte}, total=${originalBytes.length}`
        );
      }

      // Extend end to next group's start to capture inter-node whitespace
      if (i < nodeGroups.length - 1) {
        endByte = nodeGroups[i + 1][0].startIndex;
      }

      chunkTexts.push(decoder.decode(originalBytes.slice(startByte, endByte)));
    }

    if (chunkTexts.length === 0) return chunkTexts;

    // Prepend any leading bytes not covered by the first group
    const firstGroupStartByte = nodeGroups[0][0].startIndex;
    if (firstGroupStartByte > 0) {
      chunkTexts[0] = decoder.decode(originalBytes.slice(0, firstGroupStartByte)) + chunkTexts[0];
    }

    // Append any trailing bytes not covered by the last group
    const lastGroup = nodeGroups[nodeGroups.length - 1];
    const lastGroupEndByte = lastGroup[lastGroup.length - 1].endIndex;
    if (lastGroupEndByte < originalBytes.length) {
      chunkTexts[chunkTexts.length - 1] += decoder.decode(originalBytes.slice(lastGroupEndByte));
    }

    return chunkTexts;
  }

  /**
   * Build Chunk objects from reconstructed texts with sequential character offsets.
   */
  private createChunks(texts: string[], tokenCounts: number[]): Chunk[] {
    const chunks: Chunk[] = [];
    let currentIndex = 0;

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const tokenCount = tokenCounts[i] ?? this.tokenizer.countTokens(text);
      chunks.push(new Chunk({
        text,
        startIndex: currentIndex,
        endIndex: currentIndex + text.length,
        tokenCount,
      }));
      currentIndex += text.length;
    }

    return chunks;
  }

  /**
   * Chunk code into AST-aware chunks (synchronous; parser is ready after `create`).
   */
  chunk(text: string): Chunk[] {
    if (!text || !text.trim()) {
      return [];
    }

    const originalBytes = new TextEncoder().encode(text);

    const tree = this.parser.parse(text);
    if (!tree) {
      return [];
    }

    const rootNode = tree.rootNode;
    const [nodeGroups, tokenCounts] = this.groupChildNodes(rootNode);
    const texts = this.getTextsFromNodeGroups(nodeGroups, originalBytes);

    tree.delete();

    return this.createChunks(texts, tokenCounts);
  }

  toString(): string {
    const lang =
      typeof this.language === 'string' ? JSON.stringify(this.language) : 'Language{…}';
    return `CodeChunker(chunkSize=${this.chunkSize}, language=${lang})`;
  }
}
