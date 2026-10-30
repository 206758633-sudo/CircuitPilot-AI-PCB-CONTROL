/**
 * 从本机 DSH 安装包（app.asar）中只读解包官方 MCP client SDK，供独立复验使用。
 *
 * 依据 task-22 要求：使用 DSH 内置的 @modelcontextprotocol/client@2.2.0 官方
 * Client + StdioClientTransport 直连 agent/mcp-server.mjs，不给仓库安装任何依赖。
 *
 * 做法：解析 asar 头 → 从 dsh/node_modules 静态解析 client 的依赖闭包 →
 * 把闭包解包到系统临时目录 → 动态 import 官方 dist 入口。
 * 不访问网络、不写仓库；临时目录在 cleanup() 时删除。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const ASAR_HEADER_PREFIX = 16;
const SDK_PACKAGE = '@modelcontextprotocol/client';

/** 默认 DSH 安装路径（可用 DSH_ASAR 环境变量覆盖）。 */
export const DEFAULT_ASAR_CANDIDATES = Object.freeze([
  process.env.DSH_ASAR,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
]);

function isFileEntry(entry) {
  return entry && typeof entry === 'object' && !entry.link;
}

/** 解析 asar 头，返回路径 -> 条目信息。 */
export function readAsarIndex(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(ASAR_HEADER_PREFIX);
    if (readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) {
      throw new Error(`asar 文件过短：${asarPath}`);
    }
    const headerJsonSize = prefix.readUInt32LE(12);
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonStart = ASAR_HEADER_PREFIX;
    const jsonBuffer = Buffer.alloc(headerJsonSize);
    if (readSync(fd, jsonBuffer, 0, headerJsonSize, jsonStart) !== headerJsonSize) {
      throw new Error('asar 头 JSON 读取不完整');
    }
    const header = JSON.parse(jsonBuffer.toString('utf8'));
    const dataOffset = 8 + headerPickleSize;
    const files = new Map();
    const visit = (relativePath, node) => {
      if (!node || typeof node !== 'object') return;
      if (node.files) {
        for (const [name, child] of Object.entries(node.files)) {
          visit(relativePath ? posix.join(relativePath, name) : name, child);
        }
        return;
      }
      if (isFileEntry(node) && typeof node.offset === 'string') {
        files.set(relativePath, {
          size: Number(node.size),
          offset: Number(node.offset),
          unpacked: node.unpacked === true,
        });
      }
    };
    for (const [name, child] of Object.entries(header.files || {})) visit(name, child);
    return { header, files, dataOffset, asarPath };
  } finally {
    closeSync(fd);
  }
}

/** 从 asar 索引里读取 UTF-8 文本文件。 */
export function readAsarText(asarPath, dataOffset, files, filePath) {
  const entry = files.get(filePath);
  if (!entry) throw new Error(`asar 内不存在：${filePath}`);
  if (entry.unpacked) {
    return readFileSync(join(`${asarPath}.unpacked`, filePath), 'utf8');
  }
  const fd = openSync(asarPath, 'r');
  try {
    const buffer = Buffer.alloc(entry.size);
    if (readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset) !== entry.size) {
      throw new Error(`asar 文件读取不完整：${filePath}`);
    }
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const packageJsonCache = new Map();

function readAsarPackageJson(asarPath, dataOffset, files, packageDir) {
  const key = `${asarPath}:${packageDir}`;
  if (!packageJsonCache.has(key)) {
    const filePath = packageDir ? `${packageDir}/package.json` : 'package.json';
    const parsed = JSON.parse(readAsarText(asarPath, dataOffset, files, filePath));
    packageJsonCache.set(key, parsed);
  }
  return packageJsonCache.get(key);
}

const dirExistsInIndex = (files, packageDir) => files.has(`${packageDir}/package.json`);

/** 从 fromDir 向上查找名为 name 的包目录（Node 语义）。 */
function resolvePackageDirInIndex(files, name, fromDir) {
  const segments = fromDir.split('/').filter(Boolean);
  for (let i = segments.length; i >= 0; i -= 1) {
    const base = segments.slice(0, i).join('/');
    if (!base) break;
    const candidate = `${base}/node_modules/${name}`;
    if (dirExistsInIndex(files, candidate)) return candidate;
  }
  const hoisted = `dsh/node_modules/${name}`;
  return dirExistsInIndex(files, hoisted) ? hoisted : null;
}

/**
 * 静态解析 client 的依赖闭包（只依赖 asar 内的 package.json dependency 字段）。
 * 同时保留嵌套 node_modules 布局：每个包放在其解析到的真实目录。
 */
export function resolveDependencyClosure(asarPath, dataOffset, files) {
  const rootDir = 'dsh/node_modules/@modelcontextprotocol/client';
  if (!dirExistsInIndex(files, rootDir)) {
    throw new Error(`DSH asar 内找不到 ${SDK_PACKAGE}（期望 ${rootDir}）`);
  }
  const dirs = new Set();
  const queue = [{ dir: rootDir, name: SDK_PACKAGE }];
  const visited = new Set();
  while (queue.length > 0) {
    const { dir, name } = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);
    dirs.add(dir);
    let pkg;
    try {
      pkg = readAsarPackageJson(asarPath, dataOffset, files, dir);
    } catch (error) {
      throw new Error(`读取 ${dir}/package.json 失败：${error.message}`);
    }
    const dependencies = {
      ...(pkg.dependencies || {}),
      ...(pkg.optionalDependencies || {}),
    };
    for (const depName of Object.keys(dependencies)) {
      const resolved = resolvePackageDirInIndex(files, depName, dir);
      if (!resolved) {
        throw new Error(`无法在 asar 内解析依赖 ${depName}（from ${dir}，package=${name}）`);
      }
      if (!visited.has(resolved)) queue.push({ dir: resolved, name: depName });
    }
  }
  // 父目录优先，避免嵌套包被重复解包（父包已覆盖子目录内容）。
  return [...dirs].sort((a, b) => a.length - b.length);
}

