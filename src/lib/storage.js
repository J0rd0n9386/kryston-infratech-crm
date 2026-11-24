/**
 * Storage Provider Interface and Implementations.
 *
 * Supports local disk storage by default (stored outside /public in data/attachments),
 * with documented provider stubs for AWS S3 and Supabase Storage.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Base interface for storage providers.
 */
class StorageProvider {
  /**
   * Save a file buffer to storage.
   * @param {Object} params
   * @param {Buffer} params.buffer File contents
   * @param {string} params.storedName Unique stored filename
   * @param {string} params.mimeType MIME type of file
   * @returns {Promise<{ storedName: string, pathOrKey: string, size: number }>}
   */
  async save({ buffer, storedName, mimeType }) {
    throw new Error('save() must be implemented by storage provider');
  }

  /**
   * Read a file from storage.
   * @param {string} storedName Unique stored filename
   * @returns {Promise<Buffer>}
   */
  async read(storedName) {
    throw new Error('read() must be implemented by storage provider');
  }

  /**
   * Delete a file from storage.
   * @param {string} storedName Unique stored filename
   * @returns {Promise<boolean>}
   */
  async delete(storedName) {
    throw new Error('delete() must be implemented by storage provider');
  }

  /**
   * Check if a file exists in storage.
   * @param {string} storedName Unique stored filename
   * @returns {Promise<boolean>}
   */
  async exists(storedName) {
    throw new Error('exists() must be implemented by storage provider');
  }
}

/**
 * Local disk storage provider.
 * Stores files outside /public, under `data/attachments/` by default.
 */
class LocalDiskProvider extends StorageProvider {
  constructor(options = {}) {
    super();
    this.baseDir = options.baseDir || config.attachmentStorageDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  _resolveSafePath(storedName) {
    const safeName = path.basename(String(storedName || '').trim());
    if (!safeName || safeName === '.' || safeName === '..') {
      throw new Error('Invalid stored filename');
    }
    const resolved = path.join(this.baseDir, safeName);
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  async save({ buffer, storedName, mimeType }) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('buffer must be a Node.js Buffer');
    }
    const targetPath = this._resolveSafePath(storedName);
    await fs.promises.writeFile(targetPath, buffer, { flag: 'wx' });
    return {
      storedName,
      pathOrKey: targetPath,
      size: buffer.length,
    };
  }

  async read(storedName) {
    const targetPath = this._resolveSafePath(storedName);
    if (!fs.existsSync(targetPath)) {
      const err = new Error('File not found in storage');
      err.code = 'ENOENT';
      throw err;
    }
    return fs.promises.readFile(targetPath);
  }

  async delete(storedName) {
    const targetPath = this._resolveSafePath(storedName);
    if (fs.existsSync(targetPath)) {
      await fs.promises.unlink(targetPath);
      return true;
    }
    return false;
  }

  async exists(storedName) {
    const targetPath = this._resolveSafePath(storedName);
    return fs.existsSync(targetPath);
  }
}

/**
 * AWS S3 Storage Provider Stub.
 *
 * For production cloud deployments, install `@aws-sdk/client-s3`:
 *
 * ```javascript
 * const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
 *
 * class S3Provider extends StorageProvider {
 *   constructor(options = {}) {
 *     super();
 *     this.bucket = options.bucket || process.env.AWS_S3_BUCKET;
 *     this.client = new S3Client({
 *       region: options.region || process.env.AWS_REGION || 'ap-south-1',
 *       credentials: {
 *         accessKeyId: options.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
 *         secretAccessKey: options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY,
 *       },
 *     });
 *   }
 *
 *   async save({ buffer, storedName, mimeType }) {
 *     const command = new PutObjectCommand({
 *       Bucket: this.bucket,
 *       Key: storedName,
 *       Body: buffer,
 *       ContentType: mimeType,
 *     });
 *     await this.client.send(command);
 *     return { storedName, pathOrKey: `s3://${this.bucket}/${storedName}`, size: buffer.length };
 *   }
 *
 *   async read(storedName) {
 *     const command = new GetObjectCommand({ Bucket: this.bucket, Key: storedName });
 *     const response = await this.client.send(command);
 *     const stream = response.Body;
 *     const chunks = [];
 *     for await (const chunk of stream) chunks.push(chunk);
 *     return Buffer.concat(chunks);
 *   }
 *
 *   async delete(storedName) {
 *     const command = new DeleteObjectCommand({ Bucket: this.bucket, Key: storedName });
 *     await this.client.send(command);
 *     return true;
 *   }
 *
 *   async exists(storedName) {
 *     try {
 *       const command = new HeadObjectCommand({ Bucket: this.bucket, Key: storedName });
 *       await this.client.send(command);
 *       return true;
 *     } catch (err) {
 *       if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
 *       throw err;
 *     }
 *   }
 * }
 * ```
 */
