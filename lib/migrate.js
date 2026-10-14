/**
 * dsh-session-mover 核心：会话日志的定位、帧级头部改写、字节级校验与文件级迁移。
 *
 * 这个文件里的每条规则都是踩坑换来的，改动前请先读注释：
 *
 * 1) DSH 的会话日志是「多帧 zstd」：**第 1 帧必须只包含 header 那一行**，其余每帧
 *    独立可解码（每帧带 checksum）。DSH 读取时会用 assertZstdHeaderFrame 校验，
 *    不满足就抛 SessionPersistenceCorruptionError，而会话枚举会**静默跳过**该日志
 *    —— 现象就是会话在侧边栏里彻底消失（文件其实完好）。
 *    因此改 header 只能重压第 1 帧，body 帧必须**字节原样保留**。
 *    整份解压后重压会把多帧塌缩成单帧，正好触发上面那条校验。
 *
 * 2) 日志文件名带格式世代号：v0 叫 `session.jsonl.zstd`，vN(N>0) 叫
 *    `session.vN.jsonl.zstd`。**绝不能硬编码文件名**（这正是某些第三方插件在
 *    新版本 DSH 上找不到任何会话的原因），要按目录里实际存在的最高世代解析，
 *    并核对文件名世代与 header.version 一致。
 *
 * 3) 会话所在目录 = projectKey(header.cwd)，这是 DSH 的 canonical 语义；
 *    文件名/目录名编码必须与官方实现逐字一致，否则会触发 DSH 的损坏校验。
 *
 * 只依赖 node 内置模块，可离线单元测试。
 */

import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { constants, zstdCompress, zstdDecompressSync } from 'node:zlib';
import { promisify } from 'node:util';

const zstdCompressAsync = promisify(zstdCompress);

/** 与官方 jsonl 后端一致：每帧独立、带 checksum。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const ZSTD_MAGIC = 0xfd2fb528;
/** 修复/重建时的 body 分帧大小上限（按行边界切，避免一个巨大帧）。 */
const REPAIR_CHUNK_BYTES = 1 << 20;

// ---------------------------------------------------------------------------
// 路径编码（与 @deepseek-ai/dsh-session-persistence-jsonl 的 encodeSegment /
// projectKey 逐字一致；已用本机 31 个真实会话目录交叉验证）
// ---------------------------------------------------------------------------

/** 单个路径段编码（会话目录名）。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** 工作区路径 → sessions 下的项目目录名（如 G:\work\x → --G-work-x--）。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function projectDir(root, cwd) {
  return join(root, projectKey(cwd));
}

// ---------------------------------------------------------------------------
// zstd 帧扫描（同步自官方实现）
// ---------------------------------------------------------------------------

/**
 * 定位每个完整 zstd 帧的 [start, end)。
 * @param {Buffer} buffer 原始字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

// ---------------------------------------------------------------------------
// 世代文件名解析（不硬编码任何版本号）
// ---------------------------------------------------------------------------

const GENERATION_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 列出一个会话目录里所有规范世代，按版本升序。
 * @returns {Array<{version:number,name:string,path:string,sizeBytes:number}>}
 */
