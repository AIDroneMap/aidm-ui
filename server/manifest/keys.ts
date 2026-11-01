export interface AcceptedKey {
  id: string;
  /** Base64 of the 32 raw bytes of the Ed25519 public key. */
  publicKey: string;
  /** True for a key that only signs development builds. A release build refuses it. */
  test: boolean;
}

/**
 * The public keys a manifest may be signed with. A second key can join the
 * list before the first one leaves it (ADR 0003).
 */
export const ACCEPTED_KEYS: readonly AcceptedKey[] = [
  {
    id: "api-release-2026",
    publicKey: "AyWaJGsLzH6SSwcX1BTMUG6Q4HN9KmMrJZeNHKIZNSI=",
    test: false,
  },
  {
    id: "development-test-key",
    publicKey: "/ZvJB2b6/5SBwz1giwTJS3e8x8KvLyrAeYIrzGNoYck=",
    test: true,
  },
];
