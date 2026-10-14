/**
 * host 侧集成测试：用模拟 ctx 把 lib/index.js 真正跑起来，
 * 走完整的 REST 处理器路径（注册路由 → 校验 → 迁移 → 归属更新）。
 *
 * 不触碰真实 DSH：所有会话都在临时目录里合成。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { apply } from '../lib/index.js';
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
    console.log('        ' + String(error?.message ?? error).split('\n').join('\n        '));
  }
}

const ORIGIN = 'http://127.0.0.1:19387';
const HOST = '127.0.0.1:19387';

function makeReq({ method, headers = {}, body }) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.headers = { host: HOST, origin: ORIGIN, ...headers };
  return stream;
}

function makeRes() {
  const res = { status: 0, headers: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (chunk) => { res.body = chunk === undefined ? null : JSON.parse(chunk.toString('utf8')); };
  return res;
}

/**
 * 模拟一个足够真实的 ctx：路由收集 + 工作区实体 + 可断言的调用记录。
 * @param silentAttach - true 时 attachSession 静默无效（模拟上游 mutate 的 canonical-cwd
 *   过滤把成员丢掉的情形），用来验证插件不会把它误报成"热更新成功"。
 */
function makeCtx({ root, workspaces, liveIds = [], sessionQuery, silentAttach = false }) {
  const routes = new Map();
  const memberships = new Map(workspaces.map(ws => [ws.workspaceId, new Set(ws.sessionIds)]));
  const calls = { attach: [], detach: [], indexHeader: [], titleQuery: [] };
  const entities = new Map();
  for (const ws of workspaces) {
    entities.set(ws.workspaceId, {
      id: ws.workspaceId,
      title: ws.title,
      path: ws.path,
      get sessionIds() { return [...memberships.get(ws.workspaceId)]; },
      async attachSession(sessionId) {
        calls.attach.push([ws.workspaceId, sessionId]);
        if (silentAttach) return;
        memberships.get(ws.workspaceId).add(sessionId);
      },
      async detachSession(sessionId) {
        calls.detach.push([ws.workspaceId, sessionId]);
        memberships.get(ws.workspaceId).delete(sessionId);
      },
    });
  }
  const registry = {
    list: () => [...entities.values()],
    get: (id) => entities.get(id),
    indexHeader: async (header) => { calls.indexHeader.push(header); },
  };
  const ctx = {
    sessionPersistence: { config: { root } },
    workspaceRegistry: registry,
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect: (fn) => fn(),
    get: (name) => {
      if (name === 'sessions') return { list: () => liveIds.map(id => ({ header: { id } })) };
      if (name === 'sessionQuery') return sessionQuery;
      return undefined;
    },
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, routes, memberships, calls };
}

const SID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SRC_CWD = String.raw`G:\work\alpha`;
const DST_CWD = String.raw`G:\work\beta`;
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-migrate-host-'));
const sessionsRoot = join(tmpRoot, 'sessions');

function makeHeader(id, cwd, version = 4) {
  return { type: 'session', version, id, createdAt: 1791546098667, cwd, isSeeded: false, delegationDepth: 0 };
}

function writeSyntheticSession(id, cwd, version = 4, bodyEvents = 5) {
  const dir = join(sessionsRoot, m.projectKey(cwd), m.encodeSegment(id));
  mkdirSync(dir, { recursive: true });
  const headerFrame = compress(line(makeHeader(id, cwd, version)));
  const bodyFrame = compress(Buffer.concat(
    Array.from({ length: bodyEvents }, (_, i) => line({ type: 'event', seq: i, sessionId: id })),
  ));
  const file = join(dir, `session${version === 0 ? '' : `.v${version}`}.jsonl.zstd`);
  writeFileSync(file, Buffer.concat([headerFrame, bodyFrame]));
  return { dir, file };
}

const WS = [
  { workspaceId: 'ws-alpha', title: 'alpha', path: SRC_CWD, sessionIds: [SID] },
  { workspaceId: 'ws-beta', title: 'beta', path: DST_CWD, sessionIds: [] },
];

