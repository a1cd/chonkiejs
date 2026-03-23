/// <reference types="vitest/globals" />
import { CodeChunker } from '../src';
import type { Parser as TreeSitterParser } from 'web-tree-sitter';

interface FakeNode {
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  children: FakeNode[];
}

function makeNode(text: string, startIndex: number, children: FakeNode[] = []): FakeNode {
  const endIndex = startIndex + new TextEncoder().encode(text).length;
  return { text, startIndex, endIndex, childCount: children.length, children };
}

// Build a fake Parser given a root node
function makeFakeParser(rootNode: any): TreeSitterParser {
  return {
    parse: (_: string) => ({
      rootNode,
      delete: () => {},
    }),
    setLanguage: () => {},
    language: null,
  } as unknown as TreeSitterParser;
}

describe('CodeChunker', () => {
  describe('Creation', () => {
    it('should create a chunker with a pre-configured parser', async () => {
      const root = makeNode('const x = 1;', 0);
      const parser = makeFakeParser(root);

      const chunker = await CodeChunker.create({ parser, chunkSize: 512 });
      expect(chunker).toBeInstanceOf(CodeChunker);
      expect(chunker.chunkSize).toBe(512);
      expect(chunker.language).toBe('parser');
    });

    it('should use default chunkSize of 2048', async () => {
      const root = makeNode('', 0);
      const parser = makeFakeParser(root);

      const chunker = await CodeChunker.create({ parser });
      expect(chunker.chunkSize).toBe(2048);
    });

    it('should reject language "auto" with a clear error', async () => {
      await expect(CodeChunker.create({ language: 'auto' })).rejects.toThrow(/not supported in JavaScript/);
    });

    it('should throw when neither parser nor language is provided', async () => {
      await expect(CodeChunker.create({})).rejects.toThrow(/requires `language`/);
    });

    it('should create a chunker with a tree-sitter-wasms language id', async () => {
      const chunker = await CodeChunker.create({ language: 'javascript', chunkSize: 100 });
      expect(chunker).toBeInstanceOf(CodeChunker);
      expect(chunker.language).toBe('javascript');
      const chunks = chunker.chunk('const x = 1;\nconst y = 2;\n');
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should reject unknown language ids when tree-sitter-wasms has no matching wasm', async () => {
      await expect(CodeChunker.create({ language: 'zzznonexistentlang999' })).rejects.toThrow(
        /unknown language/
      );
    });

    it('should reject non-wasm specifiers that are not valid tree-sitter-wasms ids', async () => {
      await expect(CodeChunker.create({ language: 'foo bar' })).rejects.toThrow(/unknown language/);
    });

    it('should throw for invalid chunkSize', async () => {
      const root = makeNode('', 0);
      const parser = makeFakeParser(root);

      await expect(CodeChunker.create({ parser, chunkSize: 0 })).rejects.toThrow(
        'chunkSize must be greater than 0'
      );
      await expect(CodeChunker.create({ parser, chunkSize: -1 })).rejects.toThrow(
        'chunkSize must be greater than 0'
      );
    });
  });

  describe('Chunking', () => {
    it('should return empty array for empty text', async () => {
      const root = makeNode('', 0);
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 512 });

      expect(chunker.chunk('')).toHaveLength(0);
      expect(chunker.chunk('   ')).toHaveLength(0);
    });

    it('should produce a single chunk for small code', async () => {
      const code = 'const x = 1;';
      const child = makeNode(code, 0);
      const root = makeNode(code, 0, [child]);
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 512 });

      const chunks = chunker.chunk(code);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text.trim()).toBeTruthy();
    });

    it('should split large code into multiple chunks', async () => {
      // Build a root with many children, each ~20 chars
      const lines = Array.from({ length: 20 }, (_, i) =>
        `const var${i} = ${i + 100};`
      );
      const code = lines.join('\n');

      let byteOffset = 0;
      const encoder = new TextEncoder();
      const children = lines.map(line => {
        const node = makeNode(line, byteOffset);
        byteOffset += encoder.encode(line + '\n').length;
        return node;
      });

      const root = makeNode(code, 0, children);
      // chunkSize=30 chars → forces multiple chunks
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 30 });

      const chunks = chunker.chunk(code);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should maintain correct startIndex and endIndex', async () => {
      const code = 'function foo() {}\nfunction bar() {}\n';
      const encoder = new TextEncoder();

      const child1 = makeNode('function foo() {}', 0);
      const child2 = makeNode('function bar() {}', encoder.encode('function foo() {}\n').length);
      const root = makeNode(code, 0, [child1, child2]);

      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 512 });
      const chunks = chunker.chunk(code);

      for (const chunk of chunks) {
        expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
        expect(chunk.endIndex).toBeGreaterThanOrEqual(chunk.startIndex);
      }
    });

    it('should preserve full text across all chunks', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `x${i} = ${i};`);
      const code = lines.join('\n');

      let byteOffset = 0;
      const encoder = new TextEncoder();
      const children = lines.map(line => {
        const node = makeNode(line, byteOffset);
        byteOffset += encoder.encode(line + '\n').length;
        return node;
      });

      const root = makeNode(code, 0, children);
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 20 });

      const chunks = chunker.chunk(code);
      const reconstructed = chunks.map(c => c.text).join('');
      expect(reconstructed).toBe(code);
    });

    it('should handle root with a single child covering the full range', async () => {
      const code = 'x = 1';
      // Realistic: root node wraps a single expression child
      const child = makeNode(code, 0);
      const root = makeNode(code, 0, [child]);
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 512 });

      const chunks = chunker.chunk(code);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(code);
    });

    it('should recursively split oversized children', async () => {
      // A child whose token count exceeds chunkSize (chunkSize=5, child has >5 chars)
      const bigChildText = 'abcdefghij'; // 10 chars > chunkSize=5
      const encoder = new TextEncoder();
      const grandchildren = Array.from({ length: 5 }, (_, i) => {
        const t = 'ab';
        return makeNode(t, encoder.encode(bigChildText.slice(0, i * 2)).length);
      });
      const bigChild = makeNode(bigChildText, 0, grandchildren);
      const root = makeNode(bigChildText, 0, [bigChild]);

      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 5 });
      const chunks = chunker.chunk(bigChildText);

      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('Chunk Properties', () => {
    it('should have correct chunk shape', async () => {
      const code = 'const a = 1;\nconst b = 2;\n';
      const encoder = new TextEncoder();
      const c1 = makeNode('const a = 1;', 0);
      const c2 = makeNode('const b = 2;', encoder.encode('const a = 1;\n').length);
      const root = makeNode(code, 0, [c1, c2]);

      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 512 });
      const chunks = chunker.chunk(code);

      for (const chunk of chunks) {
        expect(chunk).toHaveProperty('text');
        expect(chunk).toHaveProperty('startIndex');
        expect(chunk).toHaveProperty('endIndex');
        expect(chunk).toHaveProperty('tokenCount');
        expect(typeof chunk.text).toBe('string');
        expect(typeof chunk.startIndex).toBe('number');
        expect(typeof chunk.endIndex).toBe('number');
        expect(typeof chunk.tokenCount).toBe('number');
        expect(chunk.tokenCount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('toString', () => {
    it('should return readable string representation', async () => {
      const root = makeNode('', 0);
      const chunker = await CodeChunker.create({ parser: makeFakeParser(root), chunkSize: 256 });
      const str = chunker.toString();
      expect(str).toContain('CodeChunker');
      expect(str).toContain('256');
    });
  });
});
