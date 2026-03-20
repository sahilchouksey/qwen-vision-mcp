# Qwen Vision MCP

MCP server that adds **image analysis capabilities** to AI models that don't natively support vision.

[![npm version](https://img.shields.io/npm/v/qwen-vision-mcp)](https://www.npmjs.com/package/qwen-vision-mcp)

## Why?

Models like **MiMo V2 Pro**, **MiniMax M2.1**, **Nemotron 3**, and many others are powerful for text but cannot read or analyze images. This MCP server bridges that gap by routing image tasks to **Qwen 3.5** via Ollama — giving any model vision capabilities through tool calls.

## How It Works

```
Your model (MiMo V2 Pro, etc.)  →  calls qwen-vision tool  →  Qwen 3.5 analyzes image  →  returns result
```

The vision model can be:
- **Ollama Cloud** (`qwen3.5:cloud`) — fast, no local resources needed
- **Local Ollama** (`qwen3.5:9b`, `qwen3.5:4b`) — private, runs on your machine

## Prerequisites

- **Ollama** installed (`brew install ollama` or `curl -fsSL https://ollama.ai/install.sh | sh`)
- **Ollama authentication** — sign in with `ollama` and authenticate your account
- **`ollama serve`** running — only required if using a local model (`qwen3.5:9b`, `qwen3.5:4b`)

## Tools

| Tool | Description |
|------|-------------|
| `analyze_image` | Ask any question about an image |
| `extract_text` | OCR: extract all visible text |
| `describe_image` | Detailed image description |
| `compare_images` | Compare two images side-by-side |
| `analyze_screenshot` | UI screenshot analysis with structured output |

### Input Formats

- File paths: `/path/to/image.png`
- URLs: `https://example.com/image.jpg`
- Base64 data URIs

## Setup

### 1. Pull the model

```bash
# Cloud (recommended — no local resources needed)
ollama pull qwen3.5:cloud

# Or local (requires ~6GB RAM for 9B)
ollama pull qwen3.5:9b
```

### 2. Add to opencode config (`~/.config/opencode/opencode.json`)

#### Option A: Ollama Cloud (recommended)

No local resources needed, just Ollama authentication.

```json
{
  "qwen-vision": {
    "type": "local",
    "command": ["npx", "-y", "qwen-vision-mcp"],
    "environment": {
      "QWEN_VISION_MODEL": "qwen3.5:cloud",
      "OLLAMA_BASE_URL": "http://localhost:11434",
      "QWEN_VISION_THINK": "false"
    },
    "enabled": true,
    "timeout": 30000
  }
}
```

#### Option B: Local Ollama

Requires `ollama serve` running and ~6GB RAM for `qwen3.5:9b`.

```json
{
  "qwen-vision": {
    "type": "local",
    "command": ["npx", "-y", "qwen-vision-mcp"],
    "environment": {
      "QWEN_VISION_MODEL": "qwen3.5:9b",
      "OLLAMA_BASE_URL": "http://localhost:11434",
      "QWEN_VISION_THINK": "false"
    },
    "enabled": true,
    "timeout": 30000
  }
}
```

Other local options: `qwen3.5:4b` (~3GB RAM), `qwen3.5:2b` (~1.5GB RAM).

### 3. Restart opencode

```bash
opencode
```

The `qwen-vision_*` tools will be available to any model — even ones without native vision.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_VISION_MODEL` | `qwen3.5:cloud` | Ollama model name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `QWEN_VISION_THINK` | `false` | Enable thinking/reasoning mode |

## Development

```bash
git clone https://github.com/sahilchouksey/qwen-vision-mcp.git
cd qwen-vision-mcp
bun install
bun run dev
```

## License

MIT
