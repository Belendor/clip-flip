import fs from "fs";
import path from "path";
import { VideoProcessor } from "./crawler/processor";
import { ClipFlipUploader } from "./crawler/uploader";
import type { ProcessedSegment, ScrapedPost } from "./crawler/types";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv"]);

function isVideo(filePath: string): boolean {
    return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function parseArgs(): { folder: string; tags: string[]; targetUrl: string; maxSegments: number } {
    const args = process.argv.slice(2);
    let folder = "";
    let tags: string[] = [];
    let targetUrl = process.env.CLIPFLIP_TARGET_URL || "https://clip-flip.com";
    let maxSegments = 10; // Default max segments per uncut video

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--folder" || arg === "-f") {
            folder = args[++i];
        } else if (arg === "--tag" || arg === "-t") {
            const raw = args[++i] || "";
            tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
        } else if (arg === "--target") {
            targetUrl = args[++i];
        } else if (arg === "--max-segments" || arg === "-m") {
            maxSegments = parseInt(args[++i], 10) || 10;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else if (!folder && !arg.startsWith("-")) {
            folder = arg;
        }
    }

    if (!folder) {
        // Default to a local folder named "uploads" in project root if not specified
        const defaultDir = path.resolve(process.cwd(), "uploads");
        if (fs.existsSync(defaultDir)) {
            folder = defaultDir;
        } else {
            console.error("❌ Error: Please specify a folder containing your videos.");
            printHelp();
            process.exit(1);
        }
    }

    return { folder: path.resolve(folder), tags, targetUrl, maxSegments };
}

function printHelp() {
    console.log(`
🎬 ClipFlip Local Video Batch Slicer & Uploader

Usage:
  npx tsx scripts/upload-folder.ts --folder <path-to-videos> [options]
  npm run upload:folder -- --folder <path-to-videos> [options]

Options:
  --folder, -f <path>        Path to folder containing your cut and uncut video files
  --tag, -t <tags>           Tags to attach (comma-separated, e.g. shemale,traps)
  --target <url>             Target ClipFlip server (default: https://clip-flip.com)
  --max-segments, -m <num>   Max 4-second segments per uncut video (default: 10)
  --help, -h                 Show this help message

Examples:
  npx tsx scripts/upload-folder.ts --folder "C:\\Videos\\ToProcess" --tag shemale
  npx tsx scripts/upload-folder.ts --folder ./uploads --tag "shemale,traps"
`);
}

async function main() {
    console.log("=================================================");
    console.log("🎬 ClipFlip Local Video Processor & Uploader");
    console.log("=================================================");

    const { folder, tags, targetUrl, maxSegments } = parseArgs();

    if (!fs.existsSync(folder)) {
        console.error(`❌ Folder not found: ${folder}`);
        process.exit(1);
    }

    const files = fs.readdirSync(folder)
        .map((f) => path.join(folder, f))
        .filter((f) => fs.statSync(f).isFile() && isVideo(f));

    if (files.length === 0) {
        console.log(`⚠️ No video files found in: ${folder}`);
        console.log(`Supported formats: ${Array.from(VIDEO_EXTENSIONS).join(", ")}`);
        process.exit(0);
    }

    console.log(`📁 Source folder: ${folder}`);
    console.log(`📹 Found ${files.length} video file(s) to process`);
    console.log(`🏷️  Tags: ${tags.length > 0 ? tags.join(", ") : "(none specified)"}`);
    console.log(`🌐 Target: ${targetUrl}`);
    console.log(`✂️  Max segments per uncut video: ${maxSegments}\n`);

    const processor = new VideoProcessor();
    const uploader = new ClipFlipUploader(targetUrl);
    const allProcessedSegments: ProcessedSegment[] = [];

    for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const fileName = path.basename(filePath);
        const nameWithoutExt = path.parse(fileName).name;

        console.log(`[${i + 1}/${files.length}] Processing: "${fileName}"`);

        const duration = processor.getVideoDuration(filePath);
        const isCut = duration <= 5.05 && duration >= 1.95;
        console.log(`  ⏱️  Duration: ${duration.toFixed(1)}s (${isCut ? "Already cut clip" : "Uncut video -> slicing"})`);

        const pseudoPost: ScrapedPost = {
            id: String(i + 1),
            title: nameWithoutExt,
            subreddit: tags[0] || "upload",
            url: filePath,
            tags,
        };

        try {
            const segments = processor.processVideo(
                filePath,
                pseudoPost,
                null,
                maxSegments
            );
            console.log(`  ✨ Created ${segments.length} segment(s) ready for ClipFlip!`);
            allProcessedSegments.push(...segments);
        } catch (err: any) {
            console.error(`  ❌ FFmpeg error processing "${fileName}":`, err.message || err);
        }
    }

    if (allProcessedSegments.length === 0) {
        console.log("\n⚠️ No video segments could be processed. Exiting.");
        return;
    }

    console.log(`\n🎉 Total prepared segments to upload: ${allProcessedSegments.length}`);

    try {
        const uploadResult = await uploader.uploadSegments(allProcessedSegments, tags);
        console.log("\n=================================================");
        console.log("🎉 UPLOAD COMPLETE!");
        console.log(`✅ Uploaded: ${uploadResult.uploadedCount} clips`);
        console.log(`🌐 Live at: ${targetUrl}`);
        console.log("📱 View the clips now in the ClipFlip web player under the 'New' tab!");
        console.log("=================================================\n");
    } finally {
        processor.cleanup(allProcessedSegments);
    }
}

main().catch((err) => {
    console.error("\n❌ Fatal error during upload:", err);
    process.exit(1);
});
