/** Quote-agnostic helpers for static analysis tests over ipcHandlers.ts. */
export function findSafeHandle(source, channel) {
  const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`safeHandle\\(\\s*['"]${escaped}['"]`, 'm');
  const m = source.match(re);
  return m?.index ?? -1;
}

export function sliceSafeHandleBlock(source, channel) {
  const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = source.match(new RegExp(`safeHandle\\(\\s*['"]${escaped}['"]`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';
  const start = startMatch.index;
  const searchFrom = start + startMatch[0].length;
  const nextRel = source.slice(searchFrom).search(/safeHandle\s*\(\s*['"]/);
  const end = nextRel === -1 ? source.length : searchFrom + nextRel;
  const block = source.slice(start, end);
  // UNIFIED PIPELINE (C4): some handlers are now extracted as
  //   const _<name>Handler = async (...) => { ... };
  //   safeHandle('<channel>', _<name>Handler);
  // The safeHandle block is then a one-liner — return the CONST body instead
  // so source-assert tests keep asserting the actual implementation.
  if (!/async\s*\(/.test(block)) {
    const constMatches = source.slice(0, start).match(/const\s+_\w+Handler\s*=\s*async\s*\(/g);
    if (constMatches && constMatches.length > 0) {
      const constStart = source.lastIndexOf(constMatches[constMatches.length - 1], start);
      if (constStart >= 0) return source.slice(constStart, end);
    }
  }
  return block;
}

export function safeHandlePattern(channel) {
  const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`safeHandle\\(\\s*['"]${escaped}['"]`, 'm');
}
