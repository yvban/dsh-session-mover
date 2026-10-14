/**
 * dsh-session-mover —— host 侧插件。
 *
 * 提供三条本地路由（仅本机同源可用）：
 *   GET  /plugins/dsh-session-mover/state    列出工作区与全部会话（含状态）
 *   POST /plugins/dsh-session-mover/migrate  把一个会话迁到另一个工作区
 *   POST /plugins/dsh-session-mover/repair   修复被整份重压搞坏的日志帧结构
 *
 * 归属更新优先走**官方实体 API**（workspaceRegistry.list() 返回的 WorkspaceEntity
 * 上的 attachSession/detachSession），失败才退回直写 workspace.json（需重启）。
 * 唯一用到的非公开方法是 registry.indexHeader —— 用来刷新内存里的头部索引，
 * 否则 attachSession 会拿启动时缓存的旧 cwd 去校验而失败。这点在报告里如实标注。
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  checkFraming, describeSession, listGenerations, locateSession, migrateSessionFiles,
  projectKey, readHeaderOnly, readLog, repairFraming,
} from './migrate.js';

export const name = 'dsh-session-mover';
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'workspaceRegistry'];

const CONFIRM_HEADER = 'x-dsh-session-mover';
const CONFIRM_VALUE = 'session-mover';
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------- HTTP 小工具

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function failure(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra === undefined ? {} : { extra }) } };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid-json: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function currentConnection(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
}

/** 优先用 Host 自己的请求围栏；没有就退回同源检查。 */
function trustFence(connection) {
  if (typeof connection?.requestRejection === 'function') {
    return (req) => connection.requestRejection(req) === undefined;
  }
  return (req) => {
    const host = req.headers.host;
    return typeof host === 'string' && req.headers.origin === `http://${host}`;
  };
}

function isSafeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
}

// ---------------------------------------------------------------- 会话清单

/** 全部已打开（live）的会话 id —— 这些不能搬。 */
function liveSessionIds(ctx) {
  const ids = new Set();
  const sessions = ctx.get('sessions');
  if (sessions === undefined || typeof sessions.list !== 'function') return ids;
  for (const session of sessions.list()) {
    const id = session?.header?.id ?? session?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * 从 DSH 的投影缓存里快速取标题（`<home>/storages/session_projcache/sessions/<id>.json`
 * 里的 `record.rows.title.val`）。这是**显示用的提示**，取不到就当没有，绝不影响迁移。
 */
function readCachedTitles(home) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions');
  const titles = new Map();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return titles;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (id.includes('/') || id.includes('\\')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.record;
      const title = record?.rows?.title?.val;
      if (typeof title === 'string' && title.trim().length > 0) titles.set(id, title);
    } catch {
      /* 缓存行损坏或格式变化：忽略 */
    }
  }
  return titles;
}

/**
 * 缓存里没有标题的会话，用官方公开服务 sessionQuery 折叠一次（权威但更重，
 * 只对缺标题的会话调用）。拿不到就保持 null。
 */
async function fillTitlesFromQuery(sessionQuery, rows) {
  if (sessionQuery === undefined || typeof sessionQuery?.readTitleSnapshots !== 'function') return;
  const missing = rows.filter(row => row.title === null).map(row => row.id);
  if (missing.length === 0) return;
  let results;
  try {
    results = await sessionQuery.readTitleSnapshots(missing);
  } catch {
    return;
  }
  if (!Array.isArray(results)) return;
  const byId = new Map(rows.map(row => [row.id, row]));
  results.forEach((result, index) => {
    if (result === null || typeof result !== 'object' || result.status === 'rejected') return;
    const value = result.value;
    if (value === null || typeof value !== 'object') return;
    const id = typeof value.session?.id === 'string' ? value.session.id : missing[index];
    const row = byId.get(id);
    if (row !== undefined && typeof value.title === 'string' && value.title.trim().length > 0) {
      row.title = value.title;
    }
  });
}

/** 扫描 sessions 根目录，列出每个会话的轻量信息（只读首帧）。 */
function listSessions(ctx, root, cachedTitles) {
  const live = liveSessionIds(ctx);
  const out = [];
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionDir = join(root, project.name, dir.name);
      const generations = listGenerations(sessionDir);
      if (generations.length === 0) continue;
      const generation = generations[generations.length - 1];
      let header = null;
      let framing = { ok: false, problems: ['无法读取首帧'] };
      try {
        const read = readHeaderOnly(generation.path);
        header = read.header;
        framing = checkFraming(
          { header: read.header, frameOneIsHeaderOnly: read.frameOneIsHeaderOnly, tornStart: undefined },
          generation,
        );
      } catch (error) {
        framing = { ok: false, problems: [String(error.message ?? error)] };
      }
      out.push({
        id: header?.id ?? dir.name,
        cwd: header?.cwd ?? null,
        title: cachedTitles.get(header?.id ?? dir.name) ?? null,
        createdAt: header?.createdAt ?? null,
        generation: generation.version,
        generationName: generation.name,
        sizeBytes: generation.sizeBytes,
        dirName: project.name,
        canonicalDir: header?.cwd != null ? projectKey(header.cwd) : null,
        readable: framing.ok,
        problems: framing.problems,
        live: live.has(header?.id ?? dir.name),
      });
    }
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out;
}

