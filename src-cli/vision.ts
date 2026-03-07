import { readFileSync, statSync } from "node:fs";

export type VisionProvider = "openai" | "anthropic";

export interface VisionConfig {
  provider: VisionProvider;
  apiKey: string;
  model?: string;
}

const DEFAULT_MODELS: Record<VisionProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

const OCR_PROMPT = `Extract all readable text from this image. This may be a screenshot of a book, PDF, or document. Return only the extracted text, preserving paragraph structure. If you see any text at all, output it. Do not add commentary or formatting. If the image is blank or unreadable, return nothing.`;

/**
 * Extract text from an image using a vision API.
 */
export async function extractTextFromImage(
  imagePath: string,
  config: VisionConfig
): Promise<string> {
  const fileSize = statSync(imagePath).size;
  console.error(`  OCR: ${config.provider}/${config.model ?? DEFAULT_MODELS[config.provider]}, image ${(fileSize / 1024).toFixed(0)} KB`);
  const imageBuffer = readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");
  const mimeType = "image/png";

  const model = config.model ?? DEFAULT_MODELS[config.provider];

  if (config.provider === "openai") {
    return extractWithOpenAI(base64, mimeType, model, config.apiKey);
  }
  if (config.provider === "anthropic") {
    return extractWithAnthropic(base64, mimeType, model, config.apiKey);
  }

  throw new Error(`Unsupported vision provider: ${config.provider}`);
}

async function extractWithOpenAI(
  base64: string,
  mimeType: string,
  model: string,
  apiKey: string
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: OCR_PROMPT,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  return content?.trim() ?? "";
}

async function extractWithAnthropic(
  base64: string,
  mimeType: string,
  model: string,
  apiKey: string
): Promise<string> {
  const response = await fetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64,
                },
              },
              {
                type: "text",
                text: OCR_PROMPT,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content?.find((c) => c.type === "text");
  return textBlock?.text?.trim() ?? "";
}
