import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const result = { root: '', output: '', mtime: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--root') result.root = argv[++index];
    else if (option === '--output') result.output = argv[++index];
    else if (option === '--mtime') result.mtime = argv[++index];
    else throw new Error(`Unknown argument: ${option}`);
  }
  if (!result.root || !result.output) throw new Error('--root and --output are required');
  return result;
}

function writeOctal(buffer, offset, length, value) {
  const text = `${Math.max(0, Number(value)).toString(8).padStart(length - 1, '0')}\0`;
  buffer.write(text.slice(-length), offset, length, 'ascii');
}

function writeText(buffer, offset, length, value) {
  buffer.write(String(value || '').slice(0, length), offset, length, 'utf8');
}

function tarPath(value) {
  const original = String(value || '');
  const trailingSlash = original.endsWith('/');
  const name = trailingSlash ? original.replace(/\/+$/, '') : original;
  const suffixFor = suffix => trailingSlash ? `${suffix}/` : suffix;
  if (Buffer.byteLength(suffixFor(name), 'utf8') <= 100) return { name: suffixFor(name), prefix: '' };
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    const archiveSuffix = suffixFor(suffix);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(archiveSuffix, 'utf8') <= 100) {
      return { name: archiveSuffix, prefix };
    }
  }
  throw new Error(`Archive path is too long for ustar: ${name}`);
}

function tarHeader(name, size, mode, type, mtime) {
  const header = Buffer.alloc(512, 0);
  const parts = tarPath(name);
  writeText(header, 0, 100, parts.name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeText(header, 257, 6, 'ustar');
  writeText(header, 263, 2, '00');
  writeText(header, 265, 32, 'root');
  writeText(header, 297, 32, 'wheel');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeText(header, 345, 155, parts.prefix);
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function padded(value) {
  const remainder = value.length % 512;
  return remainder ? Buffer.concat([value, Buffer.alloc(512 - remainder)]) : value;
}

function collectEntries(root) {
  const entries = [];
  const walk = relative => {
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in the macOS payload: ${relative}`);
    const normalized = relative.replaceAll(path.sep, '/');
    entries.push({ absolute, relative: normalized, stats });
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) walk(path.join(relative, child));
    }
  };
  walk('');
  return entries;
}

function modeFor(entry, archiveName) {
  if (entry.stats.isDirectory()) return 0o755;
  if (
    archiveName.endsWith('/Contents/MacOS/CodexCCSwitchUsage')
    || archiveName.endsWith('/Contents/Resources/stop-host.command')
    || archiveName.endsWith('/Contents/Resources/runtime-bin/node')
  ) return 0o755;
  return 0o644;
}

export function createMacosArchive(root, output, options = {}) {
  const absoluteRoot = path.resolve(root);
  const entries = collectEntries(absoluteRoot);
  const prefix = path.basename(absoluteRoot).replaceAll('\\', '/');
  const configuredMtime = options.mtime ?? process.env.SOURCE_DATE_EPOCH ?? 0;
  const mtime = Number(configuredMtime);
  if (!Number.isSafeInteger(mtime) || mtime < 0) throw new Error('Archive mtime must be a non-negative integer');
  const chunks = [];
  for (const entry of entries) {
    const archiveName = entry.relative ? `${prefix}/${entry.relative}` : `${prefix}/`;
    const name = entry.stats.isDirectory() ? `${archiveName.replace(/\/+$/, '')}/` : archiveName;
    const content = entry.stats.isDirectory() ? Buffer.alloc(0) : fs.readFileSync(entry.absolute);
    chunks.push(tarHeader(name, content.length, modeFor(entry, archiveName), entry.stats.isDirectory() ? '5' : '0', mtime));
    if (!entry.stats.isDirectory()) chunks.push(padded(content));
  }
  chunks.push(Buffer.alloc(1024));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    createMacosArchive(args.root, args.output, { mtime: args.mtime === '' ? undefined : Number(args.mtime) });
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
