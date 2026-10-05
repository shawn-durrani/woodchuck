// A stand-in for Claude that plays back fixed replies. Tests use it, and
// WOODCHUCK_SCRIPT=file.json runs the app with it, so the plan and question
// flows can be tried without an API key or any cost.
//
// A block of type "delay" with "ms" holds that reply back that long, so a
// long build can be tried too. A block of type "gate" with "until", a
// promise, holds it back until the promise settles, so a test decides when
// each reply arrives and timing never matters. A block of type "usage" sets
// the reply's token counts, such as input_tokens. None of the three reaches
// the conversation.
//
// A request for a summary of the chat takes its reply from a second list,
// so it never uses up a turn's reply. A reply there with a compaction block
// is a summary, and one without is a summary that failed. With the list
// empty, no summary comes back.

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./agent.js";

export type ScriptBlock = Record<string, unknown>;

export function scriptedClient(
  replies: ScriptBlock[][],
  summaries: ScriptBlock[][] = [],
): MessagesClient & { sent: Anthropic.Beta.MessageCreateParamsStreaming[]; summarised: Anthropic.Beta.MessageCreateParamsStreaming[] } {
  const sent: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  const summarised: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  return {
    sent,
    summarised,
    stream(body) {
      const summary = (body as { compaction?: unknown }).compaction !== undefined;
      (summary ? summarised : sent).push(structuredClone(body));
      const reply = (summary ? summaries.shift() : replies.shift()) ?? (summary ? [] : [{ type: "text", text: "(The script has no more replies.)" }]);
      const wait = reply.filter((b) => b.type === "delay").reduce((ms, b) => ms + Number(b.ms ?? 0), 0);
      const gates = reply.filter((b) => b.type === "gate").map((b) => b.until as Promise<unknown>);
      const { type: _, ...tokens } = reply.find((b) => b.type === "usage") ?? { type: "usage" };
      const content = reply.filter((b) => b.type !== "delay" && b.type !== "gate" && b.type !== "usage");
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
          // A summary's tokens come as an iteration, and its top-level counts are zero.
          const stopReason = summary ? (content.some((b) => b.type === "compaction") ? "compaction" : "end_turn") : toolUse ? "tool_use" : "end_turn";
          const usage = summary
            ? { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 0, output_tokens: 0, ...tokens }] }
            : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, ...tokens };
          return {
            id: "msg_script",
            type: "message",
            role: "assistant",
            model: "script",
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage,
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
