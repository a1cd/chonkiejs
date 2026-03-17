/**
 * Sentence chunker that splits text into chunks at sentence boundaries.
 */

import { split_offsets, merge_splits } from '@chonkiejs/chunk';
import { initWasm } from '@/wasm';
import { Tokenizer } from '@/tokenizer';
import { Chunk, IncludeDelim } from '@/types';

interface Sentence {
  text: string;
  startIndex: number;
  endIndex: number;
  tokenCount: number;
}

export interface SentenceChunkerOptions {
  /** Tokenizer instance or model name (default: 'character') */
  tokenizer?: Tokenizer | string;
  /** Maximum tokens per chunk (default: 2048) */
  chunkSize?: number;
  /** Number of overlapping tokens between chunks (default: 0) */
  chunkOverlap?: number;
  /** Minimum number of sentences per chunk (default: 1) */
  minSentencesPerChunk?: number;
  /** Minimum characters for a segment to count as a sentence (default: 12) */
  minCharactersPerSentence?: number;
  /** Sentence boundary delimiters (default: ['. ', '! ', '? ', '\n']) */
  delim?: string | string[];
  /** Where to attach the delimiter after splitting (default: 'prev') */
  includeDelim?: IncludeDelim;
}

/**
 * Splits text into chunks at sentence boundaries.
 *
 * Detects sentence boundaries using configurable delimiters, then groups
 * sentences into chunks that respect token size limits.
 */
export class SentenceChunker {
  public readonly chunkSize: number;
  public readonly chunkOverlap: number;
  public readonly minSentencesPerChunk: number;
  public readonly minCharactersPerSentence: number;
  public readonly delim: string[];
  public readonly includeDelim: IncludeDelim;
  private tokenizer: Tokenizer;

  private constructor(
    tokenizer: Tokenizer,
    chunkSize: number,
    chunkOverlap: number,
    minSentencesPerChunk: number,
    minCharactersPerSentence: number,
    delim: string[],
    includeDelim: IncludeDelim
  ) {
    if (chunkSize <= 0) {
      throw new Error('chunkSize must be greater than 0');
    }
    if (chunkOverlap < 0) {
      throw new Error('chunkOverlap must be non-negative');
    }
    if (chunkOverlap >= chunkSize) {
      throw new Error('chunkOverlap must be less than chunkSize');
    }
    if (minSentencesPerChunk < 1) {
      throw new Error('minSentencesPerChunk must be at least 1');
    }
    if (minCharactersPerSentence < 1) {
      throw new Error('minCharactersPerSentence must be at least 1');
    }

    this.tokenizer = tokenizer;
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.minSentencesPerChunk = minSentencesPerChunk;
    this.minCharactersPerSentence = minCharactersPerSentence;
    this.delim = delim;
    this.includeDelim = includeDelim;
  }

  /**
   * Create a SentenceChunker instance.
   *
   * @param options - Configuration options
   * @returns Promise resolving to SentenceChunker instance
   *
   * @example
   * const chunker = await SentenceChunker.create({ chunkSize: 512 });
   *
   * @example
   * const chunker = await SentenceChunker.create({
   *   tokenizer: 'gpt2',
   *   chunkSize: 512,
   *   chunkOverlap: 50
   * });
   */
  static async create(options: SentenceChunkerOptions = {}): Promise<SentenceChunker> {
    await initWasm();

    const {
      tokenizer = 'character',
      chunkSize = 2048,
      chunkOverlap = 0,
      minSentencesPerChunk = 1,
      minCharactersPerSentence = 12,
      delim = ['. ', '! ', '? ', '\n'],
      includeDelim = 'prev',
    } = options;

    const normalizedDelim = typeof delim === 'string' ? [delim] : delim;

    let tokenizerInstance: Tokenizer;
    if (typeof tokenizer === 'string') {
      tokenizerInstance = await Tokenizer.create(tokenizer);
    } else {
      tokenizerInstance = tokenizer;
    }

    return new SentenceChunker(
      tokenizerInstance,
      chunkSize,
      chunkOverlap,
      minSentencesPerChunk,
      minCharactersPerSentence,
      normalizedDelim,
      includeDelim
    );
  }

  /**
   * Split text into sentence segments using delimiters.
   * Uses WASM split_offsets for single-byte delimiters, JS-side splitting for multi-byte.
   */
  private splitText(text: string): string[] {
    const hasMultiByte = this.delim.some(d => d.length > 1);

    if (hasMultiByte) {
      return this.splitByPatterns(text);
    }

    // All single-byte delimiters: use WASM split_offsets
    const delimStr = this.delim.join('');
    const offsets = split_offsets(text, {
      delimiters: delimStr,
      includeDelim: this.includeDelim,
      minChars: this.minCharactersPerSentence,
    });

    return offsets.map(([start, end]) => text.slice(start, end)).filter(s => s.length > 0);
  }

