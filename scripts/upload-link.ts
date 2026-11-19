import fs from "fs";
import path from "path";
import axios from "axios";
import { VideoProcessor } from "./crawler/processor";
import { ClipFlipUploader } from "./crawler/uploader";
import type { ProcessedSegment, ScrapedPost } from "./crawler/types";

function parseArgs(): {
    urls: string[];
    title?: string;
    tags: string[];
    targetUrl: string;
    maxSegments: number;
} {
    const args = process.argv.slice(2);
    const urls: string[] = [];
    let title: string | undefined;
    let tags: string[] = [];
    let targetUrl = process.env.CLIPFLIP_TARGET_URL || "https://clip-flip.com";
    let maxSegments = 10;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--url" || arg === "-u") {
            const raw = args[++i] || "";
            urls.push(...raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean));
        } else if (arg === "--title") {
            title = args[++i];
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
        } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
            urls.push(arg.trim());
        }
    }

    if (urls.length === 0) {
        console.error("❌ Error: Please provide at least one video URL with --url <link>");
        printHelp();
        process.exit(1);
    }

    return { urls, title, tags, targetUrl, maxSegments };
}

function printHelp() {
    console.log(`
🎬 ClipFlip URL Downloader, Slicer & Uploader (Auto-deletes from PC)

Usage:
  npx tsx scripts/upload-link.ts --url <link> [options]
  npm run upload:link -- --url <link> [options]

Options:
  --url, -u <link>           Direct video URL or RedGIFs link (e.g. https://media.redgifs.com/...m4s or .mp4)
  --title <title>            Title for the clips (optional)
  --tag, -t <tags>           Tags comma-separated (e.g. shemale,traps)
  --target <url>             Target ClipFlip server (default: https://clip-flip.com)
  --max-segments, -m <num>   Max 4-second segments to create per uncut video (default: 10)
  --help, -h                 Show this help message

Examples:
  npm run upload:link -- --url "https://media.redgifs.com/DangerousNumbPrimate.m4s" --tag shemale
  npm run upload:link -- --url "https://media.redgifs.com/DangerousNumbPrimate.m4s" --title "Dangerous Primate" --tag "shemale,traps"
`);
}

interface RedGifsDetail {
    uploader?: string;
    videoId?: string;
    tags?: string[];
    mediaUrl?: string;
}

async function fetchRedGifsDetails(url: string): Promise<RedGifsDetail> {
    const match =
        url.match(/redgifs\.com\/(?:watch\/|ifr\/)([a-zA-Z0-9]+)/i) ||
        url.match(/redgifs\.com\/(?:[a-zA-Z0-9_\/]*\/)?([a-zA-Z0-9]+)(?:-mobile|-silent)?\.(?:m4s|mp4|webm)/i);

    if (!match) {
        return {};
    }

    const rawId = match[1];
    try {
        const authRes = await axios.get("https://api.redgifs.com/v2/auth/temporary", {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
        });
        const token = authRes.data?.token;
        if (!token) return { videoId: rawId };

        const gifRes = await axios.get(`https://api.redgifs.com/v2/gifs/${rawId.toLowerCase()}`, {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" },
            timeout: 10000,
        });

        const gif = gifRes.data?.gif;
        if (!gif) return { videoId: rawId };

        let casedId = rawId;
        if (gif.urls?.hd) {
            const hdMatch = gif.urls.hd.match(/redgifs\.com\/([a-zA-Z0-9]+)\.mp4/i);
            if (hdMatch) casedId = hdMatch[1];
        }

        return {
            uploader: gif.userName || undefined,
            videoId: casedId,
            tags: gif.tags || [],
            mediaUrl: gif.urls?.hd || undefined,
        };
    } catch (_) {
        return { videoId: rawId };
    }
}

async function downloadFile(url: string, destPath: string): Promise<{ finalUrl: string; detail: RedGifsDetail }> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const detail = await fetchRedGifsDetails(url);
    const finalUrl = detail.mediaUrl || url;

    const response = await axios({
        method: "GET",
        url: finalUrl,
        responseType: "stream",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Referer: "https://www.redgifs.com/",
        },
        timeout: 180000,
    });

    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
        writer.on("finish", () => {
            writer.close();
            resolve();
        });
        writer.on("error", (err) => {
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
        });
    });

    return { finalUrl, detail };
}

