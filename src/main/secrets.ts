// Credential storage, kept deliberately separate from the app store.
//
// `Store.load()` is handed to the renderer wholesale, so it must be
// physically incapable of carrying a password. Secrets live in their own
// file, encrypted with the OS keychain via Electron's safeStorage, and are
// read only here in main — never returned over IPC. A `Connection` carries
// a `secretRef` key; the value never leaves this module except into a
// ConnectSpec bound for the connection host.

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

interface SecretFile {
  /// ref -> base64 ciphertext (or base64 plaintext when the platform has
  /// no keychain; `encrypted` records which, so we never guess on read).
  values: Record<string, { data: string; encrypted: boolean }>;
}

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'overdb-secrets.json');
}

function read(): SecretFile {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(), 'utf-8')) as SecretFile;
  } catch {
    return { values: {} };
  }
}

function write(file: SecretFile): void {
  const p = secretsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function isEncryptionAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}

/// Linux `basic_text` reports "available" while encrypting with a constant
/// key — it is not protection, and the UI must be able to say so.
export function secretsBackend(): string {
  try {
    if (process.platform !== 'linux') return process.platform === 'darwin' ? 'keychain' : 'dpapi';
    return safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function setSecret(ref: string, value: string): void {
  const file = read();
  if (isEncryptionAvailable()) {
    file.values[ref] = { data: safeStorage.encryptString(value).toString('base64'), encrypted: true };
  } else {
    // Disclosed in the UI rather than silently pretending. Base64 is
    // obfuscation, not protection, and the settings sheet says so.
    file.values[ref] = { data: Buffer.from(value, 'utf-8').toString('base64'), encrypted: false };
  }
  write(file);
}

/// Copy a stored credential from one ref to another, for duplicating a
/// connection. The ciphertext is moved as-is: nothing is decrypted, and no
/// value passes through the caller — which is what lets a duplicate keep
/// its password even though the renderer asking for it cannot read one.
export function copySecret(fromRef: string, toRef: string): boolean {
  const file = read();
  const entry = file.values[fromRef];
  if (!entry) return false;
  file.values[toRef] = { ...entry };
  write(file);
  return true;
}

export function deleteSecret(ref: string): void {
  const file = read();
  delete file.values[ref];
  write(file);
}

/// Main-process only. There is deliberately no IPC channel that reaches
/// this — see src/main/secretsNeverCrossIpc.test.ts.
export function getSecret(ref: string): string | undefined {
  const entry = read().values[ref];
  if (!entry) return undefined;
  const buf = Buffer.from(entry.data, 'base64');
  return entry.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf-8');
}

export function hasSecret(ref: string): boolean {
  return ref in read().values;
}
