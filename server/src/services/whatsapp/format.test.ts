// bu-fork: WhatsApp channel helpers.
import { describe, expect, it } from "vitest";
import {
  addressesBot,
  markdownToWhatsapp,
  parseWhatsappThreadId,
  splitWhatsappText,
  stripBotMentions,
  whatsappSender,
  whatsappThreadId,
} from "./format.js";

const BOT = ["558396417844", "201234567890123"];

describe("whatsapp format helpers", () => {
  it("resolves senders by phone, falling back to LID", () => {
    expect(whatsappSender({ remoteJid: "558381103324@s.whatsapp.net" })).toEqual({
      chatJid: "558381103324@s.whatsapp.net", isGroup: false, senderId: "558381103324",
    });
    expect(whatsappSender({ remoteJid: "111@lid", remoteJidAlt: "558381103324@s.whatsapp.net" })?.senderId).toBe("558381103324");
    expect(whatsappSender({ remoteJid: "111@lid" })?.senderId).toBe("lid:111");
    expect(whatsappSender({ remoteJid: "1203@g.us", participant: "333@lid", participantAlt: "5511:3@s.whatsapp.net" }))
      .toEqual({ chatJid: "1203@g.us", isGroup: true, senderId: "5511" });
    expect(whatsappSender({ remoteJid: "status@broadcast" })).toBeNull();
  });

  it("detects mentions of either bot identity and replies to the bot", () => {
    expect(addressesBot({ mentionedJid: ["201234567890123@lid"] }, BOT)).toBe(true);
    expect(addressesBot({ mentionedJid: ["558396417844@s.whatsapp.net"] }, BOT)).toBe(true);
    expect(addressesBot({ participant: "558396417844:24@s.whatsapp.net" }, BOT)).toBe(true);
    expect(addressesBot({ mentionedJid: ["5511@s.whatsapp.net"] }, BOT)).toBe(false);
    expect(addressesBot(null, BOT)).toBe(false);
    expect(stripBotMentions("@201234567890123 status?", BOT)).toBe("status?");
  });

  it("round-trips thread ids and rejects malformed ones", () => {
    const id = whatsappThreadId("120363404653655355@g.us");
    expect(parseWhatsappThreadId(id)).toEqual({ chatJid: "120363404653655355@g.us", isGroup: true });
    expect(parseWhatsappThreadId(whatsappThreadId("558381103324@s.whatsapp.net")).isGroup).toBe(false);
    expect(() => parseWhatsappThreadId("whatsapp:../../etc@g.us")).toThrow();
    expect(() => whatsappThreadId("x")).toThrow();
  });

  it("converts markdown and splits long text", () => {
    expect(markdownToWhatsapp("## Status\n**done** and *almost*\n- a\n- b")).toBe("*Status*\n*done* and _almost_\n• a\n• b");
    const para = "x".repeat(2000);
    expect(splitWhatsappText(`${para}\n\n${para}`)).toEqual([para, para]);
  });
});