async function main() {
    console.log("=================================================");
    console.log("⚡ ClipFlip Link Ingestion Worker (Auto-clean)");
    console.log("=================================================");

    const { urls, title, tags, targetUrl, maxSegments } = parseArgs();

    console.log(`🔗 URLs to process: ${urls.length}`);
    console.log(`🏷️  Tags: ${tags.length > 0 ? tags.join(", ") : "(none specified)"}`);
    console.log(`🌐 Target Server: ${targetUrl}`);
    console.log(`✂️  Max segments per video: ${maxSegments}\n`);

    const processor = new VideoProcessor();
    const uploader = new ClipFlipUploader(targetUrl);
    const tempDir = processor.getTempDir();

    const allProcessedSegments: ProcessedSegment[] = [];
    const tempDownloads: string[] = [];

    for (let i = 0; i < urls.length; i++) {
        const rawUrl = urls[i];
        console.log(`[${i + 1}/${urls.length}] Fetching: ${rawUrl}`);

        const tempDownloadPath = path.join(tempDir, `temp_url_${Date.now()}_${i}.mp4`);
        tempDownloads.push(tempDownloadPath);

        try {
            console.log(`  ⬇️ Downloading video stream & querying RedGIFs metadata...`);
            const { finalUrl, detail } = await downloadFile(rawUrl, tempDownloadPath);

            const duration = processor.getVideoDuration(tempDownloadPath);
            const isCut = duration <= 5.05 && duration >= 1.95;
            console.log(`  ⏱️  Duration: ${duration.toFixed(1)}s (${isCut ? "Already cut clip" : "Uncut video -> slicing with FFmpeg"})`);

            if (detail.uploader) {
                console.log(`  👤 Uploader / Model: ${detail.uploader}`);
            }

            const urlObj = new URL(finalUrl);
            const fileName = path.basename(urlObj.pathname);
            const nameWithoutExt = detail.videoId || path.parse(fileName).name;

            // Automatic title format: uploader,videoId (e.g. alicefruity,DangerousNumbPrimate)
            const autoTitle = detail.uploader ? `${detail.uploader},${nameWithoutExt}` : nameWithoutExt;
            const clipTitle = title && String(title).trim() ? String(title).trim() : autoTitle;
            console.log(`  🏷️  Title: "${clipTitle}"`);

            const mergedTags = Array.from(new Set([...tags, ...(detail.tags || [])]));

            const pseudoPost: ScrapedPost = {
                id: String(Date.now() + i),
                title: clipTitle,
                subreddit: tags[0] || "link-import",
                url: finalUrl,
                tags: mergedTags,
            };

            const segments = processor.processVideo(
                tempDownloadPath,
                pseudoPost,
                null,
                maxSegments
            );

            console.log(`  ✨ Created ${segments.length} segment(s) ready for ClipFlip!`);
            allProcessedSegments.push(...segments);
        } catch (err: any) {
            console.error(`  ❌ Error processing URL "${rawUrl}":`, err.message || err);
        } finally {
            // Delete raw download file immediately
            if (fs.existsSync(tempDownloadPath)) {
                try {
                    fs.unlinkSync(tempDownloadPath);
                    console.log(`  🗑️  Raw downloaded video deleted from disk.`);
                } catch (_) {}
            }
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
        console.log("🎉 LINK IMPORT & UPLOAD COMPLETE!");
        console.log(`✅ Uploaded: ${uploadResult.uploadedCount} clips to ${targetUrl}`);
        console.log("🗑️  All temporary files and segments have been DELETED from your computer.");
        console.log("📱 View the clips now in the ClipFlip web player under the 'New' tab!");
        console.log("=================================================\n");
    } finally {
        // ALWAYS clean up all sliced segment binaries and thumbnails!
        processor.cleanup(allProcessedSegments);
        console.log("🧹 Cleanup complete: 0 bytes retained on local machine.");
    }
}

main().catch((err) => {
    console.error("\n❌ Fatal error during link ingestion:", err);
    process.exit(1);
});
