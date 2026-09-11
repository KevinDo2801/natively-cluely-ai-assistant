export interface AutoApprovableQuestion {
  id?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label?: string; description?: string }>;
}

export interface AutoApprovableInteraction {
  kind?: 'user_input' | 'elicitation' | string;
  questions?: AutoApprovableQuestion[];
  requestedSchema?: unknown;
  mode?: string;
  url?: string;
}

export interface AutoApprovalResponse {
  action: 'accept';
  values: Record<string, string>;
}

/**
 * Returns the response to send for a plugin interaction that can be approved
 * without the user, or `null` when the renderer card must still be shown
 * (free-text or secret questions, non-yes/no pick lists, URL elicitations,
 * schemas with required fields).
 */
export function buildAutoApprovalResponse(
  request: AutoApprovableInteraction | null | undefined,
): AutoApprovalResponse | null;
