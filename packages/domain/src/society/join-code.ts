/**
 * Join code value object (PRD §3.2 "Join Society").
 *
 * Rules from the PRD: 6 characters, uppercase, ambiguity-free alphabet — no
 * `0/O` and no `1/I`, because these codes get read aloud over the phone and
 * written on the society notice board.
 *
 * Pure and dependency-free so the API can generate codes with the same
 * function the client validates with.
 */

/** 32 unambiguous uppercase characters. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** `societyexpense://join?code=XXXXXX` (PRD §3.2 deep link + QR). */
export const JOIN_LINK_SCHEME = "societyexpense://join";

/**
 * Tolerates what users actually paste: lowercase, spaces, hyphens and the
 * `societyexpense://join?code=` wrapper itself.
 */
export function normalizeJoinCode(raw: string): string {
  const fromLink = extractCodeFromText(raw);
  return fromLink.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function isValidJoinCode(raw: string): boolean {
  return JOIN_CODE_PATTERN.test(normalizeJoinCode(raw));
}

/**
 * Cryptographically-injectable generator: the API passes a secure random
 * source, tests pass a deterministic one.
 */
export function generateJoinCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    const position = Math.floor(random() * JOIN_CODE_ALPHABET.length);
    // Position is bounded by the alphabet length, so the character exists.
    code += JOIN_CODE_ALPHABET.charAt(position);
  }
  return code;
}

export function buildJoinDeepLink(code: string): string {
  return `${JOIN_LINK_SCHEME}?code=${normalizeJoinCode(code)}`;
}

/**
 * Reads a join code out of an incoming deep link, or `null` when the URL is
 * not a join link. Returns the normalised code — used by the Linking listener
 * so nothing else has to understand URLs.
 */
export function parseJoinDeepLink(url: string): string | null {
  if (!url.startsWith(JOIN_LINK_SCHEME)) return null;
  const code = normalizeJoinCode(extractCodeFromText(url));
  return isValidJoinCode(code) ? code : null;
}

/** WhatsApp-first share copy (PRD §3.2: WhatsApp is the dominant channel). */
export function buildJoinShareMessage(
  societyName: string,
  code: string,
): string {
  const link = buildJoinDeepLink(code);
  return [
    `You are invited to join ${societyName} on Society Expense Splitter.`,
    "",
    `Join code: ${normalizeJoinCode(code)}`,
    `Open the app: ${link}`,
    "",
    'Open the app, tap "Join society" and enter the code.',
  ].join("\n");
}

function extractCodeFromText(text: string): string {
  const match = /code=([A-Za-z0-9-]+)/.exec(text);
  return match === null ? text : (match[1] ?? text);
}
