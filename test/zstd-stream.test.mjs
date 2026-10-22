import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, constants, zstdCompressSync } from "node:zlib";
import test from "node:test";
import { decompressZstdFrames } from "../bin/zstd-stream.mjs";

async function decode(buffer, chunkSize = buffer.length) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) chunks.push(buffer.subarray(i, i + chunkSize));
  const out = [];
  for await (const chunk of decompressZstdFrames(Readable.from(chunks))) out.push(chunk);
  return Buffer.concat(out);
}

test("Zstd framing handles split headers, checksums, skippable metadata and consecutive frames", async () => {
  const plain = Buffer.from("中文😀".repeat(50_000));
  const first = zstdCompressSync(plain.subarray(0, 100_001), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const second = zstdCompressSync(plain.subarray(100_001));
  const metadata = Buffer.alloc(8 + 13);
  metadata.writeUInt32LE(0x184d2a50);
  metadata.writeUInt32LE(13, 4);
  const joined = Buffer.concat([metadata, first, metadata, second, metadata]);
  assert.deepEqual(await decode(joined, 1), plain);
});

test("every truncated suffix fails even when a native decoder would accept the prefix", async () => {
  const encoded = zstdCompressSync("a complete frame", { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  for (let length = 1; length < encoded.length; length++) {
    await assert.rejects(decode(encoded.subarray(0, length), 2));
  }
  const corrupted = Buffer.from(encoded);
  corrupted[corrupted.length - 1] ^= 0xff;
  await assert.rejects(decode(corrupted));
  await assert.rejects(decode(Buffer.concat([encoded, Buffer.from("trailing garbage")])));
});

test("stream-produced frames without a declared content size decode multiple blocks", async () => {
  const input = Buffer.from("stream content \n".repeat(40_000));
  const parts = [];
  await pipeline(Readable.from([input.subarray(0, 100_000), input.subarray(100_000)]), createZstdCompress(), async (chunks) => {
    for await (const chunk of chunks) parts.push(chunk);
  });
  assert.deepEqual(await decode(Buffer.concat(parts), 3), input);
});

test("raw and RLE blocks respect their different encoded lengths", async () => {
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5]);
  const raw = Buffer.concat([header, Buffer.from([41, 0, 0]), Buffer.from("hello")]);
  const rle = Buffer.concat([header, Buffer.from([43, 0, 0, 65])]);
  assert.equal((await decode(Buffer.concat([raw, rle]), 2)).toString(), "helloAAAAA");
  await assert.rejects(decode(Buffer.concat([header, Buffer.from([47, 0, 0, 65])])), /block/);
});

test("aborting a native frame closes the input iterator and rejects the scan", async () => {
  const controller = new AbortController();
  const encoded = zstdCompressSync("large frame\n".repeat(100_000));
  const source = Readable.from([encoded]);
  await assert.rejects(async () => {
    for await (const _ of decompressZstdFrames(source, { signal: controller.signal })) controller.abort();
  }, { name: "AbortError" });
  assert.equal(source.destroyed, true);
});
