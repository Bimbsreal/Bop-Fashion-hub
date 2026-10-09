const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function prepareAccount(input: {
  mode: "register" | "sign-in";
  email: string;
  displayName: string;
  password: string;
}):
  | { ok: true; body: { email: string; displayName?: string; password: string } }
  | { ok: false; message: string } {
  const email = input.email.trim().toLowerCase();
  if (!emailPattern.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (input.password.length < 8 || input.password.length > 200) {
    return { ok: false, message: "Use a password between 8 and 200 characters." };
  }
  if (input.mode === "sign-in") return { ok: true, body: { email, password: input.password } };
  const displayName = input.displayName.trim();
  if (!displayName) return { ok: false, message: "Display name is required." };
  if (displayName.length > 80) return { ok: false, message: "Display name is too long." };
  return { ok: true, body: { email, displayName, password: input.password } };
}
