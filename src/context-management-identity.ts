export const CONTEXT_MANAGEMENT_AGENT_IDENTITY = "context-management-agent-identity";
const IDENTITY_VERSION = 1;
const ROOT_AGENT_NAME = "/root";
const MAX_AGENT_NAME_LENGTH = 1024;
const VALID_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface ContextManagementAgentIdentity {
  version: 1;
  sessionId: string;
  rootSessionId: string;
  agentName: string;
}

type SessionManagerLike = {
  getEntries?: () => unknown[];
  getSessionId?: () => string;
  appendCustomEntry?: (customType: string, data?: unknown) => unknown;
};

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function isValidContextManagementAgentName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_AGENT_NAME_LENGTH) return false;
  const segments = value.split("/");
  return segments[0] === "" && segments[1] === "root" && segments.length >= 2 && segments.slice(1).every((segment) =>
    segment.length > 0 && VALID_SEGMENT.test(segment) && segment !== "." && segment !== ".." && segment !== "notes",
  );
}

function parseIdentity(entry: unknown): ContextManagementAgentIdentity | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const custom = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (custom.type !== "custom" || custom.customType !== CONTEXT_MANAGEMENT_AGENT_IDENTITY) return undefined;
  if (!custom.data || typeof custom.data !== "object") return undefined;
  const data = custom.data as Partial<ContextManagementAgentIdentity>;
  if (
    data.version !== IDENTITY_VERSION ||
    !isSessionId(data.sessionId) ||
    !isSessionId(data.rootSessionId) ||
    !isValidContextManagementAgentName(data.agentName)
  ) {
    return undefined;
  }
  return data as ContextManagementAgentIdentity;
}

function findIdentity(manager: SessionManagerLike | undefined, sessionId: string): ContextManagementAgentIdentity | undefined {
  try {
    const entries = manager?.getEntries?.();
    if (!Array.isArray(entries)) return undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      const identity = parseIdentity(entries[index]);
      if (identity?.sessionId === sessionId) return identity;
    }
  } catch {
    // Context identity is optional metadata; unavailable mock or host APIs must not stop a child.
  }
  return undefined;
}

function fallbackSegment(sessionId: string): string {
  if (VALID_SEGMENT.test(sessionId) && sessionId !== "." && sessionId !== ".." && sessionId !== "notes") {
    return sessionId;
  }
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `session-${(hash >>> 0).toString(36)}`;
}

function childAgentName(parentAgentName: string, requestedAgentId: string | undefined, childSessionId: string): string | undefined {
  const segment = requestedAgentId && VALID_SEGMENT.test(requestedAgentId) && requestedAgentId !== "." && requestedAgentId !== ".." && requestedAgentId !== "notes"
    ? requestedAgentId
    : fallbackSegment(childSessionId);
  const agentName = `${parentAgentName}/${segment}`;
  return isValidContextManagementAgentName(agentName) ? agentName : undefined;
}

/**
 * Persist an identity which context-management can use to place a child in its
 * root session's history and notes namespace. This is intentionally best-effort:
 * the SDK may give tests or embedding hosts partial SessionManager mocks.
 */
export function appendContextManagementAgentIdentity(
  parentSessionManager: SessionManagerLike | undefined,
  childSessionManager: SessionManagerLike | undefined,
  agentId: string | undefined,
): void {
  try {
    const childSessionId = childSessionManager?.getSessionId?.();
    if (!isSessionId(childSessionId)) return;
    if (findIdentity(childSessionManager, childSessionId)) return;

    const parentSessionId = parentSessionManager?.getSessionId?.();
    const parentIdentity = isSessionId(parentSessionId)
      ? findIdentity(parentSessionManager, parentSessionId)
      : undefined;
    const rootSessionId = parentIdentity?.rootSessionId ?? (isSessionId(parentSessionId) ? parentSessionId : childSessionId);
    const parentAgentName = parentIdentity?.agentName ?? ROOT_AGENT_NAME;
    const agentName = childAgentName(parentAgentName, agentId, childSessionId);
    if (!agentName || !isSessionId(rootSessionId)) return;

    childSessionManager?.appendCustomEntry?.(CONTEXT_MANAGEMENT_AGENT_IDENTITY, {
      version: IDENTITY_VERSION,
      sessionId: childSessionId,
      rootSessionId,
      agentName,
    } satisfies ContextManagementAgentIdentity);
  } catch {
    // Identity metadata is never allowed to make child startup fail.
  }
}