export function listGenerations(sessionDir) {
  let names;
  try {
    names = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = GENERATION_RE.exec(name);
    if (m === null) continue;
    const version = m[1] === undefined ? 0 : Number(m[1]);
    const path = join(sessionDir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      continue;
    }
    out.push({ version, name, path, sizeBytes });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** 取最高世代（DSH 的权威当前世代）。 */
export function resolveGeneration(sessionDir) {
  const all = listGenerations(sessionDir);
  return all.length === 0 ? null : all[all.length - 1];
}

/**
 * 在 sessions 根目录下按会话 id 定位日志（遍历所有项目目录，不假设 cwd）。
 * @returns {null | {file:string, sessionDir:string, projectDir:string, generation:object}}
 */
export function locateSession(root, id) {
  const encoded = encodeSegment(id);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(root, entry.name, encoded);
    const generation = resolveGeneration(sessionDir);
    if (generation === null) continue;
    return { file: generation.path, sessionDir, projectDir: join(root, entry.name), generation };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 读取与帧结构校验
// ---------------------------------------------------------------------------

/** 读取日志：返回原始字节、帧表、header 明文与解析结果。 */
export function readLog(file) {
  const raw = readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(raw);
  if (frames.length === 0) throw new Error('会话日志里没有完整的 zstd 帧');
  const headerPlain = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end));
  const nl = headerPlain.indexOf(0x0a);
  const headerLine = nl === -1 ? headerPlain : headerPlain.subarray(0, nl);
  let header;
  try {
    header = JSON.parse(headerLine.toString('utf8'));
  } catch (error) {
    throw new Error(`会话日志首帧不是合法 JSON 头部：${error.message}`);
  }
  const frameOneIsHeaderOnly = nl !== -1 && nl === headerPlain.length - 1;
  return { raw, frames, tornStart, headerPlain, headerLine, header, frameOneIsHeaderOnly };
}

/**
 * 只读首帧拿头部（列出会话清单时用，避免为读 header 把上百 MB 日志整个读进来）。
 * @returns {{header:object, headerPlain:Buffer, frameOneIsHeaderOnly:boolean}}
 */
export function readHeaderOnly(file) {
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let buf = Buffer.alloc(0);
  let frames = null;
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      frames = scanZstdFrames(buf).frames;
      if (frames.length >= 1) break;
      if (buf.length > 32 * 1024 * 1024) throw new Error('会话日志首帧异常大（>32MB）');
    }
  } finally {
    closeSync(fd);
  }
  if (frames === null || frames.length === 0) throw new Error('会话日志里没有完整的 zstd 帧');
  const first = frames[0];
  const headerPlain = zstdDecompressSync(buf.subarray(first.start, first.end));
  const nl = headerPlain.indexOf(0x0a);
  const headerLine = nl === -1 ? headerPlain : headerPlain.subarray(0, nl);
  let header;
  try {
    header = JSON.parse(headerLine.toString('utf8'));
  } catch (error) {
    throw new Error(`会话日志首帧不是合法 JSON 头部：${error.message}`);
  }
  return { header, headerPlain, frameOneIsHeaderOnly: nl !== -1 && nl === headerPlain.length - 1 };
}

/**
 * 校验帧结构 + 世代号一致性。这是"会话能不能被 DSH 读出来"的判定。
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkFraming(log, generation) {
  const problems = [];
  if (log.tornStart !== undefined) problems.push(`日志尾部有未完成的帧（byte ${log.tornStart}），可能被截断`);
  if (!log.frameOneIsHeaderOnly) {
    problems.push(
      '第 1 个 zstd 帧不是"只含头部一行"——DSH 会判定日志损坏并静默忽略整个会话（会话在界面消失）',
    );
  }
  if (typeof log.header.version !== 'number') {
    problems.push('头部缺少 version 字段');
  } else if (generation !== undefined && generation !== null && log.header.version !== generation.version) {
    problems.push(
      `文件名世代(v${generation.version})与头部 version(v${log.header.version})不一致，DSH 会拒绝该日志`,
    );
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 改写：只重压第 1 帧
// ---------------------------------------------------------------------------

/**
 * 生成"新 header 帧 + 原 body 帧字节"的新日志缓冲。
 * @param {object} log readLog() 的结果
 * @param {string} newCwd 目标工作区路径
 * @returns {Promise<{buf:Buffer, header:object, newHeaderLine:Buffer}>}
 */
export async function rewriteHeader(log, newCwd) {
  if (!log.frameOneIsHeaderOnly) {
    throw new Error('FRAMING_BROKEN: 第 1 帧不是单行头部，先用 repair 修复帧结构再迁移');
  }
  const next = { ...log.header, cwd: newCwd };
  const newHeaderLine = Buffer.from(JSON.stringify(next), 'utf8');
  const newHeaderPlain = Buffer.concat([newHeaderLine, Buffer.from('\n')]);
  const newHeaderFrame = await zstdCompressAsync(newHeaderPlain, CHECKSUM_OPTIONS);
  const bodyStart = log.frames[0].end;
  return {
    buf: Buffer.concat([newHeaderFrame, log.raw.subarray(bodyStart)]),
    header: next,
    newHeaderLine,
  };
}