function listWorkspaces(ctx) {
  const registry = ctx.workspaceRegistry;
  if (registry === undefined) return [];
  return registry.list().map((entity) => ({
    workspaceId: String(entity.id),
    title: entity.title,
    path: entity.path,
    sessionIds: [...entity.sessionIds].map(String),
  }));
}

// ---------------------------------------------------------------- 归属更新

/**
 * 把会话归属从旧工作区挪到目标工作区。
 * @returns {Promise<{mode:string, error?:string, restartRequired?:boolean}>}
 */
async function moveMembership(ctx, { sessionId, targetEntity, newHeader, home }) {
  const registry = ctx.workspaceRegistry;
  let indexRefreshed = false;
  try {
    const oldEntity = registry.list().find(
      (entity) => entity.id !== targetEntity.id && entity.sessionIds.includes(sessionId),
    );
    // attachSession 会用内存里的头部索引校验 cwd；文件已搬走，索引还是旧的，
    // 所以必须先把这个会话的头部索引刷新成新 header。
    if (typeof registry.indexHeader === 'function') {
      await registry.indexHeader(newHeader);
      indexRefreshed = true;
    }
    await targetEntity.attachSession(sessionId);
    if (oldEntity !== undefined && typeof oldEntity.detachSession === 'function') {
      await oldEntity.detachSession(sessionId);
    }
    return { mode: indexRefreshed ? 'hot' : 'hot-without-index-refresh' };
  } catch (error) {
    const message = String(error?.message ?? error);
    const fallback = writeMembershipToDisk({ home, sessionId, targetWorkspaceId: String(targetEntity.id) });
    if (fallback.ok) return { mode: 'disk', error: message, restartRequired: true };
    return { mode: 'failed', error: `${message}；磁盘兜底也失败：${fallback.error}` };
  }
}

/**
 * 兜底：直接改 workspace.json 的 sessionIds。
 * 必须重启 DSH 才生效（注册表是启动时从磁盘读入内存的）；
 * 且重启前若 DSH 又发生工作区/归档类写入，可能被内存状态覆盖。
 */
