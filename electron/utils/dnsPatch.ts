// ============================================================================
// DNS patch — resolve macOS system-resolver issues with api.natively.software.
//
// Extracted from main.ts (P1.2) — behavior is byte-identical. The monkey-patch
// forces api.natively.software through dns.resolve4 (IPv4) because the macOS
// system resolver can return IPv6 first / stall on the API host. Applied once
// at startup, before any network call.
// ============================================================================

import dns from 'dns';

/** The single host routed through resolve4. */
export const PATCHED_DNS_HOST = 'api.natively.software';

/**
 * Override global dns.lookup so the API host resolves over IPv4 first.
 * Idempotent-ish: re-applying replaces the previous patch (harmless).
 */
export function applyDnsPatch(): void {
  const originalLookup = dns.lookup;
  // Loose `any` params: this is a monkey-patch over Node's dns.lookup overloads;
  // typing them tightly fights the original untyped runtime signature.
  dns.lookup = function (hostname: any, options: any, callback: any) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (hostname === PATCHED_DNS_HOST) {
      dns.resolve4(PATCHED_DNS_HOST, (err, addresses) => {
        if (err || !addresses.length) {
          originalLookup(hostname, options, callback);
        } else {
          const addr = addresses[0];
          if (options && options.all) {
            callback(null, [{ address: addr, family: 4 }]);
          } else {
            callback(null, addr, 4);
          }
        }
      });
    } else {
      originalLookup(hostname, options, callback);
    }
  } as any;
}
