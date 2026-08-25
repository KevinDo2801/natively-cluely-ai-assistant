// electron/services/resolveCompanySearchProvider.ts
// Company-research search provider resolution.
//
// Previously this cascaded Tavily → Natively API proxy → null (LLM-only), but
// the search-provider implementations lived in the removed premium/ submodule.
// With premium gone, company research falls back to LLM-only dossiers and this
// resolver is intentionally a stub returning null. Kept as a module so call
// sites that inject a resolver into the (now-absent) KnowledgeOrchestrator and
// the manual profile:research-company IPC handler still compile and behave.

export function resolveCompanySearchProvider(): null {
  return null;
}
