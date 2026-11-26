#!/usr/bin/env node
// bu-fork: one-time WhatsApp pairing for the WhatsApp chat channel, run by a
// human in a real terminal on the server. Paperclip never pairs by itself; it
// only logs in with the folder this script produces.
//
//   node scripts/bu/whatsapp-pair.mjs [authDir]      default: /data/secrets/whatsapp/auth
//
// On the bot phone: WhatsApp → Settings → Linked devices → Link a device, then
// scan the QR printed here. The folder holds the WhatsApp session keys: keep it
// owner-only, outside git, and under PAPERCLIP_BU_WHATSAPP_AUTH_ROOT.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverDir = fileURLToPath(new URL("../../server/", import.meta.url));
const require = createRequire(join(serverDir, "package.json"));
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const baileys = await load("baileys");
const makeWASocket = baileys.default;
const { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } = baileys;
const qrcodeTerminal = (await load("qrcode-terminal")).default;
const pino = (await load("pino")).default;

const authDir = process.argv[2] ?? "/data/secrets/whatsapp/auth";
const credsFile = join(authDir, "creds.json");
if (existsSync(credsFile)) {
  const creds = JSON.parse(readFileSync(credsFile, "utf8"));
  if (creds?.me?.id) {
    console.error(`${authDir} already holds a paired device (+${creds.me.id.split(":")[0]}). Nothing to do.`);
    console.error("If WhatsApp unlinked it, move the folder aside first, then run this again:");
    console.error(`  mv ${authDir} ${authDir}.old-$(date +%F)`);
    process.exit(1);
  }
}
mkdirSync(authDir, { recursive: true, mode: 0o700 });
chmodSync(authDir, 0o700);
console.log(`Credentials folder: ${authDir}\n`);

const { state, saveCreds } = await useMultiFileAuthState(authDir);
async function connect() {
  const { version } = await fetchLatestWaWebVersion({});
  const socket = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: pino({ level: "silent" }),
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan with the bot phone: WhatsApp → Settings → Linked devices → Link a device");
      qrcodeTerminal.generate(qr, { small: true });
      console.log("(A new QR appears every ~20s until scanned.)\n");
    }
    if (connection === "open") {
      await saveCreds();
      console.log(`\nPaired as +${state.creds.me?.id?.split(":")[0]}. Enter ${authDir} in Paperclip → Apps → WhatsApp.`);
      socket.end(undefined); // closes this socket only; the device stays linked
      process.exit(0);
    }
    if (connection === "close") {
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        console.error("\nWhatsApp refused the link. Move the folder aside and try again.");
        process.exit(1);
      }
      void connect(); // 515 restartRequired right after scanning is normal
    }
  });
}
await connect();
