import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}
const MAGIC = Buffer.from("TZKBACK1");
const FORMAT_VERSION = 1;
const STREAM_FORMAT_VERSION = 2;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type BackupColumn = { name: string; pgType: string };
export type BackupTable = { name: string; primaryKey: string[]; columns: BackupColumn[]; rows: Record<string, string | null>[] };
export type BackupPayload = {
  format: "tezkar-full-backup";
  version: 1;
  createdAt: string;
  sourceSchemaVersion: string | null;
  tables: BackupTable[];
  sequences?: { name: string; lastValue: string; isCalled: boolean; incrementBy: string; minValue: string; maxValue: string; startValue: string; cacheSize: string; cycle: boolean }[];
};
export type BackupHeader = {
  format: "tezkar-full-backup";
  version: 1 | 2;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
};

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 200) {
    throw new Error("كلمة مرور النسخة يجب أن تكون من 12 إلى 200 حرف");
  }
}

function makeHeader(version: 1 | 2): Buffer {
  const header = Buffer.from(JSON.stringify({
    format: "tezkar-full-backup",
    version,
    kdf: "scrypt",
    cipher: "aes-256-gcm"
  } satisfies BackupHeader), "utf8");
  const headerLength = Buffer.alloc(2);
  headerLength.writeUInt16BE(header.length);
  return Buffer.concat([MAGIC, headerLength, header]);
}

export async function createBackupArchive(payload: BackupPayload, password: string): Promise<Buffer> {
  validatePassword(password);
  if (payload.format !== "tezkar-full-backup" || payload.version !== FORMAT_VERSION || !Array.isArray(payload.tables)) {
    throw new Error("بيانات النسخة غير صالحة");
  }
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  if (plaintext.length > MAX_ARCHIVE_BYTES) throw new Error("حجم النسخة أكبر من الحد المسموح حاليًا");
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([makeHeader(FORMAT_VERSION), salt, nonce, tag, encrypted]);
}

/**
 * Encrypt an already-streaming JSON payload without buffering the complete
 * plaintext or ciphertext. Version 2 places the GCM tag at the end so the
 * encrypted body can be emitted as it is produced. Version 1 remains readable.
 */
export function createBackupArchiveStream(
  plaintext: AsyncIterable<string | Buffer>,
  password: string,
  onComplete?: () => Promise<void>
): Readable {
  validatePassword(password);
  return Readable.from((async function* () {
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = await deriveKey(password, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(MAGIC);
    const encryptedOutput = new PassThrough();
    const pipelineTask = pipeline(Readable.from(plaintext), cipher, encryptedOutput);
    let encryptedBytes = 0;
    try {
      yield Buffer.concat([makeHeader(STREAM_FORMAT_VERSION), salt, nonce]);
      for await (const chunk of encryptedOutput) {
        encryptedBytes += chunk.length;
        if (encryptedBytes > MAX_ARCHIVE_BYTES) {
          encryptedOutput.destroy(new Error("حجم النسخة أكبر من الحد المسموح حاليًا"));
          throw new Error("حجم النسخة أكبر من الحد المسموح حاليًا");
        }
        yield chunk;
      }
      await pipelineTask;
      // The archive is not valid until the final GCM tag is emitted. Complete
      // the audit before exposing that tag, so an audit failure leaves an
      // intentionally unreadable/incomplete download rather than an unaudited backup.
      await onComplete?.();
      yield cipher.getAuthTag();
    } catch (error) {
      encryptedOutput.destroy(error instanceof Error ? error : new Error("فشل تشفير النسخة"));
      await pipelineTask.catch(() => undefined);
      throw error;
    }
  })());
}

export async function readBackupArchive(archive: Buffer, password: string): Promise<BackupPayload> {
  validatePassword(password);
  if (!Buffer.isBuffer(archive) || archive.length < MAGIC.length + 2 + SALT_BYTES + NONCE_BYTES + TAG_BYTES || archive.length > MAX_ARCHIVE_BYTES + 4096) {
    throw new Error("ملف النسخة غير صالح أو حجمه غير مسموح");
  }
  if (!timingSafeEqual(archive.subarray(0, MAGIC.length), MAGIC)) throw new Error("صيغة ملف النسخة غير معروفة");
  const headerLength = archive.readUInt16BE(MAGIC.length);
  const headerStart = MAGIC.length + 2;
  const headerEnd = headerStart + headerLength;
  if (headerLength < 2 || headerEnd + SALT_BYTES + NONCE_BYTES + TAG_BYTES > archive.length) throw new Error("بيانات تعريف النسخة تالفة");
  let header: BackupHeader;
  try { header = JSON.parse(archive.subarray(headerStart, headerEnd).toString("utf8")) as BackupHeader; }
  catch { throw new Error("بيانات تعريف النسخة تالفة"); }
  if (header.format !== "tezkar-full-backup" || (header.version !== FORMAT_VERSION && header.version !== STREAM_FORMAT_VERSION) || header.kdf !== "scrypt" || header.cipher !== "aes-256-gcm") {
    throw new Error("إصدار النسخة غير مدعوم");
  }
  let offset = headerEnd;
  const salt = archive.subarray(offset, offset += SALT_BYTES);
  const nonce = archive.subarray(offset, offset += NONCE_BYTES);
  let tag: Buffer;
  let encrypted: Buffer;
  if (header.version === FORMAT_VERSION) {
    tag = archive.subarray(offset, offset += TAG_BYTES);
    encrypted = archive.subarray(offset);
  } else {
    tag = archive.subarray(archive.length - TAG_BYTES);
    encrypted = archive.subarray(offset, archive.length - TAG_BYTES);
  }
  const key = await deriveKey(password, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8")) as BackupPayload;
    if (payload.format !== "tezkar-full-backup" || payload.version !== FORMAT_VERSION || !Array.isArray(payload.tables) || typeof payload.createdAt !== "string") {
      throw new Error("بنية بيانات النسخة غير صحيحة");
    }
    return payload;
  } catch {
    throw new Error("تعذر فك النسخة: كلمة المرور غير صحيحة أو الملف تالف");
  }
}
