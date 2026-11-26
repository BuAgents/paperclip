// bu-fork: WhatsApp channel glue for the shared chat-channel service.
//
// Everything the shared chat-channel workflows need to know about WhatsApp
// lives here, so the upstream modules only carry small dispatch branches that
// call into this file. WhatsApp follows the iMessage conversation model: a reply
// ends a turn, only /new or /close ends the conversation, and groups need to be
// enabled explicitly. This module does not import the Photon implementation.
import { eq } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import type { ChatEndpointSetupState, ChatProvider } from "@paperclipai/shared";
import type { Thread } from "chat";
import type { ChatSdkRuntimeCallbacks, ResolvedWhatsappChatConfig } from "../chat-sdk-runtime.js";
import type {
  DbOrTransaction,
  DbTransaction,
  EndpointRow,
  LifecycleRuntimeFence,
} from "../chat-channels/runtime-types.js";

export const WHATSAPP_PROVIDER = "whatsapp" as const;
export const WHATSAPP_RECEIVER_LEASE_KEY = "whatsapp_receiver_runtime" as const;

export function isWhatsappProvider(provider: string | null | undefined): provider is "whatsapp" {
  return provider === WHATSAPP_PROVIDER;
}

/**
 * Providers whose conversations behave like iMessage: a reply ends a turn,
 * only /new or /close ends the conversation, groups are linear conversations
 * that must be enabled explicitly.
 */
export function photonLikeConversation(provider: string | null | undefined): boolean {
  return provider === "imessage-photon" || provider === WHATSAPP_PROVIDER;
}

/** Credentials-free setup state: no webhook, no provider console. */
export function whatsappSetupState(step: ChatEndpointSetupState["step"], testStartedAt: ChatEndpointSetupState["testStartedAt"]) {
  return { step, testStartedAt } as const;
}

export function whatsappRuntimeConfig(
  endpoint: Pick<EndpointRow, "botExternalId">,
  userName: string,
  credentials: Record<string, string>,
): ResolvedWhatsappChatConfig {
  return {
    provider: WHATSAPP_PROVIDER,
    userName,
    credentials: { authDir: credentials.authDir ?? "", phoneNumber: endpoint.botExternalId ?? "" },
  };
}

/**
 * A reply finishes a WhatsApp turn, not the conversation. Only a delivered
 * /new or /close releases this chat's task binding.
 */
export async function whatsappConversationBindingIsComplete(
  conversationId: string,
  hasCommittedTaskControlCompletion: (conversationId: string) => Promise<boolean>,
): Promise<boolean> {
  return await hasCommittedTaskControlCompletion(conversationId);
}

type EnsureResource = (
  endpoint: EndpointRow,
  thread: Thread,
  enableForSetup: boolean,
  database?: DbOrTransaction,
) => Promise<{ enabled: boolean; availability: string }>;

/** A WhatsApp group answers only once the operator enabled it and groups are allowed. */
export async function admitWhatsappGroupDestination(
  input: {
    endpoint: EndpointRow;
    currentEndpoint: Pick<EndpointRow, "allowGroupChats">;
    thread: Thread;
    ensureResource: EnsureResource;
  },
  tx: DbTransaction,
): Promise<boolean> {
  const resource = await input.ensureResource(input.endpoint, input.thread, false, tx);
  return resource.enabled && resource.availability === "available" && input.currentEndpoint.allowGroupChats;
}

type RuntimeCallbackEndpoint = (
  tx: DbTransaction,
  endpointId: string,
  context: LifecycleRuntimeFence,
  statuses: EndpointRow["status"][],
) => Promise<EndpointRow | null>;

/** Receiver health drives the endpoint status (connected → active/verifying, failure → attention). */
export function createWhatsappRuntimeCallbacks(
  db: Db,
  options: {
    provider: ChatProvider;
    endpointId: string;
    context: LifecycleRuntimeFence;
    runtimeCallbackEndpoint: RuntimeCallbackEndpoint;
  },
): Pick<ChatSdkRuntimeCallbacks, "onWhatsappConnected" | "onWhatsappFailure"> {
  if (!isWhatsappProvider(options.provider)) return {};
  const { endpointId, context, runtimeCallbackEndpoint } = options;
  return {
    onWhatsappConnected: () =>
      db.transaction(async (tx) => {
        const current = await runtimeCallbackEndpoint(tx, endpointId, context, ["verifying", "active", "attention"]);
        if (!current) return;
        await tx
          .update(chatEndpoints)
          .set({
            status:
              current.status === "attention"
                ? current.setup.step === "complete" ? "active" : "verifying"
                : current.status,
            healthMessage: "WhatsApp connected",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpointId));
      }),
    onWhatsappFailure: (error) =>
      db.transaction(async (tx) => {
        const current = await runtimeCallbackEndpoint(tx, endpointId, context, ["verifying", "active", "attention"]);
        if (!current) return;
        await tx
          .update(chatEndpoints)
          .set({ status: "attention", healthMessage: error.message, lastError: error.message, updatedAt: new Date() })
          .where(eq(chatEndpoints.id, endpointId));
      }),
  };
}
