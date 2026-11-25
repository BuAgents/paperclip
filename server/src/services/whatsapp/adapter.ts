// bu-fork: WhatsApp channel provider (Baileys, as a linked device).
//
// A standard Chat SDK adapter whose inbound side is a long-lived WhatsApp Web
// socket instead of webhooks. The device is paired once, out of band, with
// scripts/bu/whatsapp-pair.mjs into a Baileys multi-file auth directory; this
// adapter only logs in with it and never pairs (it stops on a QR request).
//
// Group rule: in a group, only messages that @mention the bot or reply to it
// reach Paperclip. Everything else in the group is dropped here, so follow-ups
// never become "subscribed" turns without an explicit mention.
import { existsSync } from "node:fs";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FetchOptions,
  type FormattedContent,
  type ThreadInfo,
} from "chat";
import {
  addressesBot,
  jidUser,
  markdownToWhatsapp,
  parseWhatsappThreadId,
  splitWhatsappText,
  stripBotMentions,
  whatsappSender,
  whatsappThreadId,
  type ContextInfoLike,
} from "./format.js";

export type WhatsappRaw = {
  key: { id: string; remoteJid: string };
  senderId: string;
  pushName: string | null;
  text: string;
  isGroup: boolean;
  isMention: boolean;
  timestamp: number;
};

export class WhatsappError extends Error {
  constructor(
    readonly code: "not_paired" | "logged_out" | "replaced" | "network",
    message: string,
  ) {
    super(message);
    this.name = "WhatsappError";
  }
}

export interface WhatsappReceiverCallbacks {
  connected(): Promise<void>;
  failure(error: WhatsappError): Promise<void>;
}

const MAX_BACKOFF_MS = 60_000;

function textOf(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message) return message.markdown;
  if ("raw" in message) return message.raw;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("fallbackText" in message) return message.fallbackText ?? "";
  return "";
}

export class WhatsappChatAdapter implements Adapter<{ chatJid: string; isGroup: boolean }, WhatsappRaw> {
  readonly name = "whatsapp";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;
  private chat: ChatInstance | null = null;
  private socket: WASocket | null = null;
  private connected = false;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: WhatsappReceiverCallbacks | null = null;
  private botUsers: string[] = [];
  private readonly typing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly names = new Map<string, string>();
  private readonly seen = new Set<string>();

