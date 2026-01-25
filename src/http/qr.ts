type QrEccLevel = "M";

type RsBlockGroup = Readonly<{
  blocks: number;
  dataCodewordsPerBlock: number;
}>;

type VersionEcParams = Readonly<{
  version: number;
  eccLevel: QrEccLevel;
  dataCodewords: number;
  ecCodewordsPerBlock: number;
  group1: RsBlockGroup;
  group2?: RsBlockGroup;
}>;

// Source values are standard QR tables (Model 2), ECC level M, versions 1..10.
// Kept intentionally small: subscription URLs should fit comfortably within v10-M.
const VERSION_M_TABLE: Readonly<Record<number, VersionEcParams>> = {
  1: { version: 1, eccLevel: "M", dataCodewords: 16, ecCodewordsPerBlock: 10, group1: { blocks: 1, dataCodewordsPerBlock: 16 } },
  2: { version: 2, eccLevel: "M", dataCodewords: 28, ecCodewordsPerBlock: 16, group1: { blocks: 1, dataCodewordsPerBlock: 28 } },
  3: { version: 3, eccLevel: "M", dataCodewords: 44, ecCodewordsPerBlock: 26, group1: { blocks: 1, dataCodewordsPerBlock: 44 } },
  4: { version: 4, eccLevel: "M", dataCodewords: 64, ecCodewordsPerBlock: 18, group1: { blocks: 2, dataCodewordsPerBlock: 32 } },
  5: { version: 5, eccLevel: "M", dataCodewords: 86, ecCodewordsPerBlock: 24, group1: { blocks: 2, dataCodewordsPerBlock: 43 } },
  6: { version: 6, eccLevel: "M", dataCodewords: 108, ecCodewordsPerBlock: 16, group1: { blocks: 4, dataCodewordsPerBlock: 27 } },
  7: { version: 7, eccLevel: "M", dataCodewords: 124, ecCodewordsPerBlock: 18, group1: { blocks: 4, dataCodewordsPerBlock: 31 } },
  8: {
    version: 8,
    eccLevel: "M",
    dataCodewords: 154,
    ecCodewordsPerBlock: 22,
    group1: { blocks: 2, dataCodewordsPerBlock: 38 },
    group2: { blocks: 2, dataCodewordsPerBlock: 39 },
  },
  9: {
    version: 9,
    eccLevel: "M",
    dataCodewords: 182,
    ecCodewordsPerBlock: 22,
    group1: { blocks: 3, dataCodewordsPerBlock: 36 },
    group2: { blocks: 2, dataCodewordsPerBlock: 37 },
  },
  10: {
    version: 10,
    eccLevel: "M",
    dataCodewords: 216,
    ecCodewordsPerBlock: 26,
    group1: { blocks: 4, dataCodewordsPerBlock: 43 },
    group2: { blocks: 1, dataCodewordsPerBlock: 44 },
  },
} as const;

// Alignment pattern center coordinates per version.
const ALIGNMENT_POSITIONS: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
} as const;

// Version information strings (18 bits) for versions 7..10.
const VERSION_INFO_BITS: Readonly<Record<number, string>> = {
  7: "000111110010010100",
  8: "001000010110111100",
  9: "001001101010011001",
  10: "001010010011010011",
} as const;

// We intentionally use mask pattern 0, ECC level M.
// This is the final *masked* 15-bit format information string for (M, mask 0).
const FORMAT_INFO_M_MASK0 = "101010000010010";

type QrMatrix = Readonly<{
  size: number;
  modules: ReadonlyArray<ReadonlyArray<0 | 1>>;
}>;

function qrSize(version: number): number {
  return 17 + 4 * version;
}

function create2d<T>(size: number, init: T): T[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => init));
}

function bitStringToBitAtLsbIndex(bitStringMsbToLsb: string, bitIndexLsb: number): 0 | 1 {
  const i = bitStringMsbToLsb.length - 1 - bitIndexLsb;
  return (bitStringMsbToLsb[i] === "1" ? 1 : 0) as 0 | 1;
}

class BitBuffer {
  private bits: number[] = [];

  push(value: number, bitCount: number): void {
    for (let i = bitCount - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0);
      bytes.push(b & 0xff);
    }
    return bytes;
  }
}

// GF(256) with primitive polynomial 0x11d.
const GF_EXP: number[] = [];
const GF_LOG: number[] = [];
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]!;
}

function polyMul(p: readonly number[], q: readonly number[]): number[] {
  const out = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) out[i + j] ^= gfMul(p[i]!, q[j]!);
  }
  return out;
}

function rsGeneratorPoly(ecCodewords: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < ecCodewords; i++) {
    poly = polyMul(poly, [1, GF_EXP[i]!]);
  }
  return poly;
}

