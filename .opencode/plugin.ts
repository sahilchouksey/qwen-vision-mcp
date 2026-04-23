import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = process.env.QWEN_VISION_MODEL || "qwen3.5:cloud";
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const TEMP_DIR = join("/tmp", "qwen-vision");
const LOG_FILE = join(TEMP_DIR, "plugin.log");

mkdirSync(TEMP_DIR, { recursive: true });

// Global state: only one active model per plugin instance
let currentModelHasVision: boolean | undefined;
let currentModelId: string | undefined;

function log(msg: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

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

export const QwenVisionPlugin: Plugin = async ({ client }) => {
  return {
    // Inject vision instructions into system prompt for non-vision models
    "experimental.chat.system.transform": async (input, output) => {
      const hasVision = input.model?.capabilities?.input?.image ?? false;
      if (!hasVision) {
        output.system.push(
          `IMPORTANT: You have access to image analysis through an external vision plugin. When images are provided, the plugin automatically analyzes them and provides the analysis as an additional message. USE the analysis to answer questions about images. DO NOT say "I can't read images" — the analysis is provided for you.`
        );
        log(`system.transform: injected vision instructions for ${input.model?.id}`);
      } else {
        log(`system.transform: skipped — ${input.model?.id} has vision`);
      }
    },

    "chat.params": async (input) => {
      const hasVision = input.model?.capabilities?.input?.image ?? false;
      currentModelHasVision = hasVision;
      currentModelId = input.model?.id;
      log(`chat.params: model=${input.model?.id}, hasVision=${hasVision}`);
    },

    "chat.message": async (input, output) => {
      const parts = output.parts;

      // Determine if current model has vision capability
      // 1. Direct check on input.model (if available in this hook)
      let hasVision = (input as any).model?.capabilities?.input?.image;
      const modelId = (input as any).model?.id || currentModelId;

      // 2. Fall back to global state from chat.params (same model still active)
      if (hasVision === undefined && modelId && modelId === currentModelId) {
        hasVision = currentModelHasVision;
        log(`chat.message: used global state, model=${modelId}, hasVision=${hasVision}`);
      }

      // 3. If still unknown, try model ID string detection
      if (hasVision === undefined && modelId) {
        const id = modelId.toLowerCase();
        // Models definitively known to have vision
        if (
          id.includes("claude-3") || id.includes("claude-4") ||
          id.includes("gpt-4o") || id.includes("gpt-4-turbo") ||
          id.includes("gpt-5") || id.includes("gemini")
        ) {
          hasVision = true;
          log(`chat.message: detected vision model by ID=${modelId}`);
        }
      }

      // 4. Final fallback: if we still can't tell, default to running plugin
      // (better to analyze unnecessarily than fail on a non-vision model)
      if (hasVision === undefined) {
        log(`chat.message: could not detect vision capability for ${modelId}, defaulting to no vision`);
        hasVision = false;
      }

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
            } else {
              // Fallback: inject as noReply prompt (should be rare)
              const sessionId = (input as any).sessionID || (output as any).message?.sessionID;
              if (sessionId) {
                await client.session.prompt({
                  path: { id: sessionId },
                  body: {
                    noReply: true,
                    parts: [{ type: "text", text: `[Image Analysis (Qwen 3.5)]:\n${description}` }],
                  },
                });
                log("injected as noReply fallback");
              }
            }
          } catch (e: any) {
            log(`ERROR: ${e.message}`);
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
