/**
 * `crypto.randomUUID` is only defined in a *secure context* — HTTPS or
 * `localhost`. The board is routinely served over plain HTTP on a LAN IP
 * (e.g. `http://192.168.1.206:3100`), where `crypto.randomUUID` is `undefined`
 * and every caller throws `crypto.randomUUID is not a function` (first seen
 * storing an API key during onboarding).
 *
 * This module exports a safe UUIDv4 generator and installs a
 * `crypto.randomUUID` polyfill on import, so both migrated call sites and any
 * third-party code that calls it directly keep working off-secure-context.
 * `crypto.getRandomValues` *is* available in insecure contexts, so the fallback
 * stays cryptographically random.
 */

function uuidFromBytes(bytes: Uint8Array): string {
  // Set the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UUIDv4 that works in secure and insecure contexts alike. */
export function randomUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // Some engines throw instead of returning undefined off-secure-context.
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return uuidFromBytes(bytes);
}

/** Install `crypto.randomUUID` when the browser does not provide one. */
export function installCryptoRandomUuidPolyfill(): void {
  const c = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (!c || typeof c.randomUUID === "function") return;
  try {
    Object.defineProperty(c, "randomUUID", {
      value: () => randomUuid(),
      writable: true,
      configurable: true,
    });
  } catch {
    // `crypto` is non-extensible here. Call sites that import `randomUuid()`
    // still work; only direct `crypto.randomUUID()` calls would not.
  }
}

// Self-install on import so the very first import of this module (see
// main.tsx) protects the whole app.
installCryptoRandomUuidPolyfill();
