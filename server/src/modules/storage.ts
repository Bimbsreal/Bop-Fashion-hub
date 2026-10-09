import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { invalid } from "../errors";

export type StoredFile = { key: string; bytes: Buffer };

export type MediaStorage = {
  write(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
};

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;

export function isSafeStorageKey(key: string): boolean {
  return keyPattern.test(key) && !key.includes("..") && !key.startsWith("/") && !key.endsWith("/");
}

export function assertMediaRoot(root: string): string {
  const resolved = path.resolve(root);
  const publicDir = path.resolve("public");
  if (resolved === publicDir || resolved.startsWith(publicDir + path.sep)) {
    throw new Error("Media storage cannot use the public directory.");
  }
  return resolved;
}

export function localMediaStorage(root: string): MediaStorage {
  const base = assertMediaRoot(root);
  return {
    async write(key, bytes) {
      const full = resolveKey(base, key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes, { flag: "wx" });
    },
    async read(key) {
      return readFile(resolveKey(base, key));
    },
    async remove(key) {
      await rm(resolveKey(base, key), { force: true });
    },
  };
}

export async function withStoredFiles<T>(
  storage: MediaStorage,
  files: StoredFile[],
  work: () => Promise<T>,
): Promise<T> {
  const written: string[] = [];
  try {
    for (const file of files) {
      await storage.write(file.key, file.bytes);
      written.push(file.key);
    }
    return await work();
  } catch (error) {
    await Promise.all(written.map((key) => storage.remove(key).catch(() => undefined)));
    throw error;
  }
}

function resolveKey(root: string, key: string): string {
  if (!isSafeStorageKey(key)) throw invalid("invalid_media", "Storage key is not valid.");
  const full = path.resolve(root, key);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalid("invalid_media", "Storage key is not valid.");
  }
  return full;
}
