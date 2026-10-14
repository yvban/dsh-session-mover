/**
 * dsh-session-mover 单元测试（零外部依赖，node tests/unit.mjs）。
 *
 * 覆盖：
 *   A 编码器与真实目录名逐字一致
 *   B 合成多帧 fixture 的迁移（header 改写 + body 帧字节不变）
 *   C 不硬编码文件名：v0 的 session.jsonl.zstd 与 vN 的 session.vN.jsonl.zstd 都能定位
 *   D 单帧塌缩（历史上导致会话从界面消失的那个 bug）的检测与修复
 *   E no-overwrite 门禁
 *   F readHeaderOnly 与 readLog 一致
 *   G 真实 DSH 会话根目录只读回归（这是第三方插件 0/31 的那一项）
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import * as m from '../lib/migrate.js';

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const compress = (buf) => zstdCompressSync(buf, CHECKSUM);
const line = (value) => Buffer.from(JSON.stringify(value) + '\n', 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log('  FAIL  ' + name);
    console.log('        ' + String(error && error.message ? error.message : error).split('\n').join('\n        '));
  }
}

function makeHeader(id, cwd, version = 4) {
  return { type: 'session', version, id, createdAt: 1791546098667, cwd, isSeeded: false, delegationDepth: 0 };
}

function makeEvents(id, count, prefix = 'e') {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ type: 'event', seq: i, sessionId: id, payload: `${prefix}${i}` });
  }
  return rows;
}

/** 规范日志：header 帧 + N 个 body 帧 */
function makeFramedLog(header, framesOfEvents) {
  return Buffer.concat([
    compress(line(header)),
    ...framesOfEvents.map(rows => compress(Buffer.concat(rows.map(line)))),
  ]);
}

function decodeAll(buf) {
  const { frames } = m.scanZstdFrames(buf);
  return Buffer.concat(frames.map(f => zstdDecompressSync(buf.subarray(f.start, f.end))));
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-migrate-test-'));
const SRC_CWD = String.raw`G:\work\alpha`;
const DST_CWD = String.raw`G:\work\beta`;
const SID = 'session-11111111-2222-3333-4444-555555555555';

function freshRoot(name) {
  const root = join(tmpRoot, name, 'sessions');
  mkdirSync(root, { recursive: true });
  return root;
}

function writeSession(root, cwd, id, buf, generationName = 'session.v4.jsonl.zstd') {
  const dir = join(root, m.projectKey(cwd), m.encodeSegment(id));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, generationName);
  writeFileSync(file, buf);
  return { dir, file };
}

// ---------------------------------------------------------------- A 编码器

console.log('\n== A 编码器 vs 真实目录名 ==');
await test('projectKey 与真实 sessions 目录名逐字一致', () => {
  const samples = [
    [String.raw`G:\work\dsh-workspace`, '--G-work-dsh-workspace--'],
    [String.raw`G:\work`, '--G-work--'],
    [String.raw`G:\dsh\work`, '--G-dsh-work--'],
    [String.raw`G:\破解尝试`, '--G-~7834~89E3~5C1D~8BD5--'],
    [String.raw`C:\Users\御坂\Documents\deepseek-harness\default-workspace`,
      '--C-Users-~5FA1~5742-Documents-deepseek-harness-default-workspace--'],
  ];
  for (const [cwd, expected] of samples) {
    assert.equal(m.projectKey(cwd), expected, `projectKey(${cwd})`);
  }
});

await test('encodeSegment 保留 ASCII、转义非 ASCII 与点段', () => {
  assert.equal(m.encodeSegment(SID), SID);
  assert.equal(m.encodeSegment('.'), '~002E');
  assert.equal(m.encodeSegment('..'), '~002E~002E');
  assert.equal(m.encodeSegment('a b'), 'a~0020b');
});

// ---------------------------------------------------------------- B 迁移

