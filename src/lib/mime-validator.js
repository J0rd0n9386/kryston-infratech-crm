/**
 * MIME type validation and magic bytes detection for attachments.
 *
 * Enforces allowed extensions: pdf, jpg, jpeg, png, webp, xlsx, docx.
 * Sniffs the initial magic bytes of the file buffer to prevent spoofed extensions
 * (e.g. executable or text file renamed to .pdf).
 */
'use strict';

const path = require('path');
const config = require('../config');
const { ValidationError } = require('../middleware/errors');

const ALLOWED_EXTENSIONS = Object.freeze([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'xlsx',
  'docx',
]);

const EXTENSION_TO_MIME = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

/**
 * Sniff file format from initial magic bytes.
 * @param {Buffer} buffer
 * @returns {string|null} Detected format key ('pdf', 'jpg', 'png', 'webp', 'zip/openxml')
 */
function sniffFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // PDF: %PDF (0x25, 0x50, 0x44, 0x46)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return 'pdf';
  }

  // JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // WebP: RIFF at 0..3 and WEBP at 8..11
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }

  // ZIP / OpenXML (docx, xlsx): PK\x03\x04 or PK\x05\x06 or PK\x07\x08
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return 'openxml';
  }

  return null;
}

/**
 * Validate an attachment buffer against allowed size, extension and magic bytes.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer File contents
 * @param {string} params.filename Original filename
 * @param {string} [params.claimedMimeType] Claimed MIME type
 * @param {number} [params.maxBytes] Max size cap in bytes
 * @returns {{ extension: string, mimeType: string, size: number }}
 */
function validateAttachment({ buffer, filename, claimedMimeType = '', maxBytes = null }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('The attachment file is empty or missing.');
  }

  const sizeLimit = maxBytes && maxBytes > 0 ? maxBytes : config.attachmentMaxSize;
  if (buffer.length > sizeLimit) {
    const limitMb = Math.round(sizeLimit / (1024 * 1024));
    throw new ValidationError(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed limit of ${limitMb} MB.`,
    );
  }

  const rawExt = path.extname(String(filename || '')).toLowerCase().replace(/^\./, '');
  if (!rawExt || !ALLOWED_EXTENSIONS.includes(rawExt)) {
    throw new ValidationError(
      `File extension ".${rawExt || 'unknown'}" is not allowed. Supported formats: ${ALLOWED_EXTENSIONS.join(', ')}.`,
    );
  }

  const detectedFormat = sniffFormat(buffer);
  if (!detectedFormat) {
    throw new ValidationError(
      `Spoofed file extension: file content does not match the claimed .${rawExt} format.`,
    );
  }

  // Verify sniffed magic bytes match the claimed extension
  const isJpgMatch = (rawExt === 'jpg' || rawExt === 'jpeg') && detectedFormat === 'jpg';
  const isPngMatch = rawExt === 'png' && detectedFormat === 'png';
  const isPdfMatch = rawExt === 'pdf' && detectedFormat === 'pdf';
  const isWebpMatch = rawExt === 'webp' && detectedFormat === 'webp';
  const isOpenXmlMatch = (rawExt === 'xlsx' || rawExt === 'docx') && detectedFormat === 'openxml';

  if (!isJpgMatch && !isPngMatch && !isPdfMatch && !isWebpMatch && !isOpenXmlMatch) {
    throw new ValidationError(
      `Spoofed file extension: file content does not match the .${rawExt} extension.`,
    );
  }

  const canonicalMime = EXTENSION_TO_MIME[rawExt] || 'application/octet-stream';

  return {
    extension: rawExt,
    mimeType: canonicalMime,
    size: buffer.length,
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  EXTENSION_TO_MIME,
  sniffFormat,
  validateAttachment,
};
