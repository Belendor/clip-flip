import path from "path";
import fs from "fs";
import { RedGifsClient } from "./redgifs";
import { RedditCrawler } from "./reddit";
import { VideoProcessor } from "./processor";
import { ClipFlipUploader } from "./uploader";
import type { CrawlOptions, ProcessedSegment } from "./types";

// Load .env manually if present
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

function parseArgs(): CrawlOptions {
    const args = process.argv.slice(2);
    const options: CrawlOptions = {
        subreddit: "traps",
        limit: 10,
        timeFilter: "month",
        order: "top",
        targetUrl: process.env.CLIPFLIP_TARGET_URL || "https://clip-flip.com",
        maxSegmentsPerVideo: 3,
        tags: [],
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--subreddit" || arg === "-s") {
            options.subreddit = args[++i];
        } else if (arg === "--limit" || arg === "-l") {
            options.limit = parseInt(args[++i], 10) || 10;
        } else if (arg === "--time" || arg === "-t") {
            options.timeFilter = (args[++i] || "month") as any;
        } else if (arg === "--order" || arg === "-o") {
            options.order = (args[++i] || "top") as any;
        } else if (arg === "--target") {
            options.targetUrl = args[++i];
        } else if (arg === "--tag") {
            const raw = args[++i] || "";
            options.tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
        } else if (arg === "--max-segments") {
            options.maxSegmentsPerVideo = parseInt(args[++i], 10) || 3;
        } else if (arg === "--mode") {
            options.mode = args[++i] as any;
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
🎬 ClipFlip Subreddit & RedGIFs Crawler + Ingestion Worker

Usage:
  npx tsx scripts/crawler/cli.ts [options]
  npm run crawl -- [options]

Options:
  --subreddit, -s <name>     Subreddit name to crawl (default: traps)
  --limit, -l <number>       Max posts/videos to process (default: 10)
  --time, -t <window>        Time filter: day, week, month, year, all (default: month)
  --order, -o <sort>         Sort order: top, trending, latest, hot (default: top)
  --target <url>             ClipFlip instance URL (default: https://clip-flip.com)
  --tag <tags>               Additional tags comma-separated (e.g. shemale,traps)
  --max-segments <n>         Max 4-second segments per video (default: 3)
  --mode <auto|reddit|redgifs> Extraction mode (default: auto)
  --dry-run                  Download and slice without uploading
  --help, -h                 Show this help message

Environment Variables (.env):
  REDDIT_CLIENT_ID           Optional Reddit App Client ID for OAuth
  REDDIT_CLIENT_SECRET       Optional Reddit App Secret for OAuth
  CLIPFLIP_TARGET_URL        Target ClipFlip instance (default: https://clip-flip.com)
`);
}

async function run() {
    console.log("=================================================");
    console.log("🚀 ClipFlip Subreddit & RedGIFs Crawler Worker");
    console.log("=================================================");

    const options = parseArgs();
    console.log("Configuration:", {
        subreddit: options.subreddit,
        limit: options.limit,
        time: options.timeFilter,
        order: options.order,
        targetUrl: options.targetUrl,
        tags: options.tags,
        maxSegments: options.maxSegmentsPerVideo,
    });

    const redgifs = new RedGifsClient();
    const reddit = new RedditCrawler(redgifs);
    const processor = new VideoProcessor();
    const uploader = new ClipFlipUploader(options.targetUrl);

    // Phase 1: Scrape posts
    const posts = await reddit.crawl(options);
    if (posts.length === 0) {
        console.log("⚠️ No posts found for the specified criteria. Exiting.");
        return;
    }

    // Phase 2 & 3: Download and process each post
    console.log(`\n📦 [2/4] Downloading HD videos from RedGIFs and extracting metadata...`);
    const allProcessedSegments: ProcessedSegment[] = [];
    const tempDownloads: string[] = [];

    const tempDir = processor.getTempDir();

    for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        console.log(`\n[${i + 1}/${posts.length}] Processing: "${post.title.slice(0, 60)}"`);

        let redgifsId = post.redgifsId || redgifs.extractId(post.url);
        if (!redgifsId) {
            console.log(`  ⏩ Skipping: No RedGIFs link found in post (${post.url})`);
            continue;
        }

        try {
            console.log(`  🔍 Fetching RedGIFs info for ID: ${redgifsId}...`);
            const gifMeta = await redgifs.getGif(redgifsId);
            if (!gifMeta || !gifMeta.urls?.hd) {
                console.warn(`  ⚠️ Could not get HD video URL for ${redgifsId}`);
                continue;
            }

            const downloadDest = path.join(tempDir, `raw_${redgifsId}.mp4`);
            tempDownloads.push(downloadDest);

            console.log(`  ⬇️ Downloading HD MP4 (${gifMeta.duration}s)...`);
            await redgifs.downloadFile(gifMeta.urls.hd, downloadDest);

            console.log(`  ✂️ [3/4] Slicing & generating thumbnails with FFmpeg...`);
            const segments = processor.processVideo(
                downloadDest,
                post,
                gifMeta,
                options.maxSegmentsPerVideo || 3
            );

            console.log(`  ✨ Created ${segments.length} segment(s) ready for ClipFlip!`);
            allProcessedSegments.push(...segments);
        } catch (err: any) {
            console.error(`  ❌ Error processing post "${post.title}":`, err.message || err);
        }
    }

    // Clean up raw downloads
    for (const raw of tempDownloads) {
        if (fs.existsSync(raw)) {
            try {
                fs.unlinkSync(raw);
            } catch (_) {}
        }
    }

    if (allProcessedSegments.length === 0) {
        console.log("\n⚠️ No video segments could be processed. Exiting.");
        return;
    }

    console.log(`\n🎉 Total prepared segments ready for upload: ${allProcessedSegments.length}`);

    // Phase 4: Upload to ClipFlip server
    if (options.dryRun) {
        console.log("🏁 Dry run requested: skipping upload to server.");
        processor.cleanup(allProcessedSegments);
        return;
    }

    try {
        const uploadResult = await uploader.uploadSegments(
            allProcessedSegments,
            options.tags || []
        );

        console.log("\n=================================================");
        console.log("🎉 CRAWL & INGESTION COMPLETE!");
        console.log(`✅ Uploaded: ${uploadResult.uploadedCount} new clips`);
        console.log(`🌐 Target Server: ${options.targetUrl}`);
        console.log("📱 View the clips now in the ClipFlip web player under the 'New' tab!");
        console.log("=================================================\n");
    } finally {
        // Clean up segment binaries and thumbs
        processor.cleanup(allProcessedSegments);
    }
}

run().catch((error) => {
    console.error("\n❌ Fatal error in crawler worker:", error);
    process.exit(1);
});
