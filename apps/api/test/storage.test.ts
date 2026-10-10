import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  LocalStorage,
  S3Storage,
  StorageNotFoundError,
  createStorage,
  sanitizeKey,
} from '../src/lib/storage.js';

/**
 * Deploy-prep storage tests. Proves: the backend is selected from env
 * (local default, s3 when asked), S3 misconfiguration fails fast without
 * touching the network, keys can't escape the store (path traversal is
 * rejected), and the local backend keeps its existing behavior
 * (put/get/delete round-trip, 0o640 file mode, missing → NotFound).
 */

const baseConfig = {
  DATABASE_URL: 'postgres://localhost:5432/test',
  JWT_SECRET: 'test-secret-that-is-long-enough-for-config',
  UPLOADS_DIR: mkdtempSync(join(tmpdir(), 'storage-test-')),
  MAX_UPLOAD_MB: 25,
} as const;

describe('sanitizeKey', () => {
  it('accepts server-generated keys', () => {
    expect(sanitizeKey('case-123/550e8400-e29b-41d4-a716-446655440000.jpg')).toContain('case-123/');
    expect(sanitizeKey('msg/550e8400-e29b-41d4-a716-446655440000.png')).toContain('msg/');
  });

  it.each([
    '../evil.jpg',
    'case/../../evil.jpg',
    '/absolute/path.jpg',
    'case\\windows.jpg',
    '..',
    '',
    'has space.jpg',
  ])('rejects %j', (key) => {
    expect(() => sanitizeKey(key)).toThrow('Invalid storage key');
  });
});

describe('createStorage backend selection', () => {
  it('defaults to local disk when STORAGE_BACKEND is unset', () => {
    const s = createStorage({ ...baseConfig });
    expect(s).toBeInstanceOf(LocalStorage);
  });

  it('selects local explicitly', () => {
    const s = createStorage({ ...baseConfig, STORAGE_BACKEND: 'local' });
    expect(s).toBeInstanceOf(LocalStorage);
  });

  it('fails fast when s3 is selected without credentials (no network touched)', () => {
    expect(() => createStorage({ ...baseConfig, STORAGE_BACKEND: 's3' })).toThrow(
      /STORAGE_BACKEND=s3 requires: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
    );
  });

  it('builds an s3 backend from env without network calls', () => {
    const s = createStorage({
      ...baseConfig,
      STORAGE_BACKEND: 's3',
      S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      S3_BUCKET: 'repo-uploads',
      S3_ACCESS_KEY_ID: 'key-id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_REGION: 'auto',
    });
    expect(s).toBeInstanceOf(S3Storage);
  });
});

describe('LocalStorage behavior', () => {
  it('round-trips put/get/delete with buffer and stream bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storage-local-'));
    const s = new LocalStorage(dir);

    await s.put('case-1/a.jpg', Buffer.from('bytes-here'), 'image/jpeg');
    expect((await s.get('case-1/a.jpg')).toString()).toBe('bytes-here');
    expect(await s.exists('case-1/a.jpg')).toBe(true);

    // Streamed body (what the multipart upload hands us).
    await s.put('case-1/b.jpg', Readable.from([Buffer.from('streamed')]), 'image/jpeg');
    expect((await s.get('case-1/b.jpg')).toString()).toBe('streamed');

    await s.delete('case-1/a.jpg');
    expect(await s.exists('case-1/a.jpg')).toBe(false);
    await expect(s.get('case-1/a.jpg')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(s.delete('case-1/a.jpg')).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('writes files with 0o640 permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storage-mode-'));
    const s = new LocalStorage(dir);
    await s.put('case-1/m.jpg', Buffer.from('x'), 'image/jpeg');
    const mode = statSync(join(dir, 'case-1', 'm.jpg')).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it('refuses keys that escape the uploads dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storage-escape-'));
    const s = new LocalStorage(dir);
    await expect(s.put('../evil.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      'Invalid storage key',
    );
    await expect(s.get('case-1/../../etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});
