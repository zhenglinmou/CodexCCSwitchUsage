import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const atomicWriteChains = new Map();

function chmodSync(filename, mode) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(filename, mode); } catch {}
}

function temporaryPath(filename) {
  return `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

async function chmod(filename, mode) {
  if (process.platform === 'win32') return;
  try { await fs.promises.chmod(filename, mode); } catch {}
}

export function secureMkdirSync(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

export async function secureMkdir(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

export function secureWriteFileSync(filename, data, options = {}) {
  secureMkdirSync(path.dirname(filename));
  fs.writeFileSync(filename, data, { ...options, mode: PRIVATE_FILE_MODE });
  chmodSync(filename, PRIVATE_FILE_MODE);
}

export function secureCreateFileSync(filename, data, options = {}) {
  secureMkdirSync(path.dirname(filename));
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(filename, 'wx', PRIVATE_FILE_MODE);
    created = true;
    fs.writeFileSync(descriptor, data, options);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    return true;
  } catch (error) {
    if (!created && error?.code === 'EEXIST') return false;
    if (created) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = undefined;
      }
      try { fs.rmSync(filename, { force: true }); } catch {}
    }
    throw error;
  } finally {
    if (descriptor != null) try { fs.closeSync(descriptor); } catch {}
  }
}

export function secureAtomicWriteFileSync(filename, data, options = {}) {
  secureMkdirSync(path.dirname(filename));
  const temporary = temporaryPath(filename);
  try {
    fs.writeFileSync(temporary, data, { ...options, mode: PRIVATE_FILE_MODE });
    chmodSync(temporary, PRIVATE_FILE_MODE);
    fs.renameSync(temporary, filename);
    chmodSync(filename, PRIVATE_FILE_MODE);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

async function atomicWriteFileUnqueued(filename, data, options) {
  await secureMkdir(path.dirname(filename));
  const temporary = temporaryPath(filename);
  try {
    await fs.promises.writeFile(temporary, data, { ...options, mode: PRIVATE_FILE_MODE });
    await chmod(temporary, PRIVATE_FILE_MODE);
    await fs.promises.rename(temporary, filename);
    await chmod(filename, PRIVATE_FILE_MODE);
  } catch (error) {
    try { await fs.promises.rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

export async function secureAtomicWriteFile(filename, data, options = {}) {
  const key = path.resolve(filename);
  const previous = atomicWriteChains.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => atomicWriteFileUnqueued(filename, data, options));
  atomicWriteChains.set(key, operation);
  try {
    await operation;
  } finally {
    if (atomicWriteChains.get(key) === operation) atomicWriteChains.delete(key);
  }
}

export function secureOpenAppendSync(filename) {
  secureMkdirSync(path.dirname(filename));
  const descriptor = fs.openSync(filename, 'a', PRIVATE_FILE_MODE);
  chmodSync(filename, PRIVATE_FILE_MODE);
  return descriptor;
}
