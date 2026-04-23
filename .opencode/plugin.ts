import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, homedir } from "node:path";

const MODEL = process.env.QWEN_VISION_MODEL || "qwen3.5:cloud";
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const TEMP_DIR = join("/tmp", "qwen-vision");
const LOG_FILE = join(TEMP_DIR, "plugin.log");
const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

mkdirSync(TEMP_DIR, { recursive: true });

function log(msg: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

// ---- Vision Detection ----
// NOTE: OpenCode's `model.capabilities.input.image` is BROKEN — always returns false.
// We use config-based modalities + pattern fallback instead.

// Known vision-capable model families (checked case-insensitively)
const VISION_MODEL_PATTERNS = [
  // OpenAI
  "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1", "gpt-5",
  // Anthropic (all current variants support vision)
  "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
  // Google
  "gemini", "gemma-3",
  // Alibaba
  "qwen2.5-vl", "qwen-vl", "qwen3-vl", "qwen3.6", "qwen3.5:cloud",
  // Moonshot / Kimi
  "kimi",
  // Meta
  "llama-3.2-vision", "llama-3.2-11b", "llama-3.2-90b",
  // Mistral
  "pixtral", "mistral-large-vision",
  // DeepSeek
  "deepseek-vl",
  // Microsoft
  "phi-4-vision", "phi-3-vision",
  // Other popular multimodal models
  "glm-4v", "yi-vl", "internvl", "cogvlm",
];

function modelHasVisionById(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return VISION_MODEL_PATTERNS.some((pattern) => id.includes(pattern.toLowerCase()));
}

// Cache for config lookups
let configCache: any = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // ms

function loadOpencodeConfig(): any {
  const now = Date.now();
  if (configCache && now - configCacheTime < CONFIG_CACHE_TTL) {
    return configCache;
  }
  try {
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf-8");
      configCache = JSON.parse(raw);
      configCacheTime = now;
      return configCache;
    }
  } catch (e: any) {
    log(`failed to load opencode config: ${e.message}`);
  }
  return null;
}

function checkModelConfigForVision(modelId: string): boolean | undefined {
  const config = loadOpencodeConfig();
  if (!config?.provider) return undefined;

  for (const [providerName, provider] of Object.entries(config.provider)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as any).models;
    if (!models || typeof models !== "object") continue;

    const modelConfig = models[modelId];
    if (!modelConfig) continue;

    // Explicit modalities definition — this is the ground truth
    if (modelConfig.modalities?.input) {
      const hasImage = modelConfig.modalities.input.includes("image");
      log(`config lookup: model=${modelId} provider=${providerName} hasImage=${hasImage}`);
      return hasImage;
    }

    // No modalities defined for this model in config
    log(`config lookup: model=${modelId} provider=${providerName} no modalities defined`);
    return undefined;
  }

  log(`config lookup: model=${modelId} not found in any provider`);
  return undefined;
}

// Main detection function: returns true/false, never undefined
function detectVisionCapability(modelId: string): boolean {
  if (!modelId) return false;

  // 1. Config lookup (most deterministic)
  const fromConfig = checkModelConfigForVision(modelId);
  if (fromConfig !== undefined) return fromConfig;

  // 2. Model ID patterns (fallback for models without config modalities)
  const fromPattern = modelHasVisionById(modelId);
  log(`detectVision: pattern fallback model=${modelId} hasVision=${fromPattern}`);
  return fromPattern;
}

// ---- Vision API ----

async function askVision(prompt: string, b64: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt, images: [b64] }],
      think: false,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

  const text = await res.text();
  let content = "";
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.message?.content) content += obj.message.content;
      if (obj.error) throw new Error(obj.error);
    } catch {}
  }
  return content || "No response from vision model";
}

// ---- Plugin ----

