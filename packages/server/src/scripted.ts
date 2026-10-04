// A stand-in for Claude that plays back fixed replies. Tests use it, and
// WOODCHUCK_SCRIPT=file.json runs the app with it, so the plan and question
// flows can be tried without an API key or any cost.
//
// A block of type "delay" with "ms" holds that reply back that long, so a
// long build can be tried too. A block of type "gate" with "until", a
// promise, holds it back until the promise settles, so a test decides when
// each reply arrives and timing never matters. Neither reaches the
// conversation.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./agent.js";

export type ScriptBlock = Record<string, unknown>;

export function scriptedClient(replies: ScriptBlock[][]): MessagesClient & { sent: Anthropic.Beta.MessageCreateParamsStreaming[] } {
  const sent: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  return {
    sent,
    stream(body) {
      sent.push(structuredClone(body));
      const reply = replies.shift() ?? [{ type: "text", text: "(The script has no more replies.)" }];
      const wait = reply.filter((b) => b.type === "delay").reduce((ms, b) => ms + Number(b.ms ?? 0), 0);
      const gates = reply.filter((b) => b.type === "gate").map((b) => b.until as Promise<unknown>);
      const content = reply.filter((b) => b.type !== "delay" && b.type !== "gate");
      const handlers: Record<string, (d: string) => void> = {};
      let stop: (() => void) | null = null;
      let aborted = false;
      return {
        on(event: string, cb: (d: string) => void) {
          handlers[event] = cb;
          return this;
        },
        async finalMessage() {
          if (wait > 0 || gates.length) {
            await new Promise<void>((resolve) => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              stop = () => {
                clearTimeout(timer);
                resolve();
              };
              void Promise.all(gates).then(() => {
                timer = setTimeout(resolve, wait);
              });
            });
          }
          if (aborted) throw new Error("Request was aborted.");
          for (const b of content) {
            if (b.type === "thinking") handlers.thinking?.(String(b.thinking));
            if (b.type === "text") handlers.text?.(String(b.text));
          }
          const toolUse = content.some((b) => b.type === "tool_use");
          return {
            id: "msg_script",
            type: "message",
            role: "assistant",
            model: "script",
            content,
            stop_reason: toolUse ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          } as unknown as Anthropic.Beta.BetaMessage;
        },
        abort() {
          aborted = true;
          stop?.();
        },
      };
    },
  };
}

export function scriptFromFile(file: string): MessagesClient {
  return scriptedClient(JSON.parse(readFileSync(file, "utf8")) as ScriptBlock[][]);
}