function rsComputeEcBytes(data: readonly number[], ecCodewords: number): number[] {
  const gen = rsGeneratorPoly(ecCodewords);
  const genTail = gen.slice(1); // remove leading 1
  const ecc = new Array(ecCodewords).fill(0);

  for (const byte of data) {
    const factor = byte ^ ecc[0]!;
    ecc.shift();
    ecc.push(0);
    if (factor === 0) continue;
    for (let i = 0; i < ecCodewords; i++) ecc[i] = (ecc[i]! ^ gfMul(genTail[i]!, factor)) & 0xff;
  }
  return ecc;
}

function chooseVersionForByteLength(byteLen: number): VersionEcParams {
  for (let v = 1 as keyof typeof VERSION_M_TABLE; v <= 10; v++) {
    const params = VERSION_M_TABLE[v]!;
    const lengthBits = v <= 9 ? 8 : 16;
    const requiredBits = 4 + lengthBits + byteLen * 8;
    const capacityBits = params.dataCodewords * 8;
    if (requiredBits <= capacityBits) return params;
  }
  throw new Error(`QR payload too large for v10-M (bytes=${byteLen})`);
}

function buildDataCodewordsByteMode(payload: Buffer, params: VersionEcParams): number[] {
  const lengthBits = params.version <= 9 ? 8 : 16;
  const capacityBits = params.dataCodewords * 8;

  const bits = new BitBuffer();
  bits.push(0b0100, 4); // byte mode
  bits.push(payload.length, lengthBits);
  for (const b of payload) bits.push(b, 8);

  // Terminator: up to 4 zeros, but never exceed capacity.
  const remaining = capacityBits - bits.length;
  bits.push(0, Math.min(4, Math.max(0, remaining)));

  // Pad to byte boundary.
  const mod8 = bits.length % 8;
  if (mod8 !== 0) bits.push(0, 8 - mod8);

  const bytes = bits.toBytes();
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bytes.length < params.dataCodewords) {
    bytes.push(padBytes[padIdx % 2]!);
    padIdx++;
  }
  return bytes;
}

function buildFinalMessageCodewords(dataCodewords: readonly number[], params: VersionEcParams): number[] {
  const blocks: number[][] = [];

  let offset = 0;
  for (let i = 0; i < params.group1.blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + params.group1.dataCodewordsPerBlock));
    offset += params.group1.dataCodewordsPerBlock;
  }
  if (params.group2) {
    for (let i = 0; i < params.group2.blocks; i++) {
      blocks.push(dataCodewords.slice(offset, offset + params.group2.dataCodewordsPerBlock));
      offset += params.group2.dataCodewordsPerBlock;
    }
  }
  if (offset !== dataCodewords.length) throw new Error("Internal QR error: data codeword split mismatch");

  const eccBlocks = blocks.map((b) => rsComputeEcBytes(b, params.ecCodewordsPerBlock));

  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  const out: number[] = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < params.ecCodewordsPerBlock; i++) {
    for (const ecc of eccBlocks) out.push(ecc[i]!);
  }
  return out;
}

function mask0(x: number, y: number): boolean {
  return (x + y) % 2 === 0;
}