export const QwenVisionPlugin: Plugin = async ({ client }) => {
  return {
    // Inject vision instructions into system prompt for non-vision models
    "experimental.chat.system.transform": async (input, output) => {
      const modelId = input.model?.id;
      const hasVision = modelId ? detectVisionCapability(modelId) : false;
      if (!hasVision) {
        output.system.push(
          `IMPORTANT: You have access to image analysis through an external vision plugin. When images are provided, the plugin automatically analyzes them and provides the analysis as an additional message. USE the analysis to answer questions about images. DO NOT say "I can't read images" — the analysis is provided for you.`
        );
        log(`system.transform: injected vision instructions for ${modelId}`);
      } else {
        log(`system.transform: skipped — ${modelId} has vision`);
      }
    },

    "chat.params": async (input) => {
      const modelId = input.model?.id;
      const hasVision = modelId ? detectVisionCapability(modelId) : false;
      log(`chat.params: model=${modelId}, hasVision=${hasVision}`);
    },

    "chat.message": async (input, output) => {
      const parts = output.parts;

      // Extract model ID from the minimal info available in chat.message
      const modelId = (input as any).model?.id || (input as any).model?.modelID;

      if (!modelId) {
        log(`chat.message: no model ID found, skipping`);
        return;
      }

      const hasVision = detectVisionCapability(modelId);
      log(`chat.message: model=${modelId}, hasVision=${hasVision}`);

      if (hasVision === true) {
        log(`SKIP: model has vision (${modelId})`);
        return;
      }

      log(`Processing: model lacks vision (${modelId})`);
      if (!parts || !Array.isArray(parts)) return;

      for (const part of parts) {
        if (
          part.type === "file" &&
          part.mime?.startsWith("image/") &&
          part.url?.startsWith("data:")
        ) {
          const b64 = part.url.replace(/^data:image\/[^;]+;base64,/, "");
          log(`FOUND image: b64_len=${b64.length}`);

          // Send acknowledgment that we're analyzing
          const sessionId = (input as any).sessionID || (output as any).message?.sessionID;
          if (sessionId) {
            try {
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  noReply: true,
                  parts: [{ type: "text", text: "🔍 Analyzing image with Qwen 3.5..." }],
                },
              });
              log("sent analysis acknowledgment");
            } catch (e: any) {
              log(`failed to send acknowledgment: ${e.message}`);
            }
          }

          try {
            const description = await askVision(
              "Describe this image in detail.",
              b64,
            );
            log(`analysis: ${description.slice(0, 200)}`);

            const filename = `pasted-${Date.now()}.png`;
            writeFileSync(join(TEMP_DIR, filename), Buffer.from(b64, "base64"));

            // Replace the text part to include the analysis directly
            const textPart = parts.find((p: any) => p.type === "text");
            if (textPart && (textPart as any).text) {
              (textPart as any).text = `${(textPart as any).text}\n\n[Image Analysis by Qwen 3.5]:\n${description}`;
              log("injected analysis into user message text");
            } else if (sessionId) {
              // Fallback: inject as noReply prompt
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  noReply: true,
                  parts: [{ type: "text", text: `[Image Analysis (Qwen 3.5)]:\n${description}` }],
                },
              });
              log("injected as noReply fallback");
            }
          } catch (e: any) {
            log(`ERROR: ${e.message}`);
            // Inject error message so user knows something went wrong
            if (sessionId) {
              try {
                await client.session.prompt({
                  path: { id: sessionId },
                  body: {
                    noReply: true,
                    parts: [{ type: "text", text: `❌ Image analysis failed: ${e.message}` }],
                  },
                });
              } catch {}
            }
          }
        }
      }
    },

    tool: {
      vision: tool({
        description: "Analyze an image using an external vision model. Use when user asks about an image and current model lacks vision. Accepts file path, URL, or base64.",
        args: {
          image: tool.schema.string().describe("Image file path, URL, or base64 string"),
          prompt: tool.schema.string().optional().describe("What to ask about the image"),
        },
        async execute(args) {
          try {
            let b64: string;
            if (existsSync(args.image)) {
              b64 = readFileSync(args.image).toString("base64");
            } else if (/^data:image\//.test(args.image)) {
              b64 = args.image.replace(/^data:image\/[^;]+;base64,/, "");
            } else if (/^https?:\/\//.test(args.image)) {
              const res = await fetch(args.image);
              b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
            } else {
              b64 = args.image;
            }
            return await askVision(args.prompt || "Describe this image in detail.", b64);
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        },
      }),

      vision_text: tool({
        description: "Extract all text from an image (OCR). Use when user wants to read text from a screenshot.",
        args: {
          image: tool.schema.string().describe("Image file path, URL, or base64 string"),
        },
        async execute(args) {
          try {
            let b64: string;
            if (existsSync(args.image)) {
              b64 = readFileSync(args.image).toString("base64");
            } else if (/^data:image\//.test(args.image)) {
              b64 = args.image.replace(/^data:image\/[^;]+;base64,/, "");
            } else {
              b64 = args.image;
            }
            return await askVision("Extract and return ALL text visible in this image.", b64);
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        },
      }),
    },
  };
};
