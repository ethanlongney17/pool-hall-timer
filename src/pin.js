// Manager PINs. A PIN is never stored: only a scrambled version of it (a
// SHA-256 hash with a random "salt" per manager), so the digits can't be read
// back out of the database. Checking a PIN scrambles what was typed the same
// way and compares.
//
// managers = { [id]: { name, salt, hash, addedAt } }

export const PIN_PATTERN = /^\d{4,8}$/;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function newSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  return hex(await crypto.subtle.digest("SHA-256", data));
}

/** A new manager record (throws a readable message if the details aren't usable). */
export async function makeManager(name, pin, now = Date.now()) {
  const n = String(name ?? "").trim();
  if (!n) throw new Error("Enter the manager's name");
  if (!PIN_PATTERN.test(String(pin ?? ""))) throw new Error("The PIN must be 4 to 8 digits");
  const salt = newSalt();
  return { name: n, salt, hash: await hashPin(pin, salt), addedAt: now };
}

/** The manager whose PIN this is, or null. */
export async function findManager(managers, pin) {
  if (!PIN_PATTERN.test(String(pin ?? ""))) return null;
  for (const [id, m] of Object.entries(managers ?? {})) {
    if ((await hashPin(pin, m.salt)) === m.hash) return { id, ...m };
  }
  return null;
}

export const hasManagers = (managers) => Object.keys(managers ?? {}).length > 0;
