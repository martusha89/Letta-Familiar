import { randomBytes } from "node:crypto";

export function generateSecret() {
  return randomBytes(24).toString("hex");
}