function buildQrMatrix(payloadText: string): QrMatrix {
  const payload = Buffer.from(payloadText, "utf8");
  const params = chooseVersionForByteLength(payload.length);
  const size = qrSize(params.version);

  const modules = create2d<0 | 1>(size, 0);
  const reserved = create2d<boolean>(size, false);

  const set = (x: number, y: number, value: 0 | 1, reserve = true): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = value;
    if (reserve) reserved[y]![x] = true;
  };

  const placeFinder = (x0: number, y0: number): void => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const xx = x0 + x;
        const yy = y0 + y;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const isSeparator = x === -1 || y === -1 || x === 7 || y === 7;
        if (isSeparator) {
          set(xx, yy, 0, true);
          continue;
        }
        const isBorder = x === 0 || y === 0 || x === 6 || y === 6;
        const isCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        set(xx, yy, (isBorder || isCenter ? 1 : 0) as 0 | 1, true);
      }
    }
  };

  const placeAlignment = (cx: number, cy: number): void => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const v = (dist === 2 || dist === 0 ? 1 : 0) as 0 | 1;
        set(cx + dx, cy + dy, v, true);
      }
    }
  };

  // Finders + separators.
  placeFinder(0, 0);
  placeFinder(size - 7, 0);
  placeFinder(0, size - 7);

  // Timing patterns.
  for (let x = 8; x <= size - 9; x++) set(x, 6, (x % 2 === 0 ? 1 : 0) as 0 | 1, true);
  for (let y = 8; y <= size - 9; y++) set(6, y, (y % 2 === 0 ? 1 : 0) as 0 | 1, true);

  // Alignment patterns.
  const positions = ALIGNMENT_POSITIONS[params.version];
  if (!positions) throw new Error(`Unsupported QR version: ${params.version}`);
  for (const x of positions) {
    for (const y of positions) {
      const overlapsFinder =
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6);
      if (overlapsFinder) continue;
      placeAlignment(x, y);
    }
  }

  // Dark module.
  set(8, 4 * params.version + 9, 1, true);

  // Reserve format info areas (we'll write actual bits later).
  for (let x = 0; x <= 8; x++) reserved[8]![x] = true;
  for (let y = 0; y <= 8; y++) reserved[y]![8] = true;
  for (let x = size - 8; x < size; x++) reserved[8]![x] = true;
  for (let y = size - 8; y < size; y++) reserved[y]![8] = true;
  reserved[6]![8] = true;
  reserved[8]![6] = true;

  // Reserve version info areas for v7+.
  if (params.version >= 7) {
    for (let y = 0; y < 6; y++) for (let x = size - 11; x < size - 8; x++) reserved[y]![x] = true;
    for (let y = size - 11; y < size - 8; y++) for (let x = 0; x < 6; x++) reserved[y]![x] = true;
  }

  // Encode payload into codewords and fill data modules.
  const dataCodewords = buildDataCodewordsByteMode(payload, params);
  const codewords = buildFinalMessageCodewords(dataCodewords, params);
  const bitStream: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bitStream.push((cw >>> i) & 1);
  }

  let bitIdx = 0;
  let dir: -1 | 1 = -1;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x--; // skip vertical timing column
    for (let i = 0; i < size; i++) {
      const y = dir === -1 ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const xx = x - dx;
        if (reserved[y]![xx]) continue;
        const rawBit = (bitStream[bitIdx] ?? 0) & 1;
        bitIdx++;
        const masked = (rawBit ^ (mask0(xx, y) ? 1 : 0)) as 0 | 1;
        set(xx, y, masked, false);
      }
    }
    dir = (dir === -1 ? 1 : -1) as -1 | 1;
  }

  // Format info bits (masked string, MSB->LSB).
  const f = FORMAT_INFO_M_MASK0;
  const fBit = (i: number): 0 | 1 => (f[i] === "1" ? 1 : 0);

  // Top-left around finders.
  for (let i = 0; i <= 5; i++) set(i, 8, fBit(i), true);
  set(7, 8, fBit(6), true);
  set(8, 8, fBit(7), true);
  set(8, 7, fBit(8), true);
  set(8, 5, fBit(9), true);
  set(8, 4, fBit(10), true);
  set(8, 3, fBit(11), true);
  set(8, 2, fBit(12), true);
  set(8, 1, fBit(13), true);
  set(8, 0, fBit(14), true);

  // Bottom-left + top-right copies.
  for (let i = 0; i <= 6; i++) set(8, size - 1 - i, fBit(i), true); // bits 0..6
  for (let i = 7; i <= 14; i++) set(size - 15 + i, 8, fBit(i), true); // bits 7..14

  // Version info bits for v7+.
  if (params.version >= 7) {
    const vStr = VERSION_INFO_BITS[params.version];
    if (!vStr) throw new Error(`Missing version info bits for v${params.version}`);

    const vBit = (bitIndexLsb: number): 0 | 1 => bitStringToBitAtLsbIndex(vStr, bitIndexLsb);

    // Bottom-left block (3 rows x 6 cols), above bottom-left finder.
    // Bit indices layout (LSB=0, MSB=17):
    // 00 03 06 09 12 15
    // 01 04 07 10 13 16
    // 02 05 08 11 14 17
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const bitIndexLsb = row + col * 3;
        set(col, size - 11 + row, vBit(bitIndexLsb), true);
      }
    }

    // Top-right block (6 rows x 3 cols), left of top-right finder.
    // 00 01 02
    // 03 04 05
    // ...
    // 15 16 17
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 3; col++) {
        const bitIndexLsb = row * 3 + col;
        set(size - 11 + col, row, vBit(bitIndexLsb), true);
      }
    }
  }

  return { size, modules };
}

export function qrSvg(payloadText: string, opts?: Readonly<{ pixels?: number }>): string {
  const { size, modules } = buildQrMatrix(payloadText);
  const quiet = 4;
  const vbSize = size + quiet * 2;
  const pixels = Math.max(120, Math.min(512, Math.floor(opts?.pixels ?? 256)));

  let rects = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]![x] === 1) rects += `<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${vbSize} ${vbSize}" shape-rendering="crispEdges" aria-label="QR code">`,
    `<rect width="${vbSize}" height="${vbSize}" fill="#ffffff"/>`,
    `<g fill="#000000">`,
    rects,
    `</g>`,
    `</svg>`,
  ].join("");
}

