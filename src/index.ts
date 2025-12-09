import type { ExecutionContext } from "@cloudflare/workers-types";

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_PROMPT?: string;
  OPENAI_VECTOR_STORE_ID?: string;
  ENABLE_DIRECT_CHAT_REPLY?: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_BOT_USER_ID: string;
}

type LineWebhookRequest = {
  events: LineEvent[];
};

type LineEvent = {
  type: "message";
  replyToken: string;
  source: { userId?: string; groupId?: string; roomId?: string };
  timestamp: number;
  mode: "active" | "standby";
  webhookEventId: string;
  deliveryContext?: { isRedelivery: boolean };
  message: LineTextMessage | Record<string, unknown>;
};

type LineTextMessage = {
  type: "text";
  id: string;
  text: string;
  mention?: {
    mentionees: Array<{ index: number; length: number; userId?: string; type?: string }>;
  };
};

const OPENAI_API_URL = "https://api.openai.com/v1/responses" as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const signature = request.headers.get("x-line-signature");
    const bodyText = await request.text();

    if (!(await verifyLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: LineWebhookRequest;
    try {
      payload = JSON.parse(bodyText) as LineWebhookRequest;
    } catch (error) {
      console.error("Failed to parse webhook payload", error);
      return new Response("Bad Request", { status: 400 });
    }

    const tasks = payload.events.map((event) =>
      handleEvent(event, env).catch((error) => {
        console.error("Error handling event", error);
      })
    );

    ctx.waitUntil(Promise.all(tasks));

    return new Response("OK", { status: 200 });
  },
};

async function handleEvent(event: LineEvent, env: Env): Promise<{ ok: boolean }> {
  if (event.type !== "message") return { ok: true };
  if (!isTextMessage(event.message)) return { ok: true };

  const allowDirectChat = isDirectChat(event) && isDirectChatEnabled(env);

  if (!allowDirectChat && !isBotMentioned(event.message, env.LINE_BOT_USER_ID)) {
    return { ok: true };
  }

  const question = extractQuestion(event.message).trim();
  if (!question) return { ok: true };

  const answer = await queryOpenAI(question, env);
  await replyToLine(event, answer, env);

  return { ok: true };
}

function isTextMessage(message: LineEvent["message"]): message is LineTextMessage {
  return typeof message === "object" && message !== null && "type" in message && (message as { type: string }).type === "text";
}

function isDirectChat(event: LineEvent): boolean {
  return Boolean(event.source.userId && !event.source.groupId && !event.source.roomId);
}

function isDirectChatEnabled(env: Env): boolean {
  const flag = env.ENABLE_DIRECT_CHAT_REPLY;
  if (!flag) return false;

  const normalized = flag.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function isBotMentioned(message: LineTextMessage, botUserId: string): boolean {
  const mentionees = message.mention?.mentionees ?? [];
  return mentionees.some((m) => m.userId === botUserId);
}

function extractQuestion(message: LineTextMessage): string {
  const mention = message.mention;
  if (!mention) return message.text;

  const sorted = [...mention.mentionees].sort((a, b) => b.index - a.index);
  let text = message.text;

  for (const m of sorted) {
    text = text.slice(0, m.index) + text.slice(m.index + m.length);
  }

  return text.trim();
}

async function queryOpenAI(question: string, env: Env): Promise<string> {
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID?.trim();
  const prompt = env.OPENAI_PROMPT?.trim() ||
    "始終以正體中文作答。僅根據storage儲存的檔案內容來回答問題。對於任何與「皇普莊園社區」無關的問題，請直接回答「本系統僅回應與皇普莊園社區相關的問題」。";

  const body: Record<string, unknown> = {
    model: env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      { role: "system", content: prompt },
      { role: "user", content: question },
    ],
    max_output_tokens: 400,
  };

  if (vectorStoreId) {
    body.tools = [{ type: "file_search", vector_store_ids: [vectorStoreId] }];
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("OpenAI API error", response.status, await response.text());
    throw new Error(`OpenAI API failed with status ${response.status}`);
  }

  const data = (await response.json()) as unknown;

  const content = extractOpenAIText(data);
  if (!content) {
    throw new Error("OpenAI response is empty");
  }

  return content.slice(0, 1900);
}

function extractOpenAIText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  const outputText = (data as { output_text?: unknown }).output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  const output = (data as { output?: unknown }).output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
          const text = (c as { text: string }).text.trim();
          if (text) return text;
        }
      }
    }
  }

  const choiceContent = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.trim();
  }

  return null;
}

async function replyToLine(event: LineEvent, message: string, env: Env): Promise<void> {
  const replyToken = event.replyToken;

  if (!replyToken) {
    console.warn("No reply token to respond", event.webhookEventId);
    return;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: message }],
    }),
  });

  if (!response.ok) {
    console.error("LINE reply error", response.status, await response.text());
    throw new Error(`LINE reply failed with status ${response.status}`);
  }
}

async function verifyLineSignature(body: string, signature: string | null, channelSecret: string): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(channelSecret);
  const bodyData = encoder.encode(body);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, bodyData);
  const computed = arrayBufferToBase64(signatureBuffer);

  // LINE signature is base64 encoded HMAC-SHA256
  return timingSafeEqual(computed, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
