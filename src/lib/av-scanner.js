/**
 * Antivirus scanning interface and implementations.
 *
 * Provides a hook to scan uploaded files for malware before they are persisted
 * or served. Defaults to a no-op scanner for development/offline environments,
 * with a documented hook interface for production ClamAV (clamd) or cloud scanners.
 */
'use strict';

/**
 * Base Antivirus Scanner interface.
 */
class AntivirusScanner {
  /**
   * Scan a file buffer.
   * @param {Object} params
   * @param {Buffer} params.buffer File contents
   * @param {string} params.filename Original filename
   * @param {string} params.mimeType MIME type
   * @returns {Promise<{ clean: boolean, reason?: string, scanner: string }>}
   */
  async scan({ buffer, filename, mimeType }) {
    throw new Error('scan() must be implemented by AntivirusScanner');
  }
}

/**
 * Default No-op scanner: always reports clean.
 */
class NoopAntivirusScanner extends AntivirusScanner {
  async scan({ buffer, filename, mimeType }) {
    return {
      clean: true,
      reason: 'No malware detected (noop scanner)',
      scanner: 'noop',
    };
  }
}

/**
 * Production ClamAV Scanner Stub.
 *
 * For enterprise production deployments with ClamAV daemon:
 *
 * ```javascript
 * const clamd = require('clamdjs');
 *
 * class ClamAVScanner extends AntivirusScanner {
 *   constructor(options = {}) {
 *     super();
 *     this.host = options.host || process.env.CLAMAV_HOST || '127.0.0.1';
 *     this.port = Number(options.port || process.env.CLAMAV_PORT || 3310);
 *     this.scanner = clamd.createScanner(this.host, this.port);
 *   }
 *
 *   async scan({ buffer, filename }) {
 *     try {
 *       const result = await this.scanner.scanBuffer(buffer, 30000);
 *       const isClean = clamd.isCleanReply(result);
 *       return {
 *         clean: isClean,
 *         reason: isClean ? 'Clean' : result,
 *         scanner: 'clamav',
 *       };
 *     } catch (err) {
 *       // Fail secure or log based on policy
 *       throw new Error(`ClamAV scan error: ${err.message}`);
 *     }
 *   }
 * }
 * ```
 */
class ClamAVScannerStub extends AntivirusScanner {
  async scan() {
    throw new Error('ClamAV scanner is not configured in this environment.');
  }
}

let defaultScannerInstance = null;

function createAntivirusScanner(options = {}) {
  const type = (options.type || process.env.AV_SCANNER || 'noop').toLowerCase();
  switch (type) {
    case 'clamav':
      return new ClamAVScannerStub(options);
    case 'noop':
    default:
      return new NoopAntivirusScanner();
  }
}

function getDefaultAntivirusScanner() {
  if (!defaultScannerInstance) {
    defaultScannerInstance = createAntivirusScanner();
  }
  return defaultScannerInstance;
}

module.exports = {
  AntivirusScanner,
  NoopAntivirusScanner,
  ClamAVScannerStub,
  createAntivirusScanner,
  getDefaultAntivirusScanner,
};
