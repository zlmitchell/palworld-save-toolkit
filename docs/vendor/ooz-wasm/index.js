import oozFactory from './build/ooz.js';

const OOZ_SAFE_SPACE = 64;

const oozInst = await oozFactory();
let lastDecompressionPtr_ = 0;

/**
 * @param {Uint8Array} data
 * @param {number} rawSize
 * @returns {Uint8Array}
 */
export function decompressUnsafe (data, rawSize) {
  if (lastDecompressionPtr_) {
    oozInst._free(lastDecompressionPtr_);
    lastDecompressionPtr_ = 0;
  }

  const compressedPtr = oozInst._malloc(data.byteLength);
  oozInst.HEAPU8.set(data, compressedPtr);

  const decompressedPtr = oozInst._malloc(rawSize + OOZ_SAFE_SPACE);
  lastDecompressionPtr_ = decompressedPtr;

  const res = oozInst._Kraken_Decompress(
    compressedPtr, data.byteLength,
    decompressedPtr, rawSize
  );

  oozInst._free(compressedPtr);

  if (res < 0) {
    throw new Error('Failed to decode');
  }
  if (res !== rawSize) {
    throw new Error('Decompresed size is different from expected');
  }

  return oozInst.HEAPU8.subarray(decompressedPtr, decompressedPtr + rawSize);
}

/**
 * @param {Uint8Array} data
 * @param {number} rawSize
 * @returns {Uint8Array}
 */
export function decompress (data, rawSize) {
  const decompressed = decompressUnsafe(data, rawSize);
  const decompressedCopy = new Uint8Array(decompressed.byteLength);
  decompressedCopy.set(decompressed);
  return decompressedCopy;
}
