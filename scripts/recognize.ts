import fs from "fs";
import path from "path";

// Load .env file manually if exists
function loadEnv() {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIndex = trimmed.indexOf("=");
            if (eqIndex > 0) {
                const key = trimmed.slice(0, eqIndex).trim();
                let value = trimmed.slice(eqIndex + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
    }
}

loadEnv();

interface ProdTag {
    id: number;
    title: string;
    videoCount?: number;
}

interface TagMatch {
    tag: string;
    confidence: number;
    reason: string;
}

interface GrokAnalysisResult {
    description: string;
    matchedTags: TagMatch[];
    genderCombination?: string;
    suggestedNewTags?: string[];
}

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".png":
            return "image/png";
        case ".webp":
            return "image/webp";
        case ".gif":
            return "image/gif";
        case ".avif":
            return "image/avif";
        case ".bmp":
            return "image/bmp";
        default:
            return "application/octet-stream";
    }
}

function findTargetImage(): string | null {
    // 1. Check if user passed a file argument
    const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    for (const arg of args) {
        const resolved = path.resolve(arg);
        if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
            return resolved;
        }
    }

    // 2. Check recognize / recognise folder
    const candidateDirs = [
        path.resolve(process.cwd(), "recognize"),
        path.resolve(process.cwd(), "recognise"),
    ];

    for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (SUPPORTED_EXTENSIONS.has(ext)) {
                return path.join(dir, file);
            }
        }
    }

    return null;
}

async function fetchProdTags(): Promise<ProdTag[]> {
    const prodUrl = "https://clip-flip.com/api/tags";
    try {
        console.log(`🌐 Fetching official tags from production pipeline (${prodUrl})...`);
        const response = await fetch(prodUrl, {
            headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
            throw new Error(`Prod API responded with status ${response.status}`);
        }
        const tags: ProdTag[] = await response.json();
        console.log(`✅ Loaded ${tags.length} official tags from production.`);
        return tags;
    } catch (error) {
        console.warn(`⚠️ Failed to reach prod API (${(error as Error).message}), attempting localhost...`);
        try {
            const localResponse = await fetch("http://localhost:3000/api/tags");
            if (localResponse.ok) {
                const localTags: ProdTag[] = await localResponse.json();
                console.log(`✅ Loaded ${localTags.length} tags from local server.`);
                return localTags;
            }
        } catch (_) {}
        throw new Error("Could not fetch tags from prod API or local server.");
    }
}

async function analyzeWithGrok(imagePath: string, officialTags: ProdTag[]): Promise<GrokAnalysisResult> {
    const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
    if (!apiKey) {
        console.error("\n❌ ERROR: XAI_API_KEY or GROK_API_KEY is not set.");
        console.error("👉 Please add XAI_API_KEY=your_key to your .env file or export it in your environment.\n");
        process.exit(1);
    }

    const model = process.env.GROK_MODEL || "grok-2-vision-1212";
    const mimeType = getMimeType(imagePath);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Data = imageBuffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const tagListString = officialTags.map((t) => t.title).join(", ");

    const systemPrompt = `You are an expert, objective adult media classification and content tagging AI for an explicit video and photo platform (ClipFlip).
You must analyze explicit adult, erotic, and NSFW images with complete technical precision, accuracy, and uncensored descriptive objectivity.
Do not censor, refuse, or shy away from anatomical or explicit sexual acts; precise taxonomy is essential.`;

    const userPrompt = `Analyze this explicit/adult image and categorize it using our official taxonomy.

Official ClipFlip Tags Available:
[${tagListString}]

Task instructions:
1. Provide a detailed, candid, and precise description of the image content (actors, gender combinations, positions, attire, sexual acts, anatomical details, camera angle, setting).
2. From the Official ClipFlip Tags list above, identify all tags that accurately apply to this image. Only select tags that are truly evident or strongly characteristic of the image. For each matched tag, provide a confidence score (1-100) and a brief reason.
3. Identify the gender combination tag if applicable (e.g., "f", "f+m", "f+f", "f+f+m", "f+m+m", "t", "t+f", "t+m", etc.).
4. If there are important elements in the image not covered by the official tags list, list them in "suggestedNewTags".

Output Format:
You MUST respond with valid JSON ONLY (inside \`\`\`json markdown fences or raw JSON), matching this structure:
{
  "description": "Comprehensive description of scene, actions, and details...",
  "genderCombination": "f+m",
  "matchedTags": [
    { "tag": "tag_name", "confidence": 95, "reason": "Explanation of why this tag applies" }
  ],
  "suggestedNewTags": ["any_extra_tags"]
}`;

    console.log(`🤖 Sending image to Grok Vision (${model})...`);

    const payload = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: [
                    {
                        type: "image_url",
                        image_url: {
                            url: dataUrl,
                            detail: "high",
                        },
                    },
                    {
                        type: "text",
                        text: userPrompt,
                    },
                ],
            },
        ],
        temperature: 0.2,
        max_tokens: 1500,
    };

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`xAI Grok API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const rawContent: string = data.choices?.[0]?.message?.content || "";

    // Parse JSON from response
    let jsonString = rawContent.trim();
    if (jsonString.includes("```")) {
        const match = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) jsonString = match[1];
    }

    try {
        const parsed: GrokAnalysisResult = JSON.parse(jsonString);
        return parsed;
    } catch (parseError) {
        console.warn("⚠️ Grok returned non-JSON text. Raw output:");
        console.log(rawContent);
        return {
            description: rawContent,
            matchedTags: [],
            suggestedNewTags: [],
        };
    }
}