/**
 * 字节级校验：帧数不变、body 帧逐字节相同、头部 id/cwd 正确。
 * **不做全量解压**（大日志也不吃内存）。
 */
export function verifyRewritten(buf, { id, cwd, originalRaw }) {
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error('校验失败：新日志没有完整帧');
  const first = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end));
  if (first.indexOf(0x0a) !== first.length - 1) {
    throw new Error('校验失败：新日志第 1 帧不是单行头部');
  }
  const header = JSON.parse(first.subarray(0, -1).toString('utf8'));
  if (header.id !== id) throw new Error(`校验失败：头部 id=${header.id}，期望 ${id}`);
  if (header.cwd !== cwd) throw new Error(`校验失败：头部 cwd=${JSON.stringify(header.cwd)}，期望 ${JSON.stringify(cwd)}`);
  if (originalRaw !== undefined) {
    const { frames: of } = scanZstdFrames(originalRaw);
    if (of.length !== frames.length) {
      throw new Error(`校验失败：帧数从 ${of.length} 变成 ${frames.length}`);
    }
    for (let i = 1; i < frames.length; i += 1) {
      const a = buf.subarray(frames[i].start, frames[i].end);
      const b = originalRaw.subarray(of[i].start, of[i].end);
      if (!a.equals(b)) throw new Error(`校验失败：第 ${i} 个 body 帧字节被改动`);
    }
  }
  return header;
}

// ---------------------------------------------------------------------------
// 帧结构修复（针对已经被"整份重压"搞坏的日志）
// ---------------------------------------------------------------------------

/**
 * 把无法被 DSH 读取的日志重建成规范帧结构：头部帧 + 按行边界切分的 body 帧。
 * 只在 `checkFraming` 失败时使用；内容不做任何增删。
 * @returns {Promise<{buf:Buffer, header:object, bodyFrames:number, changed:boolean}>}
 */
export async function repairFraming(log) {
  if (log.frameOneIsHeaderOnly && log.tornStart === undefined) {
    return { buf: log.raw, header: log.header, bodyFrames: log.frames.length - 1, changed: false };
  }
  // 取完整明文（多帧全部解开）
  const parts = [];
  for (const f of log.frames) parts.push(zstdDecompressSync(log.raw.subarray(f.start, f.end)));
  const all = Buffer.concat(parts);
  const nl = all.indexOf(0x0a);
  if (nl === -1) throw new Error('修复失败：日志里没有头部行');
  const headerLine = all.subarray(0, nl);
  let header;
  try {
    header = JSON.parse(headerLine.toString('utf8'));
  } catch (error) {
    throw new Error(`修复失败：头部不是合法 JSON：${error.message}`);
  }
  const body = all.subarray(nl + 1);

  const frames = [await zstdCompressAsync(Buffer.concat([headerLine, Buffer.from('\n')]), CHECKSUM_OPTIONS)];
  let cursor = 0;
  let bodyFrames = 0;
  while (cursor < body.length) {
    let end = Math.min(cursor + REPAIR_CHUNK_BYTES, body.length);
    if (end < body.length) {
      const nextLine = body.indexOf(0x0a, end);
      end = nextLine === -1 ? body.length : nextLine + 1;
    }
    frames.push(await zstdCompressAsync(body.subarray(cursor, end), CHECKSUM_OPTIONS));
    bodyFrames += 1;
    cursor = end;
  }
  return { buf: Buffer.concat(frames), header, bodyFrames, changed: true };
}

// ---------------------------------------------------------------------------
// 文件级迁移（事务：备份 → 构建 → 校验 → 落位 → 删除旧目录）
// ---------------------------------------------------------------------------

function copyDirInto(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true, force: true });
}

/**
 * 把一个会话的日志搬到另一个工作区目录（只改 header.cwd）。
 *
 * 安全措施：先整目录备份（含 manifest）、目标已存在同 id 则拒绝、
 * 临时文件校验通过后才 rename、校验失败自动回滚不留半成品。
 *
 * @returns {Promise<object>} 迁移报告
 */
