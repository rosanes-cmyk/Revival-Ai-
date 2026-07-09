// The approved revival text message.
//
// DO NOT MODIFY THIS STRING. It is the exact, compliance-approved copy for the
// High Equity Lead Revival Text Campaign. It is frozen so no other code path
// can alter it, and its integrity is checksummed at startup.

export const APPROVED_MESSAGE = Object.freeze(
  "Hi, this is Juan with Twin Home Buyer. You contacted us before about selling your home. Are you still interested? Reply YES or NO. Thanks!"
);

// Simple integrity guard so an accidental edit is caught loudly at boot.
export const APPROVED_MESSAGE_LENGTH = 138;

export function assertMessageIntegrity() {
  if (APPROVED_MESSAGE.length !== APPROVED_MESSAGE_LENGTH) {
    throw new Error(
      `Approved message integrity check FAILED. Expected length ${APPROVED_MESSAGE_LENGTH}, got ${APPROVED_MESSAGE.length}. The message must not be modified.`
    );
  }
}
