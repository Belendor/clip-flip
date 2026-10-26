import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

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

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"]);

function isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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

function findTargetMedia(): string | null {
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
        // Prioritize videos if any, otherwise images
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (VIDEO_EXTENSIONS.has(ext)) {
                return path.join(dir, file);
            }
        }
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) {
                return path.join(dir, file);
            }
        }
    }

    return null;
}

function extractFramesFromVideo(videoPath: string, frameCount = 5): { framePaths: string[]; tempDir: string; duration: number } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipflip-frames-"));
    let duration = 10;

    try {
        const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
        const output = execSync(probeCmd, { encoding: "utf-8" }).trim();
        const parsed = parseFloat(output);
        if (!isNaN(parsed) && parsed > 0) duration = parsed;
    } catch (e) {
        console.warn("Could not determine exact duration with ffprobe, defaulting to 10s.");
    }

    console.log(`⏱️  Video duration: ${duration.toFixed(1)}s. Extracting ${frameCount} keyframes...`);
    const framePaths: string[] = [];

    for (let i = 0; i < frameCount; i++) {
        const pct = (i + 1) / (frameCount + 1);
        const timestamp = (pct * duration).toFixed(2);
        const outFrame = path.join(tempDir, `frame_${i + 1}.jpg`);

        try {
            execSync(`ffmpeg -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 "${outFrame}" -y -loglevel error`);
            if (fs.existsSync(outFrame)) {
                framePaths.push(outFrame);
            }
        } catch (err) {
            console.warn(`Failed to extract frame at ${timestamp}s:`, (err as Error).message);
        }
    }

    if (framePaths.length === 0) {
        throw new Error("FFmpeg failed to extract any frames from video.");
    }

    return { framePaths, tempDir, duration };
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