export async function migrateSessionFiles({
  root, backupRoot, id, targetCwd, now = Date.now(),
}) {
  const found = locateSession(root, id);
  if (found === null) throw new Error(`在 ${root} 下找不到会话 ${id} 的日志`);

  const log = readLog(found.file);
  const framing = checkFraming(log, found.generation);
  if (!framing.ok) throw new Error(`FRAMING_BROKEN: ${framing.problems.join('；')}`);

  const srcCwd = log.header.cwd;
  if (typeof srcCwd !== 'string' || srcCwd.length === 0) {
    throw new Error('会话头部没有 cwd，无法确定它属于哪个工作区');
  }
  // canonical 语义：日志必须待在 projectKey(header.cwd) 目录里
  if (found.projectDir !== projectDir(root, srcCwd)) {
    throw new Error(
      `日志位置(${found.projectDir})与头部 cwd(${JSON.stringify(srcCwd)})不符，拒绝迁移以免放大问题`,
    );
  }
  if (srcCwd === targetCwd) {
    return {
      ok: true, noop: true, id, srcCwd, targetCwd, generation: found.generation.version,
      frames: log.frames.length, header: log.header, oldFile: found.file, backup: null, newFile: found.file,
    };
  }

  const newProjectDir = projectDir(root, targetCwd);
  const newSessionDir = join(newProjectDir, encodeSegment(id));
  const newFile = join(newSessionDir, found.generation.name);
  if (existsSync(newFile)) {
    throw new Error(`目标工作区已存在同 id 会话：${newFile}（拒绝覆盖）`);
  }

  // 1) 整目录备份 + manifest
  const backupDir = join(backupRoot, id, String(now));
  copyDirInto(found.sessionDir, backupDir);
  const manifest = {
    id, srcCwd, targetCwd, at: now, sourceFile: found.file,
    generation: found.generation.name, frames: log.frames.length, sizeBytes: found.generation.sizeBytes,
  };

  // 2) 构建新字节（只重压 header 帧）
  const { buf, header } = await rewriteHeader(log, targetCwd);
  // 3) 字节级校验
  verifyRewritten(buf, { id, cwd: targetCwd, originalRaw: log.raw });

  // 4) 落位：临时文件校验通过后才 rename；任何失败都清干净，不留半成品
  mkdirSync(newSessionDir, { recursive: true });
  const tmp = `${newFile}.tmp`;
  try {
    writeFileSync(tmp, buf);
    verifyRewritten(readFileSync(tmp), { id, cwd: targetCwd, originalRaw: log.raw });
    renameSync(tmp, newFile);
  } catch (error) {
    rmSync(tmp, { force: true });
    rmSync(newSessionDir, { recursive: true, force: true });
    throw error;
  }
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 5) 删旧目录（companion 文件已随备份保留）
  rmSync(found.sessionDir, { recursive: true, force: true });

  return {
    ok: true, noop: false, id, srcCwd, targetCwd,
    generation: found.generation.version,
    frames: log.frames.length,
    header,
    oldFile: found.file,
    newFile,
    backup: backupDir,
    manifest,
  };
}

/** 迁移后回滚（把日志搬回原工作区；目标已存在则拒绝）。 */
export async function rollbackSessionFiles({ root, id, srcCwd, now = Date.now() }) {
  const found = locateSession(root, id);
  if (found === null) throw new Error(`找不到会话 ${id} 的日志，无法回滚`);
  const restore = join(projectDir(root, srcCwd), encodeSegment(id));
  if (existsSync(restore)) throw new Error(`回滚目标已存在：${restore}（拒绝覆盖）`);
  mkdirSync(dirname(restore), { recursive: true });
  renameSync(found.sessionDir, restore);
  return { ok: true, id, restoredTo: restore, at: now };
}

/** 日志所在目录与文件名（用于报告）。 */
export function describeSession(root, id) {
  const found = locateSession(root, id);
  if (found === null) return null;
  return {
    file: found.file,
    dir: found.sessionDir,
    projectDir: found.projectDir,
    generationName: found.generation.name,
    generationVersion: found.generation.version,
    sizeBytes: found.generation.sizeBytes,
    dirName: basename(found.sessionDir),
  };
}
