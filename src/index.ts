import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Ollama } from "ollama";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 400_000; // 400KB per image

async function resizeIfNeeded(b64: string): Promise<string> {
  const buf = Buffer.from(b64, "base64");
  if (buf.length <= MAX_IMAGE_BYTES) return b64;
  console.error(`Resizing ${Math.round(buf.length / 1024)}KB -> target ${MAX_IMAGE_BYTES / 1024}KB`);
  const resized = await sharp(buf)
    .resize({ width: 800, withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  console.error(`Resized to ${Math.round(resized.length / 1024)}KB`);
  return resized.toString("base64");
}

const MODEL_NAME = process.env.QWEN_VISION_MODEL || "qwen3.5:cloud";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const THINK = process.env.QWEN_VISION_THINK?.toLowerCase() === "true";

const ollama = new Ollama({ host: OLLAMA_BASE_URL });

const server = new McpServer({
  name: "qwen-vision",
  version: "0.1.0",
  instructions: `This server provides vision/image analysis tools powered by Qwen 3.5. Use these tools when you need to analyze, read, or describe images.

IMPORTANT: When an image appears in the conversation as base64 data (starts with "iVBOR" or "/9j/" or similar), pass the raw base64 string directly to the tool's image_path parameter. The tool accepts:
- File paths: /absolute/path/to/image.png
- URLs: https://example.com/image.jpg
- Raw base64 strings: iVBORw0KGgo...
- Data URIs: data:image/png;base64,iVBOR...

Always prefer these tools over guessing what an image contains.`,
});

async function loadImageBase64(input: string): Promise<string> {
  // URL
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  }

  // Base64 data URI
  if (/^data:image\//.test(input)) {
    return input.replace(/^data:image\/[^;]+;base64,/, "");
  }

  // Raw base64 (long string, no path separators)
  if (/^[A-Za-z0-9+/=]{100,}$/.test(input)) {
    return input;
  }

  // File path - try direct
  if (existsSync(input)) {
    return readFileSync(input).toString("base64");
  }

  // Unicode fix: scan parent dir for matching file
  if (input.startsWith("/")) {
    try {
      const dir = dirname(input);
      const target = basename(input).normalize("NFC");
      const files = readdirSync(dir);
      const match = files.find(
        (f) => f === target || f.normalize("NFC") === target,
      );
      if (match) {
        return readFileSync(join(dir, match)).toString("base64");
      }
    } catch {}
  }

  throw new Error(`Cannot read image: "${input}"`);
}

async function chatWithImage(
  prompt: string,
  images: string[],
): Promise<string> {
  const resized = await Promise.all(images.map(resizeIfNeeded));
  const response = await ollama.chat({
    model: MODEL_NAME,
    messages: [
      {
        role: "user",
        content: prompt,
        images: resized,
      },
    ],
    think: THINK,
  });
  return response.message.content;
}

// Tool 1: analyze_image
server.tool(
  "analyze_image",
  "Analyze an image using a vision model. IMPORTANT: Pass the image as a file path (/path/to/image.png), URL (https://...), OR raw base64 string (iVBORw0KGgo...). If base64 data appears in conversation, pass it directly to image_path.",
  {
    image_path: z.string().describe("Image input: file path, URL, or raw base64 string. If you have base64 data, pass it directly here."),
    prompt: z.string().optional().default("Describe this image in detail.").describe("Question or instruction about the image"),
  },
  async ({ image_path, prompt }) => {
    try {
      const b64 = await loadImageBase64(image_path);
      const result = await chatWithImage(prompt, [b64]);
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Tool 2: extract_text (OCR)
server.tool(
  "extract_text",
  "Extract all visible text from an image (OCR). Pass image as file path, URL, or raw base64 string. If base64 data appears in conversation, pass it directly to image_path.",
  {
    image_path: z.string().describe("Image input: file path, URL, or raw base64 string. If you have base64 data, pass it directly here."),
  },
  async ({ image_path }) => {
    try {
      const b64 = await loadImageBase64(image_path);
      const result = await chatWithImage(
        "Extract and return ALL text visible in this image. Output only the text, no commentary.",
        [b64],
      );
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Tool 3: describe_image
server.tool(
  "describe_image",
  "Generate a detailed description of an image. Pass image as file path, URL, or raw base64 string. If base64 data appears in conversation, pass it directly to image_path.",
  {
    image_path: z.string().describe("Image input: file path, URL, or raw base64 string. If you have base64 data, pass it directly here."),
  },
  async ({ image_path }) => {
    try {
      const b64 = await loadImageBase64(image_path);
      const result = await chatWithImage(
        "Describe this image in detail. Include objects, colors, layout, text, and any notable elements.",
        [b64],
      );
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Tool 4: compare_images
server.tool(
  "compare_images",
  "Compare two images and describe similarities and differences. Pass each image as file path, URL, or raw base64 string.",
  {
    image1: z.string().describe("First image: file path, URL, or raw base64 string"),
    image2: z.string().describe("Second image: file path, URL, or raw base64 string"),
  },
  async ({ image1, image2 }) => {
    try {
      const [b64_1, b64_2] = await Promise.all([
        loadImageBase64(image1),
        loadImageBase64(image2),
      ]);
      const result = await chatWithImage(
        "Compare these two images in detail. Describe similarities and differences in content, style, layout, and any other notable aspects.",
        [b64_1, b64_2],
      );
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Tool 5: analyze_screenshot
server.tool(
  "analyze_screenshot",
  "Analyze a UI screenshot and describe its components. Pass image as file path, URL, or raw base64 string.",
  {
    image_path: z.string().describe("Screenshot: file path, URL, or raw base64 string"),
  },
  async ({ image_path }) => {
    try {
      const b64 = await loadImageBase64(image_path);
      const result = await chatWithImage(
        "Analyze this UI screenshot. Describe: 1) What app/website is this? 2) List all visible UI components (buttons, inputs, menus, etc.) 3) What actions can the user take? 4) Any text content visible.",
        [b64],
      );
      return { content: [{ type: "text", text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("qwen-vision MCP server running (stdio)");
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
