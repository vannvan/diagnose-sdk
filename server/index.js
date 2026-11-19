/**
 * collector 服务（内网部署）
 *
 * 提供两个接口：
 *   POST /report       接收前端上报，按 appId + 日期落 JSONL；可选就地符号化
 *   POST /symbolicate  拿 release + stack 做源码还原（也可单独给排查工具调用）
 *
 * 设计约束（私有化环境）：
 * - 零框架依赖，只用 node:http，镜像更小、离线装配更容易；
 * - 所有落盘路径都由服务端拼接，绝不接受客户端传入的目录片段；
 * - 请求体大小硬限制，防止被构造的大包打满磁盘；
 * - 落盘失败不影响响应，避免前端因为 collector 故障而反复重试。
 */

import http from 'node:http';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createSymbolicator } from './symbolicate.js';

const PORT = Number(process.env.PORT || 8787);
const MAP_ROOT = process.env.MAP_ROOT || './sourcemaps';
const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_BODY = Number(process.env.MAX_BODY || 4 * 1024 * 1024); // 4MB
const SYMBOLICATE_ON_INGEST = process.env.SYMBOLICATE_ON_INGEST === '1';

const sym = createSymbolicator({ root: MAP_ROOT });

/** 读取请求体，超过上限直接拒绝 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload-too-large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 内网部署通常同域，但客户若有独立静态域，放开 CORS 更省事；
    // 若安全要求严格，改成白名单域名
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(body);
}

/**
 * 事件落盘。
 *
 * 按 appId + 日期分文件，避免单文件无限增长；
 * 用 appendFile 而不是读改写，既快又不会因为并发写坏整个文件。
 * 客户侧取证时直接交给 grep / jq 就能查，不需要额外工具。
 */
async function persist(appId, events, release) {
  const safeApp = String(appId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, safeApp);
  const file = path.join(dir, `${day}.jsonl`);

  await fsPromises.mkdir(dir, { recursive: true });
  const payload = events.map((ev) => JSON.stringify({ ...ev, release: ev.release || release }));
  await fsPromises.appendFile(file, payload.join('\n') + '\n', 'utf8');
  return file;
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      mapRoot: MAP_ROOT,
      dataDir: DATA_DIR,
      cached: sym.stats,
    });
  }

  if (req.method === 'POST' && url.pathname === '/symbolicate') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body.stack !== 'string') {
        return send(res, 400, { error: 'stack required' });
      }
      const stack = await sym.symbolicate(body.release || 'unknown', body.stack);
      return send(res, 200, { stack, found: stack !== body.stack });
    } catch (e) {
      return send(res, e.code === 413 ? 413 : 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/report') {
    try {
      const body = JSON.parse(await readBody(req));
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return send(res, 204, {});

      // 可选：入库时就还原，便于运维直接看可读栈（代价是写入路径变重）
      const toStore = SYMBOLICATE_ON_INGEST
        ? await sym.symbolicateEvents(body.release, events)
        : events;

      persist(body.appId, toStore, body.release).catch((e) => {
        // 落盘失败不能返回 5xx，否则 SDK 会认为上报失败并无限重试
        console.error('[report] persist failed:', e.message);
      });

      return send(res, 204, {});
    } catch (e) {
      return send(res, e.code === 413 ? 413 : 400, { error: e.message });
    }
  }

  send(res, 404, { error: 'not-found' });
});

server.listen(PORT, () => {
  console.log(`[collector] listening on http://0.0.0.0:${PORT}`);
  console.log(`[collector] mapRoot=${MAP_ROOT} dataDir=${DATA_DIR}`);
  // 启动时确保数据目录存在，避免首次写入失败
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
});