  /**
   * Split text by multi-byte delimiter patterns.
   * Scans text for delimiter occurrences and splits accordingly.
   */
  private splitByPatterns(text: string): string[] {
    // Find all delimiter positions
    const delimPositions: { index: number; length: number }[] = [];
    for (const d of this.delim) {
      let pos = 0;
      while (pos < text.length) {
        const idx = text.indexOf(d, pos);
        if (idx === -1) break;
        delimPositions.push({ index: idx, length: d.length });
        pos = idx + d.length;
      }
    }

    if (delimPositions.length === 0) {
      return text.length > 0 ? [text] : [];
    }

    // Sort by position
    delimPositions.sort((a, b) => a.index - b.index);

    // Remove overlapping delimiters (keep earliest)
    const filtered: typeof delimPositions = [delimPositions[0]];
    for (let i = 1; i < delimPositions.length; i++) {
      const prev = filtered[filtered.length - 1];
      if (delimPositions[i].index >= prev.index + prev.length) {
        filtered.push(delimPositions[i]);
      }
    }

    // Build segments based on includeDelim
    const segments: string[] = [];
    let cursor = 0;

    for (const dp of filtered) {
      const delimEnd = dp.index + dp.length;

      if (this.includeDelim === 'prev') {
        // Delimiter attaches to end of previous segment
        const seg = text.slice(cursor, delimEnd);
        if (seg.length > 0) segments.push(seg);
        cursor = delimEnd;
      } else if (this.includeDelim === 'next') {
        // Delimiter attaches to start of next segment
        const seg = text.slice(cursor, dp.index);
        if (seg.length > 0) segments.push(seg);
        cursor = dp.index;
      } else {
        // Drop delimiter
        const seg = text.slice(cursor, dp.index);
        if (seg.length > 0) segments.push(seg);
        cursor = delimEnd;
      }
    }

    // Remaining text after last delimiter
    if (cursor < text.length) {
      const remaining = text.slice(cursor);
      if (remaining.length > 0) segments.push(remaining);
    }

    // Merge segments shorter than minCharactersPerSentence with adjacent
    return this.mergeShortSegments(segments);
  }

  /**
   * Merge segments that are shorter than minCharactersPerSentence
   * with the following segment.
   */
  private mergeShortSegments(segments: string[]): string[] {
    if (segments.length <= 1) return segments;

    const result: string[] = [];
    let buffer = '';

    for (const seg of segments) {
      buffer += seg;
      if (buffer.length >= this.minCharactersPerSentence) {
        result.push(buffer);
        buffer = '';
      }
    }

    // Attach leftover buffer to last result segment or push as-is
    if (buffer.length > 0) {
      if (result.length > 0) {
        result[result.length - 1] += buffer;
      } else {
        result.push(buffer);
      }
    }

    return result;
  }

  /**
   * Prepare sentence objects with position and token metadata.
   */
  private prepareSentences(text: string): Sentence[] {
    const sentenceTexts = this.splitText(text);
    if (sentenceTexts.length === 0) return [];

    const sentences: Sentence[] = [];
    let currentPos = 0;

    for (const sentText of sentenceTexts) {
      const startIndex = text.indexOf(sentText, currentPos);
      const tokenCount = this.tokenizer.countTokens(sentText);

      sentences.push({
        text: sentText,
        startIndex,
        endIndex: startIndex + sentText.length,
        tokenCount,
      });

      currentPos = startIndex + sentText.length;
    }

    return sentences;
  }

  /**
   * Create a chunk from a group of sentences.
   * Recounts tokens on joined text since tokenizers may differ on joined vs separate text.
   */
  private createChunk(sentences: Sentence[]): Chunk {
    const chunkText = sentences.map(s => s.text).join('');
    const tokenCount = this.tokenizer.countTokens(chunkText);

    return new Chunk({
      text: chunkText,
      startIndex: sentences[0].startIndex,
      endIndex: sentences[sentences.length - 1].endIndex,
      tokenCount,
    });
  }

  /**
   * Chunk text into sentence-aware chunks.
   *
   * @param text - The text to chunk
   * @returns Array of chunks
   */
  async chunk(text: string): Promise<Chunk[]> {
    if (!text || !text.trim()) {
      return [];
    }

    const sentences = this.prepareSentences(text);
    if (sentences.length === 0) {
      return [];
    }

    const chunks: Chunk[] = [];
    let pos = 0;

    while (pos < sentences.length) {
      // Use merge_splits to find the split point
      const remainingTokenCounts = sentences.slice(pos).map(s => s.tokenCount);
      const result = merge_splits(remainingTokenCounts, this.chunkSize);

      let splitIdx: number;
      if (result.indices.length > 0) {
        // First merge group ends at result.indices[0]
        splitIdx = pos + result.indices[0];
      } else {
        splitIdx = sentences.length;
      }

      // Enforce minimum sentences per chunk
      if (splitIdx - pos < this.minSentencesPerChunk) {
        if (pos + this.minSentencesPerChunk <= sentences.length) {
          splitIdx = pos + this.minSentencesPerChunk;
        } else {
          splitIdx = sentences.length;
        }
      }

      // Create the chunk
      const chunkSentences = sentences.slice(pos, splitIdx);
      chunks.push(this.createChunk(chunkSentences));

      // Handle overlap
      if (this.chunkOverlap > 0 && splitIdx < sentences.length) {
        let overlapTokens = 0;
        let overlapIdx = splitIdx - 1;

        while (overlapIdx > pos && overlapTokens < this.chunkOverlap) {
          const sent = sentences[overlapIdx];
          const nextTokens = overlapTokens + sent.tokenCount + 1; // +1 for space
          if (nextTokens > this.chunkOverlap) {
            break;
          }
          overlapTokens = nextTokens;
          overlapIdx--;
        }

        pos = overlapIdx + 1;
      } else {
        pos = splitIdx;
      }
    }

    return chunks;
  }

  toString(): string {
    return `SentenceChunker(chunkSize=${this.chunkSize}, overlap=${this.chunkOverlap}, delim=${JSON.stringify(this.delim)})`;
  }
}
