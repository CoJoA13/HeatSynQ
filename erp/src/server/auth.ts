import { prisma } from "./db";
import { hashPassword, verifyPassword } from "./password";

// Precomputed once at module load (rather than per-request) so every call to
// authenticateUser pays for exactly one argon2 verify. Used as the comparison
// target when there is no real password hash to check against (unknown
// username) or when the account shouldn't authenticate regardless of password
// (inactive/soft-deleted). Without this, those paths would return almost
// instantly while a real wrong-password attempt pays the full argon2 cost,
// letting an attacker distinguish "no such user" from "wrong password" by
// timing alone. Built via hashPassword so it always matches the argon2id
// parameters real user hashes use.
const DUMMY_HASH = await hashPassword("timing-equalizer");

/**
 * Looks up a user by username and verifies their password. Returns null for
 * an unknown username, an inactive user, a soft-deleted user, or a wrong
 * password — callers should treat all of these identically (generic 401).
 */
export async function authenticateUser(
  username: string,
  password: string,
  // `verifiedPasswordHash` is the hash this call verified `password` against — the proof
  // createSession's fence (sessions.ts) requires so a session can never be minted under a
  // credential a concurrent reset has already replaced. Server-internal; never serialized.
): Promise<{ id: string; displayName: string; verifiedPasswordHash: string } | null> {
  // select: only what this function actually reads below — every login attempt runs this query,
  // and the bare findUnique used to pull the full row, signature bytes included, just to check a
  // password and return an id/displayName pair.
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, displayName: true, passwordHash: true, active: true, deletedAt: true },
  });
  const eligibleUser = user && user.active && !user.deletedAt ? user : null;
  const passwordOk = await verifyPassword(eligibleUser?.passwordHash ?? DUMMY_HASH, password);
  if (!eligibleUser || !passwordOk) return null;
  return {
    id: eligibleUser.id,
    displayName: eligibleUser.displayName,
    verifiedPasswordHash: eligibleUser.passwordHash,
  };
}