async function main() {
    console.log("\n=======================================================");
    console.log("   ClipFlip Image Recognition & Auto-Tagging (Grok)");
    console.log("=======================================================\n");

    const imagePath = findTargetImage();
    if (!imagePath) {
        console.log("📁 No image found in ./recognize/");
        console.log("\n👉 How to use:");
        console.log("   1. Put an image into the 'recognize' folder (e.g. recognize/test.jpg)");
        console.log("   2. Run: npm run recognize");
        console.log("   (Or specify a path: npm run recognize path/to/image.jpg)\n");
        process.exit(0);
    }

    const stats = fs.statSync(imagePath);
    console.log(`🖼️  Image selected: ${path.basename(imagePath)}`);
    console.log(`   Path: ${imagePath}`);
    console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);

    const officialTags = await fetchProdTags();
    const result = await analyzeWithGrok(imagePath, officialTags);

    console.log("\n───────────────────────────────────────────────────────");
    console.log("📝 SCENE DESCRIPTION:");
    console.log("───────────────────────────────────────────────────────");
    console.log(result.description);

    if (result.genderCombination) {
        console.log(`\n👥 GENDER COMBINATION: [ ${result.genderCombination} ]`);
    }

    console.log("\n───────────────────────────────────────────────────────");
    console.log("🎯 MATCHED OFFICIAL CLIPFLIP TAGS:");
    console.log("───────────────────────────────────────────────────────");

    if (!result.matchedTags || result.matchedTags.length === 0) {
        console.log("No official tags matched with sufficient confidence.");
    } else {
        // Sort by confidence descending
        result.matchedTags.sort((a, b) => b.confidence - a.confidence);

        for (const match of result.matchedTags) {
            const barLength = Math.round(match.confidence / 10);
            const bar = "█".repeat(barLength) + "░".repeat(10 - barLength);
            console.log(`  • \x1b[32m\x1b[1m${match.tag.padEnd(20)}\x1b[0m [${bar}] ${match.confidence}% - ${match.reason}`);
        }

        const tagList = result.matchedTags.map((t) => t.tag).join(", ");
        console.log(`\n📋 Tag list (copy-ready): \x1b[36m${tagList}\x1b[0m`);
    }

    if (result.suggestedNewTags && result.suggestedNewTags.length > 0) {
        console.log("\n───────────────────────────────────────────────────────");
        console.log("💡 SUGGESTED NEW TAGS (not in official list):");
        console.log("───────────────────────────────────────────────────────");
        console.log(`  ${result.suggestedNewTags.join(", ")}`);
    }

    console.log("\n=======================================================\n");
}

main().catch((err) => {
    console.error("\n❌ Execution failed:", err.message);
    process.exit(1);
});
