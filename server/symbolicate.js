/**
 * symbolicate.js —— sourcemap 符号化核心
 *
 * 把压缩后的调用栈还原成「源码文件:行:列 + 原始函数名」。
 *
 * 目录约定：
 *   sourcemaps/<release>/<bundle 文件名>.map
 *   例：sourcemaps/2.3.1/main.a1b2c3.js.map
 *
 * 为什么按 release 分目录：不同版本的同名 bundle 内容完全不同，
 * 混在一起会导致映射错位，还原出来的位置比不还原更误导人。
 *
 * 安全：文件名来自客户端上报的调用栈，属于不可信输入，必须做白名单校验，
 * 否则 `../../etc/passwd` 这类构造可以直接读到服务器任意文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const DEFAULT_ROOT = './sourcemaps';

/**
 * 校验 bundle 文件名。
 *
 * 只允许「字母数字下划线点横线 + .js 结尾」，并且长度受限。
 * 这是防止路径穿越的唯一关口，放宽任何一个字符都可能被利用。
 *
 * @returns {string|null} 合法则返回文件名，否则 null
 */
export function safeFileName(name) {
  if (typeof name !== 'string') return null;
  if (name.length > 200) return null;
  if (!/^[A-Za-z0-9._-]+\.js$/.test(name)) return null;
  // 双保险：即便正则被绕过，也不允许出现路径分隔符
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

/**
 * 解析单帧。
 *
 * 需要兼容的格式（Chrome / Firefox / Safari 略有差异）：
 *   "    at fnName (http://a/b.js:1:2)"
 *   "    at http://a/b.js:1:2"
 *   "    at async fnName (/b.js:1:2)"
 *   "    at Object.<anonymous> (/b.js:1:2)"
 *
 * @returns {{fn: string, url: string, line: number, column: number}|null}
 */
export function parseFrame(line) {
  const m = /^\s*at\s+(.+)$/.exec(String(line || ''));
  if (!m) return null;

  let body = m[1].trim();
  let fn = '';

  // 先剥掉函数名部分：最后一个括号包裹的是位置
  const paren = /^(.*?)\s*\((.*)\)$/.exec(body);
  if (paren) {
    fn = paren[1];
    body = paren[2];
  }

  // 位置必须是 url:line:col 形式，且行列为数字
  const loc = /^(.+):(\d+):(\d+)$/.exec(body);
  if (!loc) return null;

  return {
    fn,
    url: loc[1],
    line: Number(loc[2]),
    column: Number(loc[3]),
  };
}

/**
 * 创建符号化器。
 *
 * @param {object} opts
 * @param {string} [opts.root='./sourcemaps'] sourcemap 根目录
 * @param {number} [opts.maxCache=200] 缓存多少个 TraceMap（每个可能几 MB，别设太大）
 */
export function createSymbolicator(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const maxCache = opts.maxCache || 200;
  const cache = new Map(); // key: release/fileName
  const stats = { hits: 0, misses: 0, frames: 0, mapped: 0 };

  /**
   * 加载并缓存 sourcemap。
   * 找不到时返回 null 而不是抛错——缺 map 只影响可读性，不能阻断整条链路。
   */
  async function loadMap(release, fileName) {
    const safeRelease = String(release || 'unknown').replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
    const safeName = safeFileName(fileName);
    if (!safeName) return null;

    const key = `${safeRelease}/${safeName}`;
    if (cache.has(key)) {
      // 简单的 LRU：命中后挪到末尾
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      stats.hits++;
      return hit;
    }
    stats.misses++;

    try {
      const raw = await fs.readFile(path.join(root, safeRelease, safeName + '.map'), 'utf8');
      const map = new TraceMap(JSON.parse(raw));
      cache.set(key, map);
      if (cache.size > maxCache) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      return map;
    } catch (e) {
      return null;
    }
  }

  /**
   * 符号化一段调用栈。
   *
   * @param {string} release 版本号，必须与构建产物归档时的目录名一致
   * @param {string} stack 归一化后的调用栈（origin 已被去掉）
   * @returns {Promise<string>} 还原后的调用栈；无法还原的帧保持原样
   */
  async function symbolicate(release, stack) {
    const text = String(stack || '');
    if (!text) return '';

    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      const frame = parseFrame(line);
      if (!frame) {
        out.push(line);       // "Error: xxx" 这类首行原样保留
        continue;
      }

      stats.frames++;
      // 从 URL 里只取文件名：/static/js/main.a1b2.js?v=1 → main.a1b2.js
      const fileName = frame.url.split('/').pop().split('?')[0].split('#')[0];
      if (!/\.js$/.test(fileName)) {
        out.push(line);       // 不是 js（可能是 <anonymous> 或 native），跳过
        continue;
      }

      const map = await loadMap(release, fileName);
      if (!map) {
        out.push(line);       // 没有对应 map，原样返回
        continue;
      }

      const pos = originalPositionFor(map, {
        line: frame.line,
        column: frame.column,
      });

      if (!pos || !pos.source) {
        out.push(line);       // 该位置没有映射信息
        continue;
      }

      stats.mapped++;
      // 去掉 webpack 的协议前缀，只保留可读路径
      const src = pos.source.replace(/^webpack:\/\/[^/]*\//, '');
      const name = pos.name || frame.fn || '<anonymous>';
      out.push(`    at ${name} (${src}:${pos.line}:${pos.column})`);
    }

    return out.join('\n');
  }

  /**
   * 批量符号化一组事件。
   * 同时处理 js 的 stack 和接口的 originStack，返回事件副本（不修改原对象）。
   *
   * @param {string} release
   * @param {Array<object>} events
   */
  async function symbolicateEvents(release, events) {
    const out = [];
    for (const ev of events || []) {
      const copy = { ...ev };
      if (ev.stack) copy.stack = await symbolicate(release, ev.stack);
      if (ev.originStack) copy.originStack = await symbolicate(release, ev.originStack);
      out.push(copy);
    }
    return out;
  }

  return {
    symbolicate,
    symbolicateEvents,
    loadMap,
    safeFileName,
    stats,
    clearCache: () => cache.clear(),
  };
}

export default createSymbolicator;