console.log('\n== host 插件：注册与鉴权 ==');
{
  const { dir } = writeSyntheticSession(SID, SRC_CWD);
  const { ctx, routes } = makeCtx({ root: sessionsRoot, workspaces: WS });
  apply(ctx);

  await test('apply() 注册了三条路由', () => {
    assert.deepEqual([...routes.keys()].sort(), [
      '/plugins/dsh-session-mover/migrate',
      '/plugins/dsh-session-mover/repair',
      '/plugins/dsh-session-mover/state',
    ]);
  });

  await test('GET state 返回工作区与会话（含可读性判定）', async () => {
    const res = makeRes();
    await routes.get('/plugins/dsh-session-mover/state')(makeReq({ method: 'GET' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.workspaces.length, 2);
    const row = res.body.sessions.find(s => s.id === SID);
    assert.ok(row, '应列出合成的会话');
    assert.equal(row.readable, true, '规范日志应判定可读');
    assert.equal(row.generationName, 'session.v4.jsonl.zstd');
    assert.equal(row.live, false);
  });

  await test('跨站请求被拒（origin 不匹配）', async () => {
    const res = makeRes();
    await routes.get('/plugins/dsh-session-mover/state')(
      makeReq({ method: 'GET', headers: { origin: 'http://evil.example' } }), res);
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
  });

  await test('缺少确认头的迁移请求被拒', async () => {
    const res = makeRes();
    await routes.get('/plugins/dsh-session-mover/migrate')(
      makeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { sessionId: SID, targetWorkspaceId: 'ws-beta' } }),
      res);
    assert.equal(res.status, 403);
  });

  await test('迁移到未知工作区返回 404', async () => {
    const res = makeRes();
    await routes.get('/plugins/dsh-session-mover/migrate')(
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-mover': 'session-mover' },
        body: { sessionId: SID, targetWorkspaceId: 'ws-nope' },
      }), res);
    assert.equal(res.status, 404);
  });

  await test('迁移成功：文件搬走 + 归属热更新（attach/detach + indexHeader）', async () => {
    const { ctx: ctx2, routes: routes2, memberships, calls } = makeCtx({ root: sessionsRoot, workspaces: WS });
    apply(ctx2);
    const res = makeRes();
    await routes2.get('/plugins/dsh-session-mover/migrate')(
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-mover': 'session-mover' },
        body: { sessionId: SID, targetWorkspaceId: 'ws-beta' },
      }), res);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.from, SRC_CWD);
    assert.equal(res.body.to, DST_CWD);
    assert.equal(res.body.membership.mode, 'hot');

    // 文件确实搬到了目标工作区目录，且沿用同名世代文件
    const newFile = join(sessionsRoot, m.projectKey(DST_CWD), m.encodeSegment(SID), 'session.v4.jsonl.zstd');
    assert.equal(existsSync(newFile), true);
    assert.equal(existsSync(dir), false);
    // 头部已改、首帧仍只含一行
    const raw = readFileSync(newFile);
    const frames = m.scanZstdFrames(raw).frames;
    const first = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end));
    assert.equal(first.indexOf(0x0a), first.length - 1);
    assert.equal(JSON.parse(first.subarray(0, -1).toString('utf8')).cwd, DST_CWD);

    // 归属：先刷新了内存头部索引，再 attach 到目标、detach 旧的
    assert.equal(calls.indexHeader.length, 1);
    assert.equal(calls.indexHeader[0].cwd, DST_CWD);
    assert.deepEqual(calls.attach, [['ws-beta', SID]]);
    assert.deepEqual(calls.detach, [['ws-alpha', SID]]);
    assert.equal(memberships.get('ws-beta').has(SID), true);
    assert.equal(memberships.get('ws-alpha').has(SID), false);
  });

  await test('正在打开的会话拒绝迁移（409）', async () => {
    const { ctx: ctx3, routes: routes3 } = makeCtx({ root: sessionsRoot, workspaces: WS, liveIds: [SID] });
    apply(ctx3);
    const res = makeRes();
    await routes3.get('/plugins/dsh-session-mover/migrate')(
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-mover': 'session-mover' },
        body: { sessionId: SID, targetWorkspaceId: 'ws-beta' },
      }), res);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'session-live');
  });
}

