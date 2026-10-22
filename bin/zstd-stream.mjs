import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

// Node 22/24's Zstd stream can stop at the first frame and accept truncated
// input. Frame each native decoder explicitly and require every encoded byte.
// Only framing is handled here; decompression/checksums remain native.
// Format: https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
export async function* decompressZstdFrames(source, { signal } = {}) {
  const reader = new ChunkReader(source, signal);
  try {
    while (true) {
      const magic = await reader.exact(4, true);
      if (!magic) return;
      const value = magic.readUInt32LE();
      if (value >= 0x184d2a50 && value <= 0x184d2a5f) {
        // Skippable frames carry metadata, not JSONL content.
        const length = (await reader.exact(4)).readUInt32LE();
        for await (const _ of reader.parts(length)) { /* discard bounded chunks */ }
        continue;
      }
      if (value !== 0xfd2fb528) throw invalid("Invalid Zstd frame magic");
      const descriptor = await reader.exact(1);
      const flags = descriptor[0];
      if (flags & 8) throw invalid("Reserved Zstd frame flag");
      const singleSegment = Boolean(flags & 32);
      const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][flags >>> 6];
      const header = await reader.exact((singleSegment ? 0 : 1) + [0, 1, 2, 4][flags & 3] + sizeBytes);
      let expectedSize = null;
      if (sizeBytes) {
        const offset = header.length - sizeBytes;
        expectedSize = sizeBytes === 8 ? header.readBigUInt64LE(offset) : BigInt(header.readUIntLE(offset, sizeBytes));
        if (sizeBytes === 2) expectedSize += 256n;
      }
      async function* frame() {
        yield Buffer.concat([magic, descriptor, header]);
        let last = false;
        while (!last) {
          const block = await reader.exact(3);
          const bits = block.readUIntLE(0, 3);
          last = Boolean(bits & 1);
          const type = (bits >>> 1) & 3;
          const length = bits >>> 3;
          if (type === 3 || length > 128 * 1024) throw invalid("Invalid Zstd block header");
          yield block;
          yield* reader.parts(type === 1 ? 1 : length);
        }
        if (flags & 4) yield await reader.exact(4);
      }
      const decoder = createZstdDecompress({ chunkSize: 64 * 1024 });
      const job = pipeline(Readable.from(frame()), decoder, { signal });
      job.catch(() => {});
      let decoded = 0n;
      try {
        for await (const chunk of decoder) {
          decoded += BigInt(chunk.length);
          yield chunk;
        }
        await job;
        if (expectedSize !== null && decoded !== expectedSize) throw invalid("Zstd content size mismatch");
      } finally {
        decoder.destroy();
        await job.catch(() => {});
      }
    }
  } finally {
    await reader.close();
  }
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_ZSTD" });
}

class ChunkReader {
  constructor(source, signal) {
    this.iterator = source[Symbol.asyncIterator]();
    this.signal = signal;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
  }
  async piece(length) {
    this.signal?.throwIfAborted();
    while (this.offset === this.buffer.length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.buffer = next.value;
      this.offset = 0;
    }
    const end = Math.min(this.offset + length, this.buffer.length);
    const part = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return part;
  }
  async exact(length, allowEof = false) {
    const parts = [];
    let remaining = length;
    while (remaining) {
      const part = await this.piece(remaining);
      if (!part) {
        if (allowEof && remaining === length) return null;
        throw invalid("Unexpected end of Zstd frame");
      }
      parts.push(part);
      remaining -= part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }
  async *parts(length) {
    let remaining = length;
    while (remaining) {
      const part = await this.piece(Math.min(remaining, 64 * 1024));
      if (!part) throw invalid("Unexpected end of Zstd block");
      remaining -= part.length;
      yield part;
    }
  }
  async close() { await this.iterator.return?.(); }
}
