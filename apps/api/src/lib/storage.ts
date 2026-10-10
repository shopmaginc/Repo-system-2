import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config.js';

/**
 * File storage abstraction.
 *
 * The API never serves uploads as static files and never builds public
 * URLs — every download goes through an authenticated GET endpoint, which
 * reads the bytes back through this interface. Two backends, selected by
 * `STORAGE_BACKEND`:
 *
 * - `local` (default): disk under UPLOADS_DIR, files written 0o640.
 *   Dev/test and single-instance hosting.
 * - `s3`: S3-compatible object storage via @aws-sdk/client-s3. Works for
 *   Cloudflare R2 (S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com,
 *   S3_REGION=auto). The bucket stays private — no public access, ever.
 */

/** Thrown when a stored object does not exist. Routes map it to HTTP 404. */
export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** Upload body: buffered in memory, or streamed straight from the request. */
export type StorageBody = Buffer | NodeJS.ReadableStream;

export interface Storage {
  put(key: string, body: StorageBody, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * Key rules. Keys are server-generated (`<caseId>/<uuid>.<ext>`,
 * `msg/<uuid>.<ext>`), but case ids flow through the database — so every
 * key is validated: relative, no `..` segments, no backslashes, sane
 * charset and length. Rejects anything that could escape the store.
 */
export function sanitizeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new Error('Invalid storage key');
  }
  if (key.startsWith('/') || key.includes('\\') || /(^|\/)\.\.(\/|$)/.test(key)) {
    throw new Error('Invalid storage key');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) {
    throw new Error('Invalid storage key');
  }
  return key;
}

function toReadable(body: StorageBody): NodeJS.ReadableStream {
  if (Buffer.isBuffer(body)) return Readable.from(body);
  return body;
}

/**
 * Local disk backend — dev/test default. Files land under the uploads dir
 * with mode 0o640 (owner read/write, group read, nothing for others).
 */
export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(uploadsDir: string) {
    this.root = path.resolve(uploadsDir);
  }

  /** Resolve a key to an absolute path, refusing anything outside the root. */
  private abs(key: string): string {
    const safe = sanitizeKey(key);
    const abs = path.resolve(this.root, safe);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return abs;
  }

  async put(key: string, body: StorageBody, _mimeType: string): Promise<void> {
    const abs = this.abs(key);
    await mkdir(path.dirname(abs), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await writeFile(abs, body, { mode: 0o640 });
    } else {
      await pipeline(toReadable(body), createWriteStream(abs, { mode: 0o640 }));
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.abs(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.abs(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.abs(key));
      return true;
    } catch {
      return false;
    }
  }
}

export interface S3StorageOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * S3-compatible backend (AWS S3, Cloudflare R2, ...). The bucket is
 * private — objects are only ever read back through the API's
 * authenticated download endpoints, never via public URLs.
 */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region || 'auto',
      endpoint: opts.endpoint,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  async put(key: string, body: StorageBody, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sanitizeKey(key),
        Body: toReadable(body) as unknown as Readable,
        ContentType: mimeType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const safe = sanitizeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: safe }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err: unknown) {
      if (
        (err as { name?: string })?.name === 'NoSuchKey' ||
        (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
      ) {
        throw new StorageNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
      );
      return true;
    } catch (err: unknown) {
      if (
        (err as { name?: string })?.name === 'NotFound' ||
        (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw err;
    }
  }
}

/** Build the configured backend. Throws with a clear message when S3 is misconfigured. */
export function createStorage(config: AppConfig): Storage {
  if (config.STORAGE_BACKEND === 's3') {
    const missing = (
      [
        ['S3_ENDPOINT', config.S3_ENDPOINT],
        ['S3_BUCKET', config.S3_BUCKET],
        ['S3_ACCESS_KEY_ID', config.S3_ACCESS_KEY_ID],
        ['S3_SECRET_ACCESS_KEY', config.S3_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_BACKEND=s3 requires: ${missing.join(', ')}`,
      );
    }
    return new S3Storage({
      endpoint: config.S3_ENDPOINT!,
      bucket: config.S3_BUCKET!,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      region: config.S3_REGION ?? 'auto',
    });
  }
  // UPLOADS_DIR has a schema default, but callers that build AppConfig by
  // hand (tests) may omit it — fall back to the same default here.
  return new LocalStorage(config.UPLOADS_DIR ?? './uploads');
}
