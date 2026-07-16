// Palworld .sav container codec.
// Read: PlZ (zlib, pre-2026 saves) and PlM (Oodle Kraken, 2026 "1.0" saves).
// Write: always PlZ — the game and dedicated server accept zlib saves.
// Port of palworld-save-tools palsav.py + the PlM handling from
// quadrantbs/palworld-hostfix-toolkit (reviewed).

async function pipeThrough(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const inflate = (data) => pipeThrough(data, new DecompressionStream("deflate"));
const deflate = (data) => pipeThrough(data, new CompressionStream("deflate"));

/**
 * @param {Uint8Array} data - raw .sav file bytes
 * @param {(data: Uint8Array, rawSize: number) => Uint8Array} oozDecompress
 * @returns {Promise<{gvas: Uint8Array, saveType: number, magic: string}>}
 */
export async function decompressSav(data, oozDecompress) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let uncompressedLen = view.getUint32(0, true);
  let compressedLen = view.getUint32(4, true);
  let magic = String.fromCharCode(data[8], data[9], data[10]);
  let saveType = data[11];
  let start = 12;
  if (magic === "CNK") {
    uncompressedLen = view.getUint32(12, true);
    compressedLen = view.getUint32(16, true);
    magic = String.fromCharCode(data[20], data[21], data[22]);
    saveType = data[23];
    start = 24;
  }

  if (magic === "PlM") {
    const compressed = data.subarray(start);
    if (compressedLen !== compressed.byteLength) {
      throw new Error(`incorrect compressed length: ${compressedLen}`);
    }
    const gvas = oozDecompress(compressed, uncompressedLen);
    if (gvas.byteLength !== uncompressedLen) {
      throw new Error(`incorrect uncompressed length: ${gvas.byteLength}`);
    }
    return { gvas, saveType, magic };
  }

  if (magic !== "PlZ") {
    throw new Error(`not a Palworld save: magic ${JSON.stringify(magic)}`);
  }
  if (saveType !== 0x31 && saveType !== 0x32) {
    throw new Error(`unhandled save type: 0x${saveType.toString(16)}`);
  }
  if (saveType === 0x31 && compressedLen !== data.byteLength - start) {
    throw new Error(`incorrect compressed length: ${compressedLen}`);
  }
  let gvas = await inflate(data.subarray(start));
  if (saveType === 0x32) {
    if (compressedLen !== gvas.byteLength) {
      throw new Error(`incorrect compressed length: ${compressedLen}`);
    }
    gvas = await inflate(gvas);
  }
  if (gvas.byteLength !== uncompressedLen) {
    throw new Error(`incorrect uncompressed length: ${gvas.byteLength}`);
  }
  return { gvas, saveType, magic };
}

/**
 * @param {Uint8Array} gvas
 * @param {number} saveType - 0x31 or 0x32
 * @returns {Promise<Uint8Array>} .sav file bytes (PlZ container)
 */
export async function compressSav(gvas, saveType) {
  let compressed = await deflate(gvas);
  const compressedLen = compressed.byteLength;
  if (saveType === 0x32) compressed = await deflate(compressed);
  const out = new Uint8Array(12 + compressed.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, gvas.byteLength, true);
  view.setUint32(4, compressedLen, true);
  out[8] = 0x50; out[9] = 0x6c; out[10] = 0x5a; // "PlZ"
  out[11] = saveType;
  out.set(compressed, 12);
  return out;
}