async function analyzeMediaWithGrok(mediaPath: string, officialTags: ProdTag[]): Promise<GrokAnalysisResult> {
    const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
    if (!apiKey) {
        console.error("\n❌ ERROR: XAI_API_KEY or GROK_API_KEY is not set.");
        console.error("👉 Please add XAI_API_KEY=your_key to your .env file or export it in your environment.\n");
        process.exit(1);
    }

    const model = process.env.GROK_MODEL || "grok-4.20-non-reasoning";
    const isVideo = isVideoFile(mediaPath);
    const tagListString = officialTags.map((t) => t.title).join(", ");

    let framesToAnalyze: string[] = [];
    let tempDirToClean: string | null = null;
    let videoDuration = 0;

    if (isVideo) {
        const extracted = extractFramesFromVideo(mediaPath, 5);
        framesToAnalyze = extracted.framePaths;
        tempDirToClean = extracted.tempDir;
        videoDuration = extracted.duration;
    } else {
        framesToAnalyze = [mediaPath];
    }

    const officialMap = new Map<string, string>();
    for (const tag of officialTags) {
        const raw = tag.title.toLowerCase().trim();
        officialMap.set(raw, tag.title);
        officialMap.set(raw.replace(/[\s\-_]+/g, ""), tag.title);
        officialMap.set(raw.replace(/\s+/g, "-"), tag.title);
        officialMap.set(raw.replace(/-/g, " "), tag.title);
    }

    const systemPrompt = `You are an expert, objective adult media classification and content tagging AI for an explicit video and photo platform (ClipFlip).
You must analyze explicit adult, erotic, and NSFW content with complete technical precision, accuracy, and uncensored descriptive objectivity.
Do not censor, refuse, or shy away from anatomical or explicit sexual acts; precise taxonomy is essential.`;

    const mediaTypeLabel = isVideo ? `video clip (${framesToAnalyze.length} chronological frames across ${videoDuration.toFixed(1)} seconds)` : "image";

    const userPrompt = `Analyze this explicit adult ${mediaTypeLabel} and categorize it using our official taxonomy.

ALLOWED OFFICIAL CLIPFLIP TAGS (${officialTags.length} tags total):
- Gender combinations: f, f+m, f+f, f+f+f, f+f+m, f+m+m, t, t+f, t+m, t+t, t+t+m
- Anatomy: ass, boobs, big boobs, cock, huge cock, feet, pussy
- Sexual acts: anal, blowjob, creampie, cum, deepthroat, double penetration, footjob, gangbang, gfj, handjob, humping, inserting, jerking, joi, kissing, rubbing, spanking, spitroast, tickling
- Positions: bending, cowgirl, reverse cowgirl, doggy, missionary, prone bone, the pose
- Attire & Clothing: panties, pantyhose, fishnets, high heels, lingerie, oil, stockings, under skirt, undressing
- Body & Person types: amateur, bbw, bbc, curvy, femdom, milf, old, pawg, petite, pregnant, redhead, black hair, shemale
- BDSM & Other: ballbusting, bondage, boob job, cfnm, chastity, choking, cuckold, flaccid, groping, pain, slapping, snooping, strapon, swinger, tease and denial, teen, walking

STRICT ENFORCEMENT RULES:
1. Every tag placed in "matchedTags" MUST be chosen EXCLUSIVELY from the ALLOWED OFFICIAL CLIPFLIP TAGS list above.
2. DO NOT invent, generate, or alter tag names in "matchedTags". Use the exact string as written (e.g. use "prone bone", not "prone"; use "big boobs", not "big breasts").
3. Systematically evaluate each tag in the allowed list: if visible or actively happening, include it in "matchedTags" with confidence (1-100) and brief reason.
4. If you observe something noteworthy in the scene that does NOT exist in our official tag list (such as "tattoo", "bedroom", "POV"), you MUST put it in "suggestedNewTags", NEVER in "matchedTags".

Output Format:
You MUST respond with valid JSON ONLY (inside \`\`\`json markdown fences or raw JSON), matching this structure:
{
  "description": "Comprehensive description of scene, actions, progression, and details...",
  "genderCombination": "f+m",
  "matchedTags": [
    { "tag": "exact_official_tag_name", "confidence": 95, "reason": "Explanation of why this tag applies" }
  ],
  "suggestedNewTags": ["any_extra_tags_not_in_official_list"]
}`;

    const contentArray: any[] = [];

    // Add each frame as an image_url
    for (let i = 0; i < framesToAnalyze.length; i++) {
        const framePath = framesToAnalyze[i];
        const mimeType = getMimeType(framePath);
        const imageBuffer = fs.readFileSync(framePath);
        const base64Data = imageBuffer.toString("base64");
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        if (isVideo) {
            contentArray.push({
                type: "text",
                text: `[Frame ${i + 1} of ${framesToAnalyze.length} - Chronological timeline]`,
            });
        }
        contentArray.push({
            type: "image_url",
            image_url: {
                url: dataUrl,
                detail: "high",
            },
        });
    }

    contentArray.push({
        type: "text",
        text: userPrompt,
    });

    console.log(`🤖 Sending ${framesToAnalyze.length} frame(s) to Grok Vision (${model})...`);

    try {
        const response = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: contentArray },
                ],
                temperature: 0.1,
                max_tokens: 1500,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`xAI Grok API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const rawContent: string = data.choices?.[0]?.message?.content || "";

        let jsonString = rawContent.trim();
        if (jsonString.includes("```")) {
            const match = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) jsonString = match[1];
        }

        let parsed: GrokAnalysisResult;
        try {
            parsed = JSON.parse(jsonString) as GrokAnalysisResult;
        } catch {
            console.warn("⚠️ Grok returned non-JSON text. Raw output:");
            console.log(rawContent);
            parsed = {
                description: rawContent,
                matchedTags: [],
                suggestedNewTags: [],
            };
        }

        // ── Strictly validate and filter matchedTags against official tags ──
        const validatedMatches: TagMatch[] = [];
        const seenTags = new Set<string>();
        const extraSuggested = new Set<string>(parsed.suggestedNewTags || []);

        for (const m of parsed.matchedTags || []) {
            if (!m || !m.tag) continue;
            const cleaned = m.tag.toLowerCase().trim();
            const canonical = officialMap.get(cleaned)
                || officialMap.get(cleaned.replace(/[\s\-_]+/g, ""))
                || officialMap.get(cleaned.replace(/\s+/g, "-"))
                || officialMap.get(cleaned.replace(/-/g, " "));

            if (canonical && !seenTags.has(canonical)) {
                seenTags.add(canonical);
                validatedMatches.push({
                    tag: canonical,
                    confidence: Math.min(100, Math.max(1, m.confidence || 80)),
                    reason: m.reason || "Detected in visual media"
                });
            } else if (!canonical) {
                // If tag was NOT in the official list, move to suggestedNewTags
                extraSuggested.add(m.tag);
            }
        }

        // Include gender combination if it is an official tag and not already added
        if (parsed.genderCombination) {
            const gcClean = parsed.genderCombination.toLowerCase().trim();
            const gcCanonical = officialMap.get(gcClean);
            if (gcCanonical && !seenTags.has(gcCanonical)) {
                seenTags.add(gcCanonical);
                validatedMatches.unshift({
                    tag: gcCanonical,
                    confidence: 98,
                    reason: `Identified participants: ${gcCanonical}`
                });
            }
        }

        parsed.matchedTags = validatedMatches;
        parsed.suggestedNewTags = Array.from(extraSuggested);
        return parsed;
    } finally {
        // Clean up temporary extracted frames
        if (tempDirToClean && fs.existsSync(tempDirToClean)) {
            try {
                fs.rmSync(tempDirToClean, { recursive: true, force: true });
            } catch (_) {}
        }
    }
}

async function main() {
    console.log("\n=======================================================");
    console.log("   ClipFlip Media Recognition & Auto-Tagging (Grok)");
    console.log("=======================================================\n");

    const mediaPath = findTargetMedia();
    if (!mediaPath) {
        console.log("📁 No image or video found in ./recognize/");
        console.log("\n👉 How to use:");
        console.log("   1. Put an image (.jpg, .png, .webp) or video (.mp4, .webm, .mov) in ./recognize/");
        console.log("   2. Run: npm run recognize");
        console.log("   (Or specify a path: npm run recognize path/to/video.mp4)\n");
        process.exit(0);
    }

    const stats = fs.statSync(mediaPath);
    const isVideo = isVideoFile(mediaPath);
    console.log(`${isVideo ? "🎬 Video" : "🖼️  Image"} selected: ${path.basename(mediaPath)}`);
    console.log(`   Path: ${mediaPath}`);
    console.log(`   Size: ${(stats.size / 1024 / (isVideo ? 1024 : 1)).toFixed(1)} ${isVideo ? "MB" : "KB"}`);

    const officialTags = await fetchProdTags();
    const result = await analyzeMediaWithGrok(mediaPath, officialTags);

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
