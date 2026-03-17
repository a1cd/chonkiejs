/**
 * Code chunker that splits code into chunks using tree-sitter AST parsing.
 */

import type { Node, Parser as TreeSitterParser, Language } from 'web-tree-sitter';
import { Tokenizer } from '@/tokenizer';
import { Chunk } from '@/types';

export interface CodeChunkerOptions {
  /** Tokenizer instance or model name (default: 'character') */
  tokenizer?: Tokenizer | string;
  /** Maximum tokens per chunk (default: 2048) */
  chunkSize?: number;
  /** Pre-configured tree-sitter Parser with a language already set */
  parser?: TreeSitterParser;
  /** Path/URL to a language WASM file, or a Language instance (used when parser is not provided) */
  language?: string | Language;
}

type NodeGroup = Node[];

/**
 * Splits code into semantically meaningful chunks using a tree-sitter AST.
 *
 * Recursively groups AST child nodes into chunks that respect the token size
 * limit. Whitespace and formatting between nodes is preserved by using the
 * original byte offsets.
 */
export class CodeChunker {
  public readonly chunkSize: number;
  private tokenizer: Tokenizer;
  private parser: TreeSitterParser;

  private constructor(tokenizer: Tokenizer, chunkSize: number, parser: TreeSitterParser) {
    this.tokenizer = tokenizer;
    this.chunkSize = chunkSize;
    this.parser = parser;
  }

  /**
   * Create a CodeChunker instance.
   *
   * Requires either a pre-configured `parser` or a `language` option (WASM path or Language object).
   *
   * @example
   * // With a language WASM path:
   * const chunker = await CodeChunker.create({
   *   language: '/path/to/tree-sitter-javascript.wasm',
   *   chunkSize: 512,
   * });
   *
   * @example
   * // With a pre-configured parser:
   * import Parser from 'web-tree-sitter';
   * await Parser.init();
   * const parser = new Parser();
   * const lang = await Parser.Language.load('/path/to/tree-sitter-python.wasm');
   * parser.setLanguage(lang);
   * const chunker = await CodeChunker.create({ parser, chunkSize: 512 });
   */
  static async create(options: CodeChunkerOptions = {}): Promise<CodeChunker> {
    const { tokenizer = 'character', chunkSize = 2048 } = options;

    if (chunkSize <= 0) {
      throw new Error('chunkSize must be greater than 0');
    }

    let tokenizerInstance: Tokenizer;
    if (typeof tokenizer === 'string') {
      tokenizerInstance = await Tokenizer.create(tokenizer);
    } else {
      tokenizerInstance = tokenizer;
    }

    // Dynamic import to avoid issues in builds that don't use CodeChunker
    const { Parser: ParserImpl, Language: LanguageImpl } = await import('web-tree-sitter');

    let parser: TreeSitterParser;

    if (options.parser) {
      parser = options.parser;
    } else if (options.language) {
      await ParserImpl.init();
      const lang = typeof options.language === 'string'
        ? await LanguageImpl.load(options.language)
        : options.language;
      parser = new ParserImpl();
      parser.setLanguage(lang);
    } else {
      throw new Error(
        'CodeChunker requires either a `parser` or a `language` option. ' +
        'Pass a pre-configured tree-sitter Parser, or a path to a language WASM file.'
      );
    }

    return new CodeChunker(tokenizerInstance, chunkSize, parser);
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

      if (startByte > endByte || startByte < 0 || endByte > originalBytes.length) continue;

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
      chunks.push(new Chunk({
        text,
        startIndex: currentIndex,
        endIndex: currentIndex + text.length,
        tokenCount: tokenCounts[i],
      }));
      currentIndex += text.length;
    }

    return chunks;
  }

  /**
   * Chunk code into AST-aware chunks.
   *
   * @param text - The source code to chunk
   * @returns Array of chunks
   */
  async chunk(text: string): Promise<Chunk[]> {
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
    return `CodeChunker(chunkSize=${this.chunkSize})`;
  }
}
