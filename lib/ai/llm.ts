import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { appEnvironment } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

/**
 * LLM access for the AI pipelines. Production uses Claude through the official SDK
 * (ANTHROPIC_API_KEY, server-only). `LLM_PROVIDER=mock` returns deterministic,
 * clearly-labelled sample output for local development and tests; it is refused in
 * production so simulated output can never be mistaken for real model output.
 */
export type LlmProvider = "anthropic" | "mock";
export type LlmUsage = { inputTokens: number; outputTokens: number };
export type LlmResult<T> = { data: T; provider: LlmProvider; model: string; usage: LlmUsage };
export type WebAnswer = { answer: string; citedUrls: string[] };

export type StructuredRequest<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  /** Deterministic output for LLM_PROVIDER=mock (development/tests only). */
  mock: () => T;
};

/** A tool the agent may call. `run` returns text for the model (keep it compact). */
export type AgentTool = { name: string; description: string; schema: z.ZodObject; run: (input: Record<string, unknown>) => Promise<string> };
export type AgentRequest = {
  system: string;
  goal: string;
  tools: AgentTool[];
  maxIterations?: number;
  /** Deterministic stand-in for LLM_PROVIDER=mock: calls the tools in a fixed order and returns a report. */
  mock: (call: (name: string, input: Record<string, unknown>) => Promise<string>) => Promise<string>;
};

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  structured<T>(req: StructuredRequest<T>): Promise<LlmResult<T>>;
  /** Answers a query with live web search and returns the URLs the answer cites. */
  webAnswer(query: string, mock: () => WebAnswer): Promise<LlmResult<WebAnswer>>;
  /** Runs a tool-using agent loop until the model stops calling tools or maxIterations is reached. */
  runAgent(req: AgentRequest): Promise<LlmResult<{ report: string; iterations: number }>>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function llmProvider(): LlmProvider | null {
  const p = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (p === "mock") return appEnvironment() === "production" ? null : "mock";
  if (p === "anthropic" || process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
  return null;
}

export function llmStatus(): { configured: boolean; provider: LlmProvider | null; label: string } {
  const provider = llmProvider();
  if (provider === "anthropic") return { configured: true, provider, label: `Claude (${modelName()})` };
  if (provider === "mock") return { configured: true, provider, label: "Development mock (sample output, not a real model)" };
  return { configured: false, provider: null, label: "Not configured — set ANTHROPIC_API_KEY on the server" };
}

function modelName() {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

export function getLlm(): LlmClient {
  const provider = llmProvider();
  if (provider === "anthropic") return new AnthropicLlm(modelName());
  if (provider === "mock") return mockLlm;
  if (process.env.LLM_PROVIDER?.trim().toLowerCase() === "mock") {
    throw new AppError("CONFIG_MISSING", "The mock AI provider is disabled in production. Set ANTHROPIC_API_KEY.");
  }
  throw new AppError("CONFIG_MISSING", "AI features need ANTHROPIC_API_KEY on the server. See README → AI pipelines.");
}

const mockLlm: LlmClient = {
  provider: "mock",
  model: "mock",
  async structured(req) {
    const data = req.schema.parse(req.mock());
    return { data, provider: "mock", model: "mock", usage: { inputTokens: 0, outputTokens: 0 } };
  },
  async webAnswer(_query, mock) {
    return { data: mock(), provider: "mock", model: "mock", usage: { inputTokens: 0, outputTokens: 0 } };
  },
  async runAgent(req) {
    let iterations = 0;
    const call = async (name: string, input: Record<string, unknown>) => {
      const tool = req.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      iterations++;
      return tool.run(tool.schema.parse(input) as Record<string, unknown>);
    };
    const report = await req.mock(call);
    return { data: { report, iterations }, provider: "mock", model: "mock", usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  constructor(readonly model: string) {
    // Reads ANTHROPIC_API_KEY from the environment; SDK retries 429/5xx with backoff.
    this.client = new Anthropic({ maxRetries: 2, timeout: 10 * 60_000 });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<LlmResult<T>> {
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16_000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
      });
      if (res.stop_reason === "refusal") throw new AppError("INVALID_INPUT", "The AI model declined this request. Rephrase the topic and try again.");
      if (res.stop_reason === "max_tokens") throw new AppError("INTERNAL", "The AI response was cut off before it finished. Try a shorter article length.");
      if (!res.parsed_output) throw new AppError("INTERNAL", "The AI response did not match the expected format. Try again.");
      return { data: res.parsed_output as T, provider: "anthropic", model: res.model, usage: usageOf(res.usage) };
    } catch (err) {
      throw mapError(err);
    }
  }

  async webAnswer(query: string): Promise<LlmResult<WebAnswer>> {
    try {
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Answer this search query the way an AI search engine would, citing sources:\n\n${query}` }];
      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
      let res: Anthropic.Beta.BetaMessage | null = null;
      // Server-side web search may pause long turns; resume a bounded number of times.
      for (let i = 0; i < 3; i++) {
        res = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 4_000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: "low" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
          messages,
        });
        usage = { inputTokens: usage.inputTokens + res.usage.input_tokens, outputTokens: usage.outputTokens + res.usage.output_tokens };
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });
      }
      if (!res) throw new AppError("INTERNAL", "No answer was returned.");
      if (res.stop_reason === "refusal") throw new AppError("INVALID_INPUT", "The AI model declined to answer this query.");
      const urls = new Set<string>();
      let answer = "";
      for (const block of res.content) {
        if (block.type === "text") {
          answer += block.text;
          for (const c of block.citations ?? []) if ("url" in c && typeof c.url === "string") urls.add(c.url);
        }
      }
      return { data: { answer: answer.trim(), citedUrls: [...urls] }, provider: "anthropic", model: res.model, usage };
    } catch (err) {
      throw mapError(err);
    }
  }

  async runAgent(req: AgentRequest): Promise<LlmResult<{ report: string; iterations: number }>> {
    try {
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 16_000,
        max_iterations: req.maxIterations ?? 20,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: req.system,
        tools: req.tools.map((t) => betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: (input) => t.run(input as Record<string, unknown>) })),
        messages: [{ role: "user", content: req.goal }],
      });
      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
      let last: Anthropic.Beta.BetaMessage | null = null;
      let iterations = 0;
      for await (const message of runner) {
        iterations++;
        last = message;
        usage = { inputTokens: usage.inputTokens + message.usage.input_tokens, outputTokens: usage.outputTokens + message.usage.output_tokens };
      }
      if (!last) throw new AppError("INTERNAL", "The agent returned no response.");
      if (last.stop_reason === "refusal") throw new AppError("INVALID_INPUT", "The AI model declined this goal. Rephrase it and try again.");
      const report = last.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("\n").trim();
      const capped = last.stop_reason === "tool_use" ? "\n\n_The agent reached its step limit before finishing._" : "";
      return { data: { report: (report || "The agent finished without a written report.") + capped, iterations }, provider: "anthropic", model: last.model, usage };
    } catch (err) {
      throw mapError(err);
    }
  }
}

function usageOf(u: { input_tokens: number; output_tokens: number }): LlmUsage {
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
}

function mapError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError("CONFIG_MISSING", "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the server.");
  }
  if (err instanceof Anthropic.RateLimitError) return new AppError("RATE_LIMITED", "The AI provider is rate limiting requests. Try again shortly.", { retryable: true, retryAfterMs: 60_000 });
  if (err instanceof Anthropic.BadRequestError) {
    logger.warn("llm.bad_request", { message: err.message.slice(0, 300) });
    return new AppError("INVALID_INPUT", "The AI provider rejected the request.");
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AppError("TIMEOUT", "The AI provider timed out. Try again.", { retryable: true });
  if (err instanceof Anthropic.APIConnectionError) return new AppError("NETWORK_ERROR", "Could not reach the AI provider.", { retryable: true });
  if (err instanceof Anthropic.APIError) return new AppError("INTERNAL", `The AI provider returned an error (${err.status ?? "unknown"}).`, { retryable: (err.status ?? 0) >= 500 });
  return err;
}
