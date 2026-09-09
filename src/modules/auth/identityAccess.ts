/**
 * Returns whether a managed authentication principal must remain read-only
 * until its project identity has been verified by an operator.
 *
 * Password/local developer sessions deliberately do not use this predicate;
 * their write boundary is the deployment capability map and the normal local
 * account permissions.  In a managed DingTalk session, however, the server
 * admits pending/ambiguous principals for transcript reads while rejecting
 * mutation and provider-execution requests.  Keeping this small pure helper
 * shared by workspace chrome prevents an editable control from appearing
 * briefly while the server is going to return IDENTITY_ENROLLMENT_REQUIRED.
 */
export function isManagedIdentityRestricted(
  authMode: 'dingtalk' | 'platform' | 'password' | 'unavailable' | null | undefined,
  user: unknown,
): boolean {
  if (authMode !== 'dingtalk' && authMode !== 'platform') {
    return false;
  }

  const actor = user && typeof user === 'object'
    ? (user as {
      actor?: {
        provider?: unknown;
        personId?: unknown;
        identityStatus?: unknown;
      } | null;
    }).actor
    : undefined;
  const isDingTalkActor = actor?.provider === 'dingtalk';
  const hasPersonId = (typeof actor?.personId === 'string' && actor.personId.trim().length > 0)
    || (typeof actor?.personId === 'number'
      && Number.isSafeInteger(actor.personId)
      && actor.personId > 0);
  const hasVerifiedDingTalkIdentity = isDingTalkActor
    && actor?.identityStatus === 'verified'
    && hasPersonId;

  // A status which explicitly represents enrollment work is restricted even
  // if a malformed payload omits the provider field. This mirrors the server
  // mutation middleware's fail-closed behavior.
  if (actor?.identityStatus === 'configured'
    || actor?.identityStatus === 'pending'
    || actor?.identityStatus === 'ambiguous') {
    return true;
  }

  // Explicit DingTalk SSO requires a verified DingTalk actor. Legacy platform
  // bypass users without a DingTalk actor remain compatible; a DingTalk actor
  // in that mode still follows the verified-identity boundary.
  if (authMode === 'dingtalk') {
    return !hasVerifiedDingTalkIdentity;
  }

  return isDingTalkActor && !hasVerifiedDingTalkIdentity;
}
