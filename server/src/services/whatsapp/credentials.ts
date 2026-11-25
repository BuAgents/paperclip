// bu-fork: WhatsApp channel. The "credential" is the path of a Baileys
// multi-file auth directory produced by scripts/bu/whatsapp-pair.mjs. Only
// paths under PAPERCLIP_BU_WHATSAPP_AUTH_ROOT (default /data/secrets/whatsapp)
// are accepted, so the setup form cannot be used to probe the server's files.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "../../errors.js";
import { jidUser } from "./format.js";

export function whatsappAuthRoot(): string {
  return path.resolve(process.env.PAPERCLIP_BU_WHATSAPP_AUTH_ROOT?.trim() || "/data/secrets/whatsapp");
}

export async function verifyWhatsappCredentials(authDir: string) {
  if (!authDir || !path.isAbsolute(authDir)) throw unprocessable("Enter the absolute path of the WhatsApp credentials folder");
  const root = whatsappAuthRoot();
  const resolved = await realpath(authDir).catch(() => null);
  if (!resolved) throw unprocessable("The WhatsApp credentials folder does not exist");
  const realRoot = await realpath(root).catch(() => root);
  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
    throw unprocessable(`The WhatsApp credentials folder must be inside ${root}`);
  }
  const raw = await readFile(path.join(resolved, "creds.json"), "utf8").catch(() => null);
  if (!raw) throw unprocessable("No WhatsApp pairing in that folder. Pair first with scripts/bu/whatsapp-pair.mjs");
  let creds: { me?: { id?: string; name?: string } };
  try {
    creds = JSON.parse(raw) as typeof creds;
  } catch {
    throw unprocessable("The WhatsApp pairing file is unreadable");
  }
  const phone = jidUser(creds.me?.id);
  if (!/^\d{8,15}$/.test(phone)) throw unprocessable("That folder has no paired WhatsApp device. Pair first with scripts/bu/whatsapp-pair.mjs");
  return {
    providerAccountId: phone,
    providerAccountLabel: `+${phone}`,
    botExternalId: phone,
    botUsername: null,
    botLabel: creds.me?.name?.trim() || `+${phone}`,
  };
}
