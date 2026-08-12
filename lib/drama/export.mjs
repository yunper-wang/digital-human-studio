// lib/drama/export.mjs
// 成片导出：元数据派生 + ZIP store 模式打包（零依赖手写）
import { writeFileSync } from "node:fs";

export function buildMeta(project) {
  return {
    title: String(project.title || "未命名"),
    synopsis: project.analysis?.synopsis || "",
    genre: project.analysis?.genre || "",
    characters: (project.analysis?.characters || []).map((c) => ({ name: c.name, role: c.role })),
    shotCount: (project.shots || []).length,
    totalDurationSec: (project.shots || []).reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0),
    ratio: project.ratio || "portrait",
    createdAt: project.createdAt || new Date().toISOString(),
    exportedAt: new Date().toISOString()
  };
}

// CRC32 表（运行期生成一次）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 手写 ZIP store 模式（不压缩，mp4/srt 已压缩）；返回 Buffer
export function buildZipBuffer(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // compression: store
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0, 12);          // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);       // compressed size
    local.writeUInt32LE(size, 22);       // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    chunks.push(local, name, f.bytes);
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0); // central dir entry signature
    ce.writeUInt16LE(20, 4);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(0, 10);
    ce.writeUInt16LE(0, 12);
    ce.writeUInt16LE(0, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(size, 20);
    ce.writeUInt32LE(size, 24);
    ce.writeUInt16LE(name.length, 28);
    ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34);
    ce.writeUInt32LE(0, 36);
    ce.writeUInt32LE(offset, 42); // local header offset
    central.push(ce, name);
    offset += local.length + name.length + f.bytes.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir record
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}
