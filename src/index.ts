interface Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_PROMPT_ID?: string;
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

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions" as const;
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply" as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    const results = await Promise.all(
      payload.events.map((event) => handleEvent(event, env).catch((err) => ({ ok: false, error: err as Error })))
    );

    const firstError = results.find((r) => !("ok" in r ? r.ok : true));
    if (firstError && "error" in firstError) {
      console.error("Error handling event", firstError.error);
    }

    return new Response("OK", { status: 200 });
  },
};

async function handleEvent(event: LineEvent, env: Env): Promise<{ ok: boolean }> {
  if (event.type !== "message") return { ok: true };
  if (!isTextMessage(event.message)) return { ok: true };

  if (!isBotMentioned(event.message, env.LINE_BOT_USER_ID)) {
    return { ok: true };
  }

  const question = extractQuestion(event.message).trim();
  if (!question) return { ok: true };

  const answer = await queryOpenAI(question, env);
  await replyToLine(event.replyToken, answer, env);

  return { ok: true };
}

function isTextMessage(message: LineEvent["message"]): message is LineTextMessage {
  return typeof message === "object" && message !== null && "type" in message && (message as { type: string }).type === "text";
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
  const promptId = env.OPENAI_PROMPT_ID?.trim();

  const messages = promptId
    ? [{ role: "user", content: question }]
    : [
        { role: "system", content: "你是一個樂於助人的聊天助手。" },
        { role: "user", content: question },
      ];

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      ...(promptId ? { prompt_id: promptId } : {}),
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI API error", response.status, await response.text());
    throw new Error(`OpenAI API failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI response is empty");
  }

  return content.slice(0, 1900);
}

async function replyToLine(replyToken: string, message: string, env: Env): Promise<void> {
  const response = await fetch(LINE_REPLY_URL, {
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
