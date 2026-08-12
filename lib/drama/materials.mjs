// lib/drama/materials.mjs
// 素材库：用户上传的图片/音频/视频；data/materials/ 文件本体 + index.json 元数据索引
// 上传走 base64 data-URL → 魔数校验 + 大小限；索引损坏自愈为空（文件保留可重新登记）
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const MATERIAL_KINDS = ["image", "audio", "video"];
export const MATERIAL_LIMITS = { image: 8 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 50 * 1024 * 1024 };

// data-URL MIME → { kind, ext }
const MIME_MAP = {
  "image/png": { kind: "image", ext: "png" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/webp": { kind: "image", ext: "webp" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/wav": { kind: "audio", ext: "wav" },
  "audio/mp4": { kind: "audio", ext: "m4a" },
  "audio/x-m4a": { kind: "audio", ext: "m4a" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" }
};

// 魔数校验：声明格式与文件内容必须一致（m4a/mp4 同为 ftyp 家族，以声明 kind 为准）
function sniffOk(bytes, ext) {
  if (ext === "png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === "jpg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (ext === "webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (ext === "mp3") return bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (ext === "wav") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
  if (ext === "m4a" || ext === "mp4") return bytes.subarray(4, 8).toString() === "ftyp";
  if (ext === "webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

export function createMaterialStore(dataRoot) {
  const root = join(dataRoot, "materials");
  mkdirSync(root, { recursive: true });
  const indexFile = join(root, "index.json");

  function loadIndex() {
    try {
      const raw = JSON.parse(readFileSync(indexFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; } // 索引损坏/不存在 → 空索引（文件仍在盘上，可重新登记）
  }
  function saveIndex(items) { writeFileSync(indexFile, JSON.stringify(items, null, 2)); }

  function normalizeMaterial(raw = {}) {
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `mat-${randomUUID()}`,
      name: String(raw.name || "未命名素材").slice(0, 60),
      kind: MATERIAL_KINDS.includes(raw.kind) ? raw.kind : "image",
      file: String(raw.file || ""),
      size: Number.isInteger(raw.size) && raw.size >= 0 ? raw.size : 0,
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : [],
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  }

  function register({ name, dataUrl } = {}) {
    const match = String(dataUrl || "").match(/^data:([a-z0-9/+.=-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw Object.assign(new Error("仅支持 base64 data-URL 上传（MATERIAL_FORMAT_INVALID）"), { code: "MATERIAL_FORMAT_INVALID" });
    const mapped = MIME_MAP[match[1].toLowerCase()];
    if (!mapped) throw Object.assign(new Error("仅支持 png/jpg/webp 图片、mp3/wav/m4a 音频、mp4/webm 视频（MATERIAL_FORMAT_INVALID）"), { code: "MATERIAL_FORMAT_INVALID" });
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MATERIAL_LIMITS[mapped.kind]) {
      throw Object.assign(new Error(`素材超过大小限制（${mapped.kind} ≤ ${MATERIAL_LIMITS[mapped.kind] / 1024 / 1024}MB）（MATERIAL_TOO_LARGE）`), { code: "MATERIAL_TOO_LARGE" });
    }
    if (!sniffOk(bytes, mapped.ext)) throw Object.assign(new Error("文件内容与格式不一致（MATERIAL_BYTES_INVALID）"), { code: "MATERIAL_BYTES_INVALID" });
    const material = normalizeMaterial({
      name: String(name || "").trim() || "未命名素材",
      kind: mapped.kind,
      file: `mat-${randomUUID()}.${mapped.ext}`,
      size: bytes.length,
      createdAt: new Date().toISOString()
    });
    writeFileSync(join(root, material.file), bytes);
    const items = loadIndex();
    items.unshift(material);
    saveIndex(items);
    return material;
  }

  function list({ kind, tag, q } = {}) {
    return loadIndex().map((m) => normalizeMaterial(m))
      .filter((m) => !kind || m.kind === kind)
      .filter((m) => !tag || m.tags.includes(tag))
      .filter((m) => !q || m.name.includes(q));
  }
  function get(id) {
    if (typeof id !== "string" || !/^mat-[a-f0-9-]+$/.test(id)) return null;
    const found = loadIndex().find((m) => m.id === id);
    return found ? normalizeMaterial(found) : null;
  }
  function update(id, patch) {
    const items = loadIndex();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const fixed = items[idx];
    items[idx] = normalizeMaterial({ ...patch, id: fixed.id, kind: fixed.kind, file: fixed.file, size: fixed.size, createdAt: fixed.createdAt, name: patch.name ?? fixed.name, tags: patch.tags ?? fixed.tags });
    saveIndex(items);
    return items[idx];
  }
  function rename(id, name) { return update(id, { name: String(name || "").trim().slice(0, 60) || "未命名素材" }); }
  function setTags(id, tags) { return update(id, { tags: Array.isArray(tags) ? tags : [] }); }
  function remove(id) {
    const items = loadIndex();
    const found = items.find((m) => m.id === id);
    if (!found) return false;
    saveIndex(items.filter((m) => m.id !== id));
    const path = join(root, found.file);
    if (existsSync(path)) rmSync(path);
    return true;
  }

  function getBytes(id) {
    const m = get(id);
    if (!m) return null;
    const path = join(root, m.file);
    if (!existsSync(path)) return null;
    try { return readFileSync(path); } catch { return null; }
  }

  return { list, get, register, rename, setTags, remove, getBytes };
}