  constructor(
    readonly userName: string,
    readonly authDir: string,
    phoneNumber: string,
  ) {
    this.botUserId = phoneNumber;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  /** Only the process that owns the endpoint's receiver lease connects. */
  async startReceiver(callbacks: WhatsappReceiverCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.stopped = false;
    this.attempt = 0;
    await this.connect();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const timer of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
    // end() closes the websocket. Never logout(): that would unlink the device.
    this.socket?.end(undefined);
    this.socket = null;
    this.connected = false;
  }

  private async fail(error: WhatsappError): Promise<void> {
    await this.callbacks?.failure(error).catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (!existsSync(join(this.authDir, "creds.json"))) {
      this.stopped = true;
      return this.fail(new WhatsappError("not_paired", `No WhatsApp pairing found in ${this.authDir}. Pair with scripts/bu/whatsapp-pair.mjs.`));
    }
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    if (!state.creds.me?.id) {
      this.stopped = true;
      return this.fail(new WhatsappError("not_paired", "The WhatsApp credentials folder has no paired device."));
    }
    this.botUsers = [jidUser(state.creds.me.id), jidUser(state.creds.me.lid ?? "")].filter(Boolean);
    const { version } = await fetchLatestWaWebVersion({});
    const socket = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: pino({ level: "silent" }),
    });
    this.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => {
      if (socket !== this.socket) return;
      if (update.qr) {
        // The stored identity was rejected. Never relay a QR; stop and report.
        this.stopped = true;
        socket.end(undefined);
        this.socket = null;
        void this.fail(new WhatsappError("not_paired", "WhatsApp asked for a new pairing. Pair again with scripts/bu/whatsapp-pair.mjs."));
        return;
      }
      if (update.connection === "open") {
        this.attempt = 0;
        this.connected = true;
        void this.callbacks?.connected().catch(() => undefined);
        return;
      }
      if (update.connection === "close") {
        this.connected = false;
        this.socket = null;
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.stopped = true;
          void this.fail(new WhatsappError("logged_out", "The device was unlinked from WhatsApp. Pair again with scripts/bu/whatsapp-pair.mjs."));
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          this.stopped = true;
          void this.fail(new WhatsappError("replaced", "Another process connected with these WhatsApp credentials. Stop it, then reconnect."));
          return;
        }
        this.scheduleReconnect(code);
      }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) void this.receive(message);
    });
  }

  private scheduleReconnect(code: number | undefined): void {
    if (this.stopped) return;
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect(undefined));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async receive(message: WAMessage): Promise<void> {
    if (!this.chat || message.key.fromMe || !message.message || !message.key.id) return;
    if (this.seen.has(message.key.id)) return;
    this.seen.add(message.key.id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    const sender = whatsappSender(message.key);
    if (!sender) return;
    const content = normalizeMessageContent(message.message);
    if (!content || content.protocolMessage || content.reactionMessage) return;
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      null;
    const context: ContextInfoLike | null =
      content.extendedTextMessage?.contextInfo ??
      content.imageMessage?.contextInfo ??
      content.videoMessage?.contextInfo ??
      content.documentMessage?.contextInfo ??
      null;
    const isMention = sender.isGroup ? addressesBot(context, this.botUsers) : false;
    // Groups answer only when addressed; nothing else from a group reaches Paperclip.
    if (sender.isGroup && !isMention) return;
    if (message.pushName) this.names.set(sender.senderId, message.pushName);
    const raw: WhatsappRaw = {
      key: { id: message.key.id, remoteJid: sender.chatJid },
      senderId: sender.senderId,
      pushName: message.pushName ?? null,
      text: text === null ? "[Unsupported WhatsApp message: only text is supported]" : stripBotMentions(text, this.botUsers),
      isGroup: sender.isGroup,
      isMention,
      timestamp: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    };
    const threadId = whatsappThreadId(sender.chatJid);
    await this.chat.processMessage(this, threadId, this.parseMessage(raw));
  }

  encodeThreadId(value: { chatJid: string }): string {
    return whatsappThreadId(value.chatJid);
  }
  decodeThreadId(id: string) {
    return parseWhatsappThreadId(id);
  }
  channelIdFromThreadId(id: string): string {
    parseWhatsappThreadId(id);
    return id;
  }
  isDM(id: string): boolean {
    return !parseWhatsappThreadId(id).isGroup;
  }

  parseMessage(raw: WhatsappRaw): Message<WhatsappRaw> {
    const threadId = whatsappThreadId(raw.key.remoteJid);
    const name = raw.pushName ?? (raw.senderId.startsWith("lid:") ? raw.senderId : `+${raw.senderId}`);
    return new Message({
      id: raw.key.id,
      threadId,
      text: raw.text,
      formatted: parseMarkdown(raw.text),
      raw,
      attachments: [],
      author: {
        userId: `whatsapp:${raw.senderId}`,
        userName: raw.senderId,
        fullName: name,
        isBot: false,
        isMe: false,
        isSystem: false,
      },
      metadata: { dateSent: new Date(raw.timestamp * 1000), edited: false },
      isMention: raw.isMention,
    } as ConstructorParameters<typeof Message<WhatsappRaw>>[0]);
  }

  async fetchThread(id: string): Promise<ThreadInfo> {
    const { chatJid, isGroup } = parseWhatsappThreadId(id);
    let channelName = isGroup ? chatJid : `+${jidUser(chatJid)}`;
    if (isGroup && this.socket && this.connected) {
      const meta = await this.socket.groupMetadata(chatJid).catch(() => null);
      if (meta?.subject) channelName = meta.subject;
    } else if (!isGroup) {
      channelName = this.names.get(jidUser(chatJid)) ?? channelName;
    }
    return { id, channelId: id, channelName, isDM: !isGroup, metadata: {} };
  }
  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return { id, name: info.channelName, isDM: info.isDM, metadata: info.metadata };
  }
  async fetchMessages(_id: string, _options?: FetchOptions) {
    // WhatsApp keeps history on the phone; the linked device stores none.
    return { messages: [] };
  }
  async getUser(userId: string) {
    const id = userId.replace(/^whatsapp:/, "");
    const name = this.names.get(id) ?? (id.startsWith("lid:") ? id : `+${id}`);
    return { userId, userName: id, fullName: name, isBot: false };
  }
  async handleWebhook(): Promise<Response> {
    return new Response("WhatsApp uses a linked-device socket, not webhooks", { status: 405 });
  }
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async startTyping(id: string): Promise<void> {
    if (!this.socket || !this.connected) return;
    const { chatJid } = parseWhatsappThreadId(id);
    const existing = this.typing.get(id);
    if (existing) clearTimeout(existing);
    await this.socket.sendPresenceUpdate("composing", chatJid).catch(() => undefined);
    // WhatsApp drops "composing" after ~10s; refresh while the agent works.
    const timer = setTimeout(() => {
      this.typing.delete(id);
      void this.startTyping(id);
    }, 8_000);
    timer.unref?.();
    this.typing.set(id, timer);
  }
  async endTyping(id: string): Promise<void> {
    const existing = this.typing.get(id);
    if (existing) clearTimeout(existing);
    this.typing.delete(id);
    if (this.socket && this.connected) {
      await this.socket.sendPresenceUpdate("paused", parseWhatsappThreadId(id).chatJid).catch(() => undefined);
    }
  }

  async postMessage(id: string, message: AdapterPostableMessage) {
    if (!this.socket || !this.connected) throw new WhatsappError("network", "WhatsApp is not connected");
    const { chatJid } = parseWhatsappThreadId(id);
    const parts = splitWhatsappText(markdownToWhatsapp(textOf(message)));
    if (parts.length === 0) throw new Error("WhatsApp publication is empty");
    let lastId = "";
    for (const part of parts) {
      const sent = await this.socket.sendMessage(chatJid, { text: part });
      lastId = sent?.key.id ?? lastId;
    }
    await this.endTyping(id);
    if (!lastId) throw new WhatsappError("network", "WhatsApp did not confirm the message");
    const raw: WhatsappRaw = {
      key: { id: lastId, remoteJid: chatJid },
      senderId: this.botUserId,
      pushName: this.userName,
      text: parts.join("\n\n"),
      isGroup: parseWhatsappThreadId(id).isGroup,
      isMention: false,
      timestamp: Math.floor(Date.now() / 1000),
    };
    return { id: lastId, threadId: id, raw };
  }
  async editMessage(): Promise<never> {
    throw new Error("WhatsApp edits are not supported");
  }
  async deleteMessage(): Promise<void> {
    /* Deleting sent messages is not supported. */
  }
  async addReaction(): Promise<void> {
    /* Receipt reactions are not published on WhatsApp. */
  }
  async removeReaction(): Promise<void> {
    /* No reactions. */
  }
}
