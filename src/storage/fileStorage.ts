import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The seam for file storage. Swap the implementation for S3 or GCS later without touching
 * callers. Returns a storage key or URL that is later handed to VeriPura core as poFileUrl.
 */
export interface FileStorage {
  uploadFile(buffer: Buffer, filename: string): Promise<string>;
}

/** Reduces a client-supplied filename to a safe basename: no directories, no odd characters. */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]+/g, "_");
  const trimmed = base.replace(/^\.+/, "").slice(-120);
  return trimmed || "file";
}

/** Local-sandbox storage: writes under STORAGE_DIR (default ./.storage) and returns a local:// key. */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly dir: string = process.env.STORAGE_DIR ?? ".storage") {}

  async uploadFile(buffer: Buffer, filename: string): Promise<string> {
    const key = `${randomUUID()}-${sanitizeFilename(filename)}`;
    const root = path.resolve(this.dir);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, key), buffer);
    return `local://${key}`;
  }
}

/** In-memory storage for tests. */
export class InMemoryFileStorage implements FileStorage {
  readonly files = new Map<string, Buffer>();

  async uploadFile(buffer: Buffer, filename: string): Promise<string> {
    const url = `memory://${randomUUID()}-${sanitizeFilename(filename)}`;
    this.files.set(url, buffer);
    return url;
  }
}

let storage: FileStorage | undefined;

export function getFileStorage(): FileStorage {
  storage ??= new LocalFileStorage();
  return storage;
}

/** Test hook and production swap point. Pass undefined to return to the local default. */
export function setFileStorage(next: FileStorage | undefined): void {
  storage = next;
}

/** The stage's stable entry point, matching the prompt's `uploadFile(buffer, filename)`. */
export function uploadFile(buffer: Buffer, filename: string): Promise<string> {
  return getFileStorage().uploadFile(buffer, filename);
}
