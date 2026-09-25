import { unseal, normalizePassphrase, MAX_ENVELOPE_BYTES } from './crypto.mjs';

let passphrase = '', generation = 0;
export function setPassphrase(value) {
  generation++;
  passphrase = value === '' ? '' : normalizePassphrase(value);
}
export async function loadReport(signal) {
  const attempt = generation;
  if (!passphrase || window.top !== window.self) throw Error('Dashboard locked');
  signal?.throwIfAborted();
  const response = await fetch('./payload.json', { cache: 'no-store', credentials: 'omit', signal });
  if (!response.ok || !response.body) throw Error('Encrypted status unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) throw Error('Encrypted status too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  signal?.throwIfAborted();
  if (attempt !== generation) throw Error('Dashboard locked');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = await unseal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), passphrase); }
  finally { bytes.fill(0); }
  signal?.throwIfAborted();
  if (attempt !== generation) throw Error('Dashboard locked');
  // Authenticated payloads remain report data, never decrypted HTML or executable code.
  if (!data || Array.isArray(data) || Object.keys(data).sort().join() !== 'kind,report,version' || data.kind !== 'pactap-development-status' || data.version !== 1 || !data.report || typeof data.report !== 'object' || Array.isArray(data.report)) throw Error('Invalid encrypted status');
  return data.report;
}
