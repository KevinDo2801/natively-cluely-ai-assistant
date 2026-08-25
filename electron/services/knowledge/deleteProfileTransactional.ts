// electron/services/knowledge/deleteProfileTransactional.ts
//
// Phase 6 Slice 5 (context-rebuild, 2026-07-25) item 4: profile:delete /
// profile:delete-jd previously ran the orchestrator's deleteDocumentsByType
// then this repo's deleteProfilePack as two separate calls, with the second
// wrapped in a try/catch that only WARNS on failure — a Tier 2 error left the
// orchestrator's rows deleted and Tier 2's PII-bearing knowledge_cards orphaned
// (partial delete, not atomic). Both tiers are constructed from the SAME
// underlying better-sqlite3 connection (both wrap `DatabaseManager.getInstance().getDb()`
// — see electron/main.ts's Knowledge Orchestrator init), so a single
// DatabaseManager.runInTransaction() is a genuine cross-tier transaction,
// not just call sequencing: a throw from either delete rolls both back.

import { DatabaseManager } from '../../db/DatabaseManager';
import { ProfilePackBuilder } from './ProfilePackBuilder';
import type { ProfileDocKind } from './ProfilePackBuilder';

export interface Tier1ProfileDeleter {
  deleteDocumentsByType(docType: unknown): void;
}

/**
 * The single delete entrypoint for a profile doc kind, transactional across
 * both tiers. `docType` is the orchestrator-side doc-type value (e.g.
 * DocType.RESUME/DocType.JD) — passed in (rather than imported here) so this
 * main-repo module has no static dependency on the orchestrator module.
 */
export function deleteProfileTransactional(
  orchestrator: Tier1ProfileDeleter,
  docType: unknown,
  kind: ProfileDocKind,
): void {
  DatabaseManager.getInstance().runInTransaction(() => {
    orchestrator.deleteDocumentsByType(docType);
    ProfilePackBuilder.getInstance().deleteProfilePack(kind);
  });
}