async function extractPackageDirs({ asarPath, dataOffset, files, dirs, destRoot }) {
  const copied = new Set();
  let fileCount = 0;
  let byteCount = 0;
  const asarFd = openSync(asarPath, 'r');
  try {
    for (const dir of dirs) {
      if ([...copied].some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`))) continue;
      copied.add(dir);
      for (const [filePath, entry] of files) {
        if (filePath !== dir && !filePath.startsWith(`${dir}/`)) continue;
        const relativeInsideNodeModules = filePath.startsWith('dsh/node_modules/')
          ? filePath.slice('dsh/node_modules/'.length)
          : filePath;
        const target = join(destRoot, 'node_modules', ...relativeInsideNodeModules.split('/'));
        let buffer;
        if (entry.unpacked) {
          buffer = readFileSync(join(`${asarPath}.unpacked`, filePath));
        } else {
          buffer = Buffer.alloc(entry.size);
          if (readSync(asarFd, buffer, 0, entry.size, dataOffset + entry.offset) !== entry.size) {
            throw new Error(`解包失败（读取不完整）：${filePath}`);
          }
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, buffer);
        fileCount += 1;
        byteCount += buffer.length;
      }
    }
  } finally {
    closeSync(asarFd);
  }
  return { fileCount, byteCount };
}

function locateAsar() {
  if (process.env.DSH_MCP_SDK_DIR) return { sdkDir: process.env.DSH_MCP_SDK_DIR, temp: false };
  for (const candidate of DEFAULT_ASAR_CANDIDATES) {
    if (candidate && existsSync(candidate)) return { asarPath: candidate, temp: true };
  }
  throw new Error(
    `找不到 DSH 安装包 app.asar。用 DSH_ASAR=/path/to/app.asar 覆盖，或用 DSH_MCP_SDK_DIR 指向已解包的 node_modules 根目录。候选：${DEFAULT_ASAR_CANDIDATES.filter(Boolean).join(', ')}`,
  );
}

const sdkCache = { promise: null };

/**
 * 加载官方 MCP SDK（带进程内缓存）。
 * @returns {Promise<{
 *   client: any, stdio: any, core: any, clientVersion: string, coreVersion: string,
 *   supportedProtocolVersions: string[], root: string, temp: boolean,
 *   extraction: {fileCount:number,byteCount:number}|null, cleanup: () => Promise<void>,
 * }>}
 */
export async function loadDshSdk() {
  if (!sdkCache.promise) {
    sdkCache.promise = (async () => {
      const located = locateAsar();
      let root;
      let temp = false;
      let extraction = null;
      if (located.sdkDir) {
        root = located.sdkDir;
        if (!existsSync(join(root, 'node_modules', SDK_PACKAGE, 'package.json'))) {
          throw new Error(`DSH_MCP_SDK_DIR 下找不到 node_modules/${SDK_PACKAGE}`);
        }
      } else {
        const index = readAsarIndex(located.asarPath);
        const dirs = resolveDependencyClosure(located.asarPath, index.dataOffset, index.files);
        root = await mkdtemp(join(tmpdir(), 'dsh-mcp-sdk-'));
        extraction = await extractPackageDirs({
          asarPath: located.asarPath,
          dataOffset: index.dataOffset,
          files: index.files,
          dirs,
          destRoot: root,
        });
        temp = true;
        const marker = {
          source: located.asarPath,
          extractedAt: new Date().toISOString(),
          packages: dirs,
          ...extraction,
        };
        await writeFile(join(root, 'extraction.json'), `${JSON.stringify(marker, null, 2)}\n`);
      }

      const clientDir = join(root, 'node_modules', ...SDK_PACKAGE.split('/'));
      const coreDir = join(root, 'node_modules', '@modelcontextprotocol', 'core');
      const clientIndex = pathToFileURL(join(clientDir, 'dist', 'index.mjs')).href;
      const clientStdio = pathToFileURL(join(clientDir, 'dist', 'stdio.mjs')).href;
      const coreIndex = pathToFileURL(join(coreDir, 'dist', 'index.mjs')).href;
      const clientPkg = JSON.parse(await readFile(join(clientDir, 'package.json'), 'utf8'));
      const corePkg = JSON.parse(await readFile(join(coreDir, 'package.json'), 'utf8'));
      const client = await import(clientIndex);
      const stdio = await import(clientStdio);
      const core = await import(coreIndex);
      if (typeof client.Client !== 'function') throw new Error('官方 SDK 未导出 Client');
      if (typeof stdio.StdioClientTransport !== 'function') throw new Error('官方 SDK 未导出 StdioClientTransport');

      return {
        client,
        stdio,
        core,
        clientVersion: clientPkg.version,
        coreVersion: corePkg.version,
        supportedProtocolVersions: [...(client.SUPPORTED_PROTOCOL_VERSIONS || [])],
        latestProtocolVersion: client.LATEST_PROTOCOL_VERSION,
        defaultNegotiatedProtocolVersion: client.DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
        root,
        temp,
        extraction,
        cleanup: async () => {
          if (temp) await rm(root, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    })();
  }
  return sdkCache.promise;
}