class S3ProviderStub extends StorageProvider {
  constructor(options = {}) {
    super();
    this.bucket = options.bucket || 'kryston-crm-attachments';
  }

  async save() {
    throw new Error('S3Provider is not configured. Set STORAGE_PROVIDER=local or install @aws-sdk/client-s3.');
  }

  async read() {
    throw new Error('S3Provider is not configured.');
  }

  async delete() {
    throw new Error('S3Provider is not configured.');
  }

  async exists() {
    throw new Error('S3Provider is not configured.');
  }
}

/**
 * Supabase Storage Provider Stub.
 *
 * For Supabase object storage deployments, install `@supabase/storage-js`:
 *
 * ```javascript
 * const { StorageClient } = require('@supabase/storage-js');
 *
 * class SupabaseStorageProvider extends StorageProvider {
 *   constructor(options = {}) {
 *     super();
 *     this.bucket = options.bucket || process.env.SUPABASE_STORAGE_BUCKET || 'attachments';
 *     this.client = new StorageClient(
 *       options.url || process.env.SUPABASE_URL,
 *       { apikey: options.serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY }
 *     );
 *   }
 *
 *   async save({ buffer, storedName, mimeType }) {
 *     const { data, error } = await this.client
 *       .from(this.bucket)
 *       .upload(storedName, buffer, { contentType: mimeType, upsert: false });
 *     if (error) throw error;
 *     return { storedName, pathOrKey: data.path, size: buffer.length };
 *   }
 *
 *   async read(storedName) {
 *     const { data, error } = await this.client.from(this.bucket).download(storedName);
 *     if (error) throw error;
 *     return Buffer.from(await data.arrayBuffer());
 *   }
 *
 *   async delete(storedName) {
 *     const { error } = await this.client.from(this.bucket).remove([storedName]);
 *     return !error;
 *   }
 * }
 * ```
 */
class SupabaseStorageProviderStub extends StorageProvider {
  constructor(options = {}) {
    super();
    this.bucket = options.bucket || 'attachments';
  }

  async save() {
    throw new Error('SupabaseStorageProvider is not configured.');
  }

  async read() {
    throw new Error('SupabaseStorageProvider is not configured.');
  }

  async delete() {
    throw new Error('SupabaseStorageProvider is not configured.');
  }

  async exists() {
    throw new Error('SupabaseStorageProvider is not configured.');
  }
}

let defaultProviderInstance = null;

function createStorageProvider(options = {}) {
  const type = (options.type || process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  switch (type) {
    case 's3':
      return new S3ProviderStub(options);
    case 'supabase':
      return new SupabaseStorageProviderStub(options);
    case 'local':
    default:
      return new LocalDiskProvider(options);
  }
}

function getDefaultStorageProvider() {
  if (!defaultProviderInstance) {
    defaultProviderInstance = createStorageProvider();
  }
  return defaultProviderInstance;
}

module.exports = {
  StorageProvider,
  LocalDiskProvider,
  S3ProviderStub,
  SupabaseStorageProviderStub,
  createStorageProvider,
  getDefaultStorageProvider,
};