console.log('\n== B 合成多帧 fixture 的迁移 ==');
await test('迁移后 header.cwd 改写、body 帧逐字节不变、旧目录删除、备份完整', async () => {
  const root = freshRoot('b1');
  const backupRoot = join(tmpRoot, 'b1', 'backup');
  const header = makeHeader(SID, SRC_CWD, 4);
  const eventFrames = [makeEvents(SID, 3, 'a'), makeEvents(SID, 4, 'b'), makeEvents(SID, 2, 'c')];
  const original = makeFramedLog(header, eventFrames);
  const { dir, file } = writeSession(root, SRC_CWD, SID, original);

  const found = m.locateSession(root, SID);
  assert.ok(found, '应当能定位到会话');
  assert.equal(found.generation.version, 4);
  assert.equal(found.generation.name, 'session.v4.jsonl.zstd');
  assert.equal(m.checkFraming(m.readLog(file), found.generation).ok, true, '规范日志应当通过帧结构检查');

  const report = await m.migrateSessionFiles({ root, backupRoot, id: SID, targetCwd: DST_CWD });
  assert.equal(report.ok, true);
  assert.equal(report.noop, false);
  assert.equal(report.frames, 4, '帧数应为 1 header + 3 body');
  assert.equal(report.srcCwd, SRC_CWD);
  assert.equal(report.targetCwd, DST_CWD);

  // 新位置正确（沿用同名世代文件）
  const expectedNew = join(root, m.projectKey(DST_CWD), m.encodeSegment(SID), 'session.v4.jsonl.zstd');
  assert.equal(report.newFile, expectedNew);
  assert.equal(existsSync(expectedNew), true);
  assert.equal(existsSync(dir), false, '旧会话目录应已删除');

  // header 已改，body 帧字节完全一致
  const migrated = readFileSync(expectedNew);
  const originalFrames = m.scanZstdFrames(original).frames;
  const newFrames = m.scanZstdFrames(migrated).frames;
  assert.equal(newFrames.length, originalFrames.length);
  for (let i = 1; i < newFrames.length; i += 1) {
    const a = migrated.subarray(newFrames[i].start, newFrames[i].end);
    const b = original.subarray(originalFrames[i].start, originalFrames[i].end);
    assert.ok(a.equals(b), `第 ${i} 个 body 帧应字节不变`);
  }
  const newHeader = JSON.parse(zstdDecompressSync(
    migrated.subarray(newFrames[0].start, newFrames[0].end),
  ).subarray(0, -1).toString('utf8'));
  assert.equal(newHeader.cwd, DST_CWD);
  assert.equal(newHeader.id, SID);
  // 头部其它字段不变
  const { cwd: _a, ...restNew } = newHeader;
  const { cwd: _b, ...restOld } = header;
  assert.deepEqual(restNew, restOld);
  // 内容整体等价（仅 cwd 不同）
  assert.equal(decodeAll(migrated).toString('utf8').split('\n').length,
    decodeAll(original).toString('utf8').split('\n').length);

  // 备份
  assert.ok(report.backup && existsSync(report.backup), '应有整目录备份');
  assert.ok(existsSync(join(report.backup, 'session.v4.jsonl.zstd')));
  const manifest = JSON.parse(readFileSync(join(report.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, SID);
  assert.equal(manifest.srcCwd, SRC_CWD);
  assert.equal(manifest.targetCwd, DST_CWD);
});

await test('目标已存在同 id 会话时拒绝覆盖，且不动原会话', async () => {
  const root = freshRoot('b2');
  const backupRoot = join(tmpRoot, 'b2', 'backup');
  const original = makeFramedLog(makeHeader(SID, SRC_CWD, 4), [makeEvents(SID, 2)]);
  const { dir, file } = writeSession(root, SRC_CWD, SID, original);
  const before = readFileSync(file);
  // 目标位置先占位
  writeSession(root, DST_CWD, SID, makeFramedLog(makeHeader(SID, DST_CWD, 4), [makeEvents(SID, 1)]));

  await assert.rejects(
    () => m.migrateSessionFiles({ root, backupRoot, id: SID, targetCwd: DST_CWD }),
    /拒绝覆盖|已存在/,
  );
  assert.equal(existsSync(dir), true, '原会话目录必须保留');
  assert.ok(readFileSync(file).equals(before), '原日志必须未被改动');
});

// ---------------------------------------------------------------- C 世代文件名

console.log('\n== C 不硬编码文件名（世代感知） ==');
await test('v0 的 session.jsonl.zstd 也能被定位与迁移', async () => {
  const root = freshRoot('c1');
  const backupRoot = join(tmpRoot, 'c1', 'backup');
  const header = makeHeader(SID, SRC_CWD, 0);
  const original = makeFramedLog(header, [makeEvents(SID, 2)]);
  writeSession(root, SRC_CWD, SID, original, 'session.jsonl.zstd');

  const found = m.locateSession(root, SID);
  assert.ok(found, 'v0 命名也应能定位');
  assert.equal(found.generation.version, 0);
  assert.equal(m.checkFraming(m.readLog(found.file), found.generation).ok, true);

  const report = await m.migrateSessionFiles({ root, backupRoot, id: SID, targetCwd: DST_CWD });
  assert.equal(report.generation, 0);
  assert.ok(report.newFile.endsWith('session.jsonl.zstd'), '应当沿用 v0 命名，而不是改写成别的版本名');
  assert.equal(existsSync(report.newFile), true);
});

await test('文件名世代与 header.version 不一致时判定为不可读', () => {
  const root = freshRoot('c2');
  const header = makeHeader(SID, SRC_CWD, 4);
  // 故意把 v4 头部放进 v0 文件名里（等价于某些插件写错文件名的情形）
  const { file } = writeSession(root, SRC_CWD, SID, makeFramedLog(header, [makeEvents(SID, 1)]), 'session.jsonl.zstd');
  const found = m.locateSession(root, SID);
  const check = m.checkFraming(m.readLog(file), found.generation);
  assert.equal(check.ok, false);
  assert.ok(check.problems.join(' ').includes('不一致'), '应报世代不一致：' + check.problems.join(' '));
});

// ---------------------------------------------------------------- D 帧结构修复

console.log('\n== D 单帧塌缩的检测与修复 ==');
await test('检测出"整份重压成单帧"的日志', () => {
  const root = freshRoot('d1');
  const header = makeHeader(SID, SRC_CWD, 4);
  const lines = [JSON.stringify(header), ...makeEvents(SID, 50).map(value => JSON.stringify(value))];
  const collapsed = compress(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  const { file } = writeSession(root, SRC_CWD, SID, collapsed);
  const found = m.locateSession(root, SID);
  const check = m.checkFraming(m.readLog(file), found.generation);
  assert.equal(check.ok, false, '单帧塌缩必须被判定为不可读');
  assert.ok(check.problems.join(' ').includes('第 1 个 zstd 帧'), check.problems.join(' '));
});

await test('修复后第 1 帧只含头部行，且全部内容与原文一致', async () => {
  const root = freshRoot('d2');
  const header = makeHeader(SID, SRC_CWD, 4);
  const events = makeEvents(SID, 50);
  const collapsed = compress(Buffer.from(
    [JSON.stringify(header), ...events.map(value => JSON.stringify(value))].join('\n') + '\n', 'utf8',
  ));
  const { file } = writeSession(root, SRC_CWD, SID, collapsed);

  const log = m.readLog(file);
  const repaired = await m.repairFraming(log);
  assert.equal(repaired.changed, true);

  // 第 1 帧只含头部行
  const frames = m.scanZstdFrames(repaired.buf).frames;
  const first = zstdDecompressSync(repaired.buf.subarray(frames[0].start, frames[0].end));
  assert.equal(first.indexOf(0x0a), first.length - 1, '第 1 帧必须恰好一行');
  assert.equal(JSON.parse(first.subarray(0, -1).toString('utf8')).id, SID);

  // 内容零丢失
  const before = decodeAll(collapsed).toString('utf8');
  const after = decodeAll(repaired.buf).toString('utf8');
  assert.equal(after, before, '修复不得增删任何内容');

  // 写回后 checkFraming 通过
  writeFileSync(file, repaired.buf);
  const found = m.locateSession(root, SID);
  assert.equal(m.checkFraming(m.readLog(file), found.generation).ok, true);

  // 幂等
  const again = await m.repairFraming(m.readLog(file));
  assert.equal(again.changed, false);
});

// ---------------------------------------------------------------- E/F

console.log('\n== E/F 只读首帧 与 其它 ==');
await test('readHeaderOnly 与 readLog 结果一致', () => {
  const root = freshRoot('f1');
  const header = makeHeader(SID, SRC_CWD, 4);
  const { file } = writeSession(root, SRC_CWD, SID, makeFramedLog(header, [makeEvents(SID, 5)]));
  const full = m.readLog(file);
  const light = m.readHeaderOnly(file);
  assert.deepEqual(light.header, full.header);
  assert.equal(light.frameOneIsHeaderOnly, full.frameOneIsHeaderOnly);
});

await test('迁移到相同工作区时是 no-op', async () => {
  const root = freshRoot('f2');
  const { file } = writeSession(root, SRC_CWD, SID, makeFramedLog(makeHeader(SID, SRC_CWD, 4), [makeEvents(SID, 1)]));
  const before = readFileSync(file);
  const report = await m.migrateSessionFiles({
    root, backupRoot: join(tmpRoot, 'f2', 'backup'), id: SID, targetCwd: SRC_CWD,
  });
  assert.equal(report.noop, true);
  assert.ok(readFileSync(file).equals(before));
});

await test('日志与头部 cwd 不符时拒绝迁移', async () => {
  const root = freshRoot('f3');
  // 头部说在 SRC_CWD，文件却放在别的工作区目录下
  writeSession(root, DST_CWD, SID, makeFramedLog(makeHeader(SID, SRC_CWD, 4), [makeEvents(SID, 1)]));
  await assert.rejects(
    () => m.migrateSessionFiles({ root, backupRoot: join(tmpRoot, 'f3', 'backup'), id: SID, targetCwd: DST_CWD }),
    /不符/,
  );
});

// ---------------------------------------------------------------- G 真实会话

console.log('\n== G 真实 DSH 会话根目录只读回归 ==');
await test('真实会话：全部可定位、世代名规范、帧结构检查有结论', () => {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  if (!existsSync(root)) {
    console.log('        （本机没有真实会话目录，跳过）');
    return;
  }
  const ids = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const dir of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (dir.isDirectory()) ids.push(dir.name);
    }
  }
  assert.ok(ids.length > 0, '真实会话数应大于 0');

  const missing = [];
  const badGeneration = [];
  let readable = 0;
  let brokenFraming = 0;
  for (const id of ids) {
    const found = m.locateSession(root, id);
    if (found === null) {
      missing.push(id);
      continue;
    }
    if (!/^session(\.v\d+)?\.jsonl\.zstd$/.test(found.generation.name)) badGeneration.push(found.generation.name);
    const check = m.checkFraming(m.readLog(found.file), found.generation);
    if (check.ok) readable += 1;
    else brokenFraming += 1;
  }
  console.log(`        真实会话 ${ids.length} 个：可定位 ${ids.length - missing.length}，可读 ${readable}，帧结构异常 ${brokenFraming}`);
  assert.deepEqual(missing, [], '所有真实会话都应能被定位（这正是某些插件 0/N 的地方）');
  assert.deepEqual(badGeneration, [], '世代文件名必须规范');
});

// ---------------------------------------------------------------- 收尾

rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('失败项：');
  for (const [name, error] of failures) console.log(`  - ${name}: ${error.message}`);
}
process.exit(failed === 0 ? 0 : 1);