function writeMembershipToDisk({ home, sessionId, targetWorkspaceId }) {
  const regPath = join(home, 'storages', 'workspace.json');
  try {
    if (!existsSync(regPath)) return { ok: false, error: `找不到 ${regPath}` };
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    const workspaces = reg?.tables?.workspaces;
    if (workspaces === null || typeof workspaces !== 'object') {
      return { ok: false, error: 'workspace.json 结构不符合预期' };
    }
    const target = workspaces[targetWorkspaceId];
    if (target === undefined) return { ok: false, error: `workspace.json 里没有工作区 ${targetWorkspaceId}` };
    // 先从所有工作区里摘掉（清理可能的陈旧归属），再加入目标
    for (const record of Object.values(workspaces)) {
      if (Array.isArray(record.sessionIds)) {
        record.sessionIds = record.sessionIds.filter((sid) => sid !== sessionId);
      }
    }
    if (!Array.isArray(target.sessionIds)) target.sessionIds = [];
    if (!target.sessionIds.includes(sessionId)) target.sessionIds.unshift(sessionId);
    const tmp = `${regPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    renameSync(tmp, regPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx) {
  const root = ctx.sessionPersistence?.config?.root ?? ctx.sessionPersistence?.root;
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('dsh-session-mover 需要 jsonl 会话持久化后端（拿不到 sessions root）');
  }
  const home = dirname(root);
  const backupRoot = join(home, 'storages', 'session-mover-backup');
  ctx.logger?.info?.(`[dsh-session-mover] sessions root = ${root}`);

  const isTrusted = (req) => trustFence(currentConnection(ctx))(req);

  const stateHandler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, failure('method-not-allowed', '只允许 GET。'));
      return;
    }
    if (!isTrusted(req)) {
      sendJson(res, 403, failure('forbidden', '请求未通过本机同源校验。'));
      return;
    }
    try {
      const workspaces = listWorkspaces(ctx);
      const rows = listSessions(ctx, root, readCachedTitles(home));
      // 每个会话当前挂在哪个工作区（未登记的就是"未分组"）
      const ownerBySession = new Map();
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds) {
          if (!ownerBySession.has(sessionId)) ownerBySession.set(sessionId, workspace);
        }
      }
      for (const row of rows) {
        const owner = ownerBySession.get(row.id);
        row.workspaceId = owner?.workspaceId ?? null;
        row.workspaceTitle = owner?.title ?? null;
      }
      await fillTitlesFromQuery(ctx.get('sessionQuery'), rows);
      sendJson(res, 200, {
        ok: true,
        sessionsRoot: root,
        backupRoot,
        workspaces,
        sessions: rows,
      });
    } catch (error) {
      sendJson(res, 500, failure('state-failed', String(error?.message ?? error)));
    }
  };

  const migrateHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许 POST。'));
      return;
    }
    if (!isTrusted(req) || req.headers[CONFIRM_HEADER] !== CONFIRM_VALUE) {
      sendJson(res, 403, failure('forbidden', '迁移请求未通过本机同源与确认校验。'));
      return;
    }
    if (typeof req.headers['content-type'] !== 'string'
      || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '迁移请求必须是 JSON。'));
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const tooLarge = String(error?.message).includes('request-too-large');
      sendJson(res, tooLarge ? 413 : 400, failure(tooLarge ? 'request-too-large' : 'invalid-json', String(error?.message)));
      return;
    }
    const sessionId = body?.sessionId;
    const targetWorkspaceId = body?.targetWorkspaceId;
    if (!isSafeId(sessionId)) {
      sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'));
      return;
    }
    if (!isSafeId(targetWorkspaceId)) {
      sendJson(res, 400, failure('invalid-workspace-id', '目标工作区 ID 无效。'));
      return;
    }
    const registry = ctx.workspaceRegistry;
    const targetEntity = typeof registry?.get === 'function' ? registry.get(targetWorkspaceId) : undefined;
    if (targetEntity === undefined) {
      sendJson(res, 404, failure('unknown-workspace', `找不到工作区 ${targetWorkspaceId}`));
      return;
    }
    if (liveSessionIds(ctx).has(sessionId)) {
      sendJson(res, 409, failure('session-live', '该会话正在 DSH 中打开，请先关闭它再迁移。'));
      return;
    }

    try {
      const report = await migrateSessionFiles({
        root, backupRoot, id: sessionId, targetCwd: targetEntity.path,
      });
      if (report.noop) {
        sendJson(res, 200, { ok: true, noop: true, sessionId, workspace: targetEntity.title });
        return;
      }
      const membership = await moveMembership(ctx, {
        sessionId, targetEntity, newHeader: report.header, home,
      });
      sendJson(res, 200, {
        ok: true,
        sessionId,
        from: report.srcCwd,
        to: report.targetCwd,
        workspace: targetEntity.title,
        generation: report.generation,
        frames: report.frames,
        backup: report.backup,
        membership,
      });
      ctx.logger?.info?.(
        `[dsh-session-mover] ${sessionId} -> ${targetEntity.path} (frames=${report.frames}, membership=${membership.mode})`,
      );
    } catch (error) {
      const message = String(error?.message ?? error);
      const framingBroken = message.startsWith('FRAMING_BROKEN:');
      sendJson(res, framingBroken ? 422 : 500, failure(framingBroken ? 'framing-broken' : 'migrate-failed', message));
    }
  };

  const repairHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许 POST。'));
      return;
    }
    if (!isTrusted(req) || req.headers[CONFIRM_HEADER] !== CONFIRM_VALUE) {
      sendJson(res, 403, failure('forbidden', '修复请求未通过本机同源与确认校验。'));
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, failure('invalid-json', String(error?.message)));
      return;
    }
    const sessionId = body?.sessionId;
    if (!isSafeId(sessionId)) {
      sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'));
      return;
    }
    if (liveSessionIds(ctx).has(sessionId)) {
      sendJson(res, 409, failure('session-live', '该会话正在 DSH 中打开，请先关闭它再修复。'));
      return;
    }
    try {
      const found = locateSession(root, sessionId);
      if (found === null) {
        sendJson(res, 404, failure('unknown-session', `找不到会话 ${sessionId}`));
        return;
      }
      const log = readLog(found.file);
      const repaired = await repairFraming(log);
      if (!repaired.changed) {
        sendJson(res, 200, { ok: true, changed: false, message: '日志帧结构正常，无需修复。' });
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(home, 'storages', 'session-frame-repair-backup', sessionId, stamp);
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(found.file, join(backupDir, found.generation.name));
      const tmp = `${found.file}.tmp`;
      writeFileSync(tmp, repaired.buf);
      const check = readLog(tmp);
      if (!check.frameOneIsHeaderOnly) {
        rmSync(tmp, { force: true });
        throw new Error('修复后自检失败：第 1 帧仍不是单行头部');
      }
      if (check.header.id !== sessionId) {
        rmSync(tmp, { force: true });
        throw new Error('修复后自检失败：头部 id 变了');
      }
      renameSync(tmp, found.file);
      sendJson(res, 200, {
        ok: true,
        changed: true,
        sessionId,
        backup: backupDir,
        bodyFrames: repaired.bodyFrames,
        message: '帧结构已修复。重启 DSH 后该会话会重新出现在侧边栏。',
      });
      ctx.logger?.info?.(`[dsh-session-mover] repaired framing for ${sessionId}`);
    } catch (error) {
      sendJson(res, 500, failure('repair-failed', String(error?.message ?? error)));
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/plugins/dsh-session-mover/state', handler: stateHandler,
  }), 'dsh-session-mover: state route');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/plugins/dsh-session-mover/migrate', handler: migrateHandler,
  }), 'dsh-session-mover: migrate route');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/plugins/dsh-session-mover/repair', handler: repairHandler,
  }), 'dsh-session-mover: repair route');
}

export { describeSession, locateSession, migrateSessionFiles, repairFraming };
export default { name, inject, apply };
