// Native Web Crypto only. Fixed parameters prevent envelope-driven work amplification.
export const MAX_ENVELOPE_BYTES = 1500000;
const iterations = 600000;
const context = new TextEncoder().encode('pactap-direct-workflow-review:v1');
const encoder = new TextEncoder();
export function normalizePassphrase(value) {
  if (typeof value !== 'string' || value.length > 128) throw Error('Invalid passphrase');
  const normalized = value.replace(/[. \t\r\n]/g, '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(normalized)) throw Error('Invalid passphrase');
  return normalized;
}
const encode = bytes => btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
function decode(value, expectedLength) {
  if (typeof value !== 'string' || value.length > MAX_ENVELOPE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Invalid encrypted file');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (encode(bytes) !== value || (expectedLength && bytes.length !== expectedLength)) throw Error('Invalid encrypted file');
  return bytes;
}
async function derive(passphrase, salt, usage) {
  const bytes = encoder.encode(normalizePassphrase(passphrase));
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
  } finally { bytes.fill(0); }
}
export async function seal(data, passphrase) {
  const bytes = encoder.encode(JSON.stringify(data));
  if (bytes.length > 1000000) throw Error('Review content too large');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await derive(passphrase, salt, 'encrypt');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context, tagLength: 128 }, key, bytes);
    return { version: 1, kdf: 'PBKDF2-SHA256', iterations, cipher: 'AES-256-GCM', salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(encrypted)) };
  } finally { bytes.fill(0); }
}
export async function unseal(envelope, passphrase) {
  if (!envelope || Object.keys(envelope).sort().join() !== 'cipher,data,iterations,iv,kdf,salt,version' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== iterations || envelope.cipher !== 'AES-256-GCM') throw Error('Invalid encrypted file');
  const salt = decode(envelope.salt, 16), iv = decode(envelope.iv, 12), encrypted = decode(envelope.data);
  if (encrypted.length < 17 || encrypted.length > 1000016) throw Error('Invalid encrypted file');
  const key = await derive(passphrase, salt, 'decrypt');
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context, tagLength: 128 }, key, encrypted));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  finally { bytes.fill(0); }
}
