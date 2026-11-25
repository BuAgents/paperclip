// bu-fork: WhatsApp channel. Pure helpers, unit-tested without a socket.

/** WhatsApp markup: *bold*, _italic_, ~strike~, ```mono```. */
export function markdownToWhatsapp(markdown: string): string {
  const blocks: string[] = [];
  let text = markdown.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push("```" + code.replace(/\n$/, "") + "```");
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const BOLD = "\u0001";
  text = text
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, (_m, h: string) => `${BOLD}${h}${BOLD}`)
    .replace(/\*\*(.+?)\*\*/g, (_m, b: string) => `${BOLD}${b}${BOLD}`)
    .replace(/__(.+?)__/g, (_m, b: string) => `${BOLD}${b}${BOLD}`)
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, (_m, pre: string, i: string) => `${pre}_${i}_`)
    .replace(/~~(.+?)~~/g, (_m, s: string) => `~${s}~`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`)
    .replace(/^(\s*)[-*+]\s+/gm, (_m, indent: string) => `${indent}• `)
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(new RegExp(BOLD, "g"), "*");
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Split long replies on paragraph, then line, then word boundaries. */
export function splitWhatsappText(text: string, max = 3500): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface WhatsappKeyLike {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
}

/** `5583…:24@s.whatsapp.net` → `5583…`. */
export function jidUser(jid: string | null | undefined): string {
  if (!jid) return "";
  return (jid.split("@")[0] ?? "").split(":")[0] ?? "";
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

const isPhoneJid = (jid: string | null | undefined): jid is string => typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
const isLidJid = (jid: string | null | undefined): jid is string => typeof jid === "string" && jid.endsWith("@lid");

/**
 * WhatsApp addresses many people by an anonymous LID. Prefer the phone number
 * (stable, what operators recognize) and fall back to the LID.
 */
export function whatsappSender(key: WhatsappKeyLike): { chatJid: string; isGroup: boolean; senderId: string } | null {
  const chatJid = key.remoteJid ?? "";
  if (!chatJid || chatJid === "status@broadcast" || chatJid.endsWith("@newsletter") || chatJid.endsWith("@broadcast")) return null;
  const isGroup = isGroupJid(chatJid);
  const candidates = isGroup ? [key.participant, key.participantAlt] : [chatJid, key.remoteJidAlt];
  const phone = candidates.find(isPhoneJid);
  const lid = candidates.find(isLidJid);
  const senderId = phone ? jidUser(phone) : lid ? `lid:${jidUser(lid)}` : "";
  return senderId ? { chatJid, isGroup, senderId } : null;
}

export interface ContextInfoLike {
  mentionedJid?: (string | null | undefined)[] | null;
  participant?: string | null;
}

/** A group message addresses the bot by @mention (phone or LID) or by replying to it. */
export function addressesBot(context: ContextInfoLike | null | undefined, botUsers: readonly string[]): boolean {
  if (!context) return false;
  const bots = new Set(botUsers.filter(Boolean));
  if (bots.size === 0) return false;
  if ((context.mentionedJid ?? []).some((jid) => bots.has(jidUser(jid ?? "")))) return true;
  return bots.has(jidUser(context.participant ?? ""));
}

export function stripBotMentions(text: string, botUsers: readonly string[]): string {
  let out = text;
  for (const user of botUsers.filter(Boolean)) out = out.split(`@${user}`).join("");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

const THREAD_RE = /^whatsapp:([0-9A-Za-z.:_-]{3,128}@(?:s\.whatsapp\.net|lid|g\.us))$/;

export function whatsappThreadId(chatJid: string): string {
  const id = `whatsapp:${chatJid}`;
  if (!THREAD_RE.test(id)) throw new Error("Invalid WhatsApp chat identity");
  return id;
}

export function parseWhatsappThreadId(threadId: string): { chatJid: string; isGroup: boolean } {
  const match = THREAD_RE.exec(threadId);
  if (!match) throw new Error("Invalid WhatsApp conversation identity");
  return { chatJid: match[1]!, isGroup: isGroupJid(match[1]) };
}
