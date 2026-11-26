// bu-fork: WhatsApp media locator and local transcription.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWhatsappMediaLocator } from "./adapter.js";
import { formatDuration, transcribeAudio } from "../bu-transcriber.js";

const locator = {
  kind: "whatsapp_media",
  chatJid: "558381103324@s.whatsapp.net",
  messageId: "ABC123",
  url: "https://mmg.whatsapp.net/v/t62/abc",
  directPath: "/v/t62/abc",
  mediaKey: Buffer.from("k".repeat(32)).toString("base64"),
  mimeType: "image/jpeg",
  size: 1234,
};

describe("whatsapp media locator", () => {
  it("accepts a complete image locator", () => {
    expect(parseWhatsappMediaLocator(locator)).toEqual(locator);
  });
  it("rejects non-https URLs, non-images and missing keys", () => {
    expect(parseWhatsappMediaLocator({ ...locator, url: "http://example.com/x" })).toBeNull();
    expect(parseWhatsappMediaLocator({ ...locator, mimeType: "audio/ogg" })).toBeNull();
    expect(parseWhatsappMediaLocator({ ...locator, mediaKey: "" })).toBeNull();
    expect(parseWhatsappMediaLocator({ ...locator, kind: "photon_attachment" })).toBeNull();
    expect(parseWhatsappMediaLocator(null)).toBeNull();
  });
});

describe("local transcriber", () => {
  const previous = process.env.PAPERCLIP_BU_WHISPER_CMD;
  afterEach(() => {
    if (previous === undefined) delete process.env.PAPERCLIP_BU_WHISPER_CMD;
    else process.env.PAPERCLIP_BU_WHISPER_CMD = previous;
  });

  async function fakeWhisper(body: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fake-whisper-"));
    const script = path.join(dir, "whisper.mjs");
    await writeFile(script, body);
    await chmod(script, 0o700);
    process.env.PAPERCLIP_BU_WHISPER_CMD = `${process.execPath} ${script}`;
  }

  it("returns the transcript and serializes calls", async () => {
    await fakeWhisper(`
      import { readFileSync } from "node:fs";
      const audio = readFileSync(process.argv.at(-1), "utf8");
      console.log(JSON.stringify({ text: " heard " + audio + " ", language: "pt", duration: 14.2 }));
    `);
    const [a, b] = await Promise.all([transcribeAudio(Buffer.from("one")), transcribeAudio(Buffer.from("two"))]);
    expect(a).toEqual({ text: "heard one", language: "pt", durationSec: 14.2 });
    expect(b.text).toBe("heard two");
  });

  it("reports failures and rejects empty audio", async () => {
    await fakeWhisper(`console.log(JSON.stringify({ error: "bad audio" }));`);
    await expect(transcribeAudio(Buffer.from("x"))).rejects.toThrow("bad audio");
    await expect(transcribeAudio(Buffer.alloc(0))).rejects.toThrow("Empty audio");
  });

  it("formats durations", () => {
    expect(formatDuration(74.4)).toBe("1:14");
    expect(formatDuration(null)).toBe("");
  });
});