console.log('\n== host 插件：标题与分组 ==');
await test('标题优先取投影缓存，缺失的用 sessionQuery 兜底；并给出当前分组', async () => {
  const home2 = mkdtempSync(join(tmpdir(), 'dsh-migrate-title-'));
  const root2 = join(home2, 'sessions');
  const ID_A = 'session-title-a';
  const ID_B = 'session-title-b';
  const ID_C = 'session-title-c';

  const put = (id, cwd) => {
    const dir = join(root2, m.projectKey(cwd), m.encodeSegment(id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
      compress(line(makeHeader(id, cwd, 4))),
      compress(line({ type: 'event', seq: 0 })),
    ]));
  };
  put(ID_A, SRC_CWD);
  put(ID_B, DST_CWD);
  put(ID_C, DST_CWD);

  // 投影缓存里只有 A 的标题
  const cacheDir = join(home2, 'storages', 'session_projcache', 'sessions');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${ID_A}.json`), JSON.stringify({
    record: { identity: { cwd: SRC_CWD }, rows: { title: { ver: 1, seq: 3, val: '会议音频转文字并总结' } } },
    version: 7,
  }));
  // 缓存里没有的（B、C）交给 sessionQuery 兜底，只有 B 有标题
  let queried = null;
  const sessionQuery = {
    async readTitleSnapshots(ids) {
      queried = [...ids];
      return ids.map(id => ({
        status: 'fulfilled',
        value: { session: { id }, ...(id === ID_B ? { title: '安装 dsh-market 插件' } : {}) },
      }));
    },
  };

  const { ctx, routes } = makeCtx({
    root: root2,
    workspaces: [
      { workspaceId: 'ws-alpha', title: 'alpha', path: SRC_CWD, sessionIds: [ID_A] },
      { workspaceId: 'ws-beta', title: 'beta', path: DST_CWD, sessionIds: [] },
    ],
    sessionQuery,
  });
  apply(ctx);
  const res = makeRes();
  await routes.get('/plugins/dsh-session-mover/state')(makeReq({ method: 'GET' }), res);
  assert.equal(res.status, 200);

  const byId = new Map(res.body.sessions.map(row => [row.id, row]));
  assert.equal(byId.get(ID_A).title, '会议音频转文字并总结', '缓存命中应当直接给出标题');
  assert.equal(byId.get(ID_B).title, '安装 dsh-market 插件', '缓存缺失应当由 sessionQuery 兜底');
  assert.equal(byId.get(ID_C).title, null, '两边都没有标题时保持 null');
  assert.ok(queried !== null && !queried.includes(ID_A), '缓存已命中的会话不应再查一遍');
  // 当前分组
  assert.equal(byId.get(ID_A).workspaceTitle, 'alpha');
  assert.equal(byId.get(ID_A).workspaceId, 'ws-alpha');
  assert.equal(byId.get(ID_B).workspaceTitle, null, '未登记的会话应显示为未分组');
  rmSync(home2, { recursive: true, force: true });
});

console.log('\n== host 插件：归属更新必须被证实 ==');
await test('attachSession 静默无效时不得报 hot，要退到磁盘兜底并如实说明', async () => {
  const home3 = mkdtempSync(join(tmpdir(), 'dsh-mover-membership-'));
  const root3 = join(home3, 'sessions');
  const id = 'session-silent-attach';
  const dir = join(root3, m.projectKey(SRC_CWD), m.encodeSegment(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    compress(line(makeHeader(id, SRC_CWD, 4))),
    compress(line({ type: 'event', seq: 0 })),
  ]));
  // 磁盘兜底要用的注册表
  const stamp = new Date().toISOString();
  mkdirSync(join(home3, 'storages'), { recursive: true });
  writeFileSync(join(home3, 'storages', 'workspace.json'), JSON.stringify({
    tables: {
      workspaces: {
        'ws-alpha': { path: SRC_CWD, title: 'alpha', sessionIds: [id], createdAt: stamp, updatedAt: stamp },
        'ws-beta': { path: DST_CWD, title: 'beta', sessionIds: [], createdAt: stamp, updatedAt: stamp },
      },
    },
    global: {
      initialized: true, workspaceIds: ['ws-alpha', 'ws-beta'],
      archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: 'ws-alpha',
    },
  }, null, 2), 'utf8');

  const { ctx, routes, memberships } = makeCtx({
    root: root3,
    workspaces: [
      { workspaceId: 'ws-alpha', title: 'alpha', path: SRC_CWD, sessionIds: [id] },
      { workspaceId: 'ws-beta', title: 'beta', path: DST_CWD, sessionIds: [] },
    ],
    silentAttach: true,
  });
  apply(ctx);
  const res = makeRes();
  await routes.get('/plugins/dsh-session-mover/migrate')(
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-session-mover': 'session-mover' },
      body: { sessionId: id, targetWorkspaceId: 'ws-beta' },
    }), res);

  assert.equal(res.status, 200);
  assert.notEqual(res.body.membership.mode, 'hot', '静默失效绝不能被报成热更新成功');
  assert.equal(res.body.membership.mode, 'disk');
  assert.equal(res.body.membership.verified, false);
  assert.ok(String(res.body.membership.error).includes('仍然没有该会话'), '应给出可诊断的原因');
  // 文件仍然搬走了（迁移本身成功），只是归属需要重启
  assert.equal(existsSync(join(root3, m.projectKey(DST_CWD), m.encodeSegment(id), 'session.v4.jsonl.zstd')), true);
  // 磁盘兜底确实写对了
  const reg = JSON.parse(readFileSync(join(home3, 'storages', 'workspace.json'), 'utf8'));
  assert.ok(reg.tables.workspaces['ws-beta'].sessionIds.includes(id), '兜底应把会话写进目标工作区');
  assert.ok(!reg.tables.workspaces['ws-alpha'].sessionIds.includes(id), '兜底应把它从旧工作区摘掉');
  assert.equal(memberships.get('ws-beta').has(id), false, '内存里确实没生效（这正是要检测出来的情形）');
  rmSync(home3, { recursive: true, force: true });
});

console.log('\n== host 插件：帧结构修复入口 ==');
await test('repair 能修好单帧塌缩的日志并备份', async () => {
  const collapsedId = 'session-99999999-8888-7777-6666-555555555555';
  const dir = join(sessionsRoot, m.projectKey(SRC_CWD), m.encodeSegment(collapsedId));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v4.jsonl.zstd');
  const lines = [JSON.stringify(makeHeader(collapsedId, SRC_CWD)), ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'event', seq: i }))];
  writeFileSync(file, compress(Buffer.from(lines.join('\n') + '\n', 'utf8')));

  const { ctx, routes } = makeCtx({ root: sessionsRoot, workspaces: WS });
  apply(ctx);

  // 先确认状态接口把它标成不可读
  const stateRes = makeRes();
  await routes.get('/plugins/dsh-session-mover/state')(makeReq({ method: 'GET' }), stateRes);
  const row = stateRes.body.sessions.find(s => s.id === collapsedId);
  assert.equal(row.readable, false, '塌缩日志应被标记为不可读');

  const res = makeRes();
  await routes.get('/plugins/dsh-session-mover/repair')(
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-session-mover': 'session-mover' },
      body: { sessionId: collapsedId },
    }), res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.changed, true);
  assert.ok(res.body.backup && existsSync(res.body.backup), '修复前应有备份');

  const raw = readFileSync(file);
  const frames = m.scanZstdFrames(raw).frames;
  const first = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end));
  assert.equal(first.indexOf(0x0a), first.length - 1, '修好后第 1 帧必须只含头部行');
  const all = Buffer.concat(frames.map(f => zstdDecompressSync(raw.subarray(f.start, f.end)))).toString('utf8');
  assert.equal(all, lines.join('\n') + '\n', '修复不得增删内容');
});

rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('失败项：');
  for (const [name, error] of failures) console.log(`  - ${name}: ${error.message}`);
}
process.exit(failed === 0 ? 0 : 1);
