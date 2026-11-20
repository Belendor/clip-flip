import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import type { ProcessedSegment, RedGifsMetadata, ScrapedPost } from "./types";

interface SegmentRange {
    start: number;
    end: number;
    duration: number;
}

function calculateSegmentRanges(duration: number, maxSegments = 10): SegmentRange[] {
    if (duration <= 5.05 && duration >= 1.95) {
        return [{ start: 0, end: duration, duration }];
    }
    if (duration > 5.05 && duration < 6.0) {
        const half = parseFloat((duration / 2).toFixed(2));
        return [
            { start: 0, end: half, duration: half },
            { start: half, end: duration, duration: parseFloat((duration - half).toFixed(2)) },
        ];
    }
    const segmentLength = 4;
    const ranges: SegmentRange[] = [];
    let start = 0;
    while (start < duration && ranges.length < maxSegments) {
        const remaining = duration - start;
        if (remaining < 1.95) {
            if (ranges.length > 0 && (ranges[ranges.length - 1].duration + remaining) <= 5.05) {
                const last = ranges[ranges.length - 1];
                last.end = duration;
                last.duration = parseFloat((last.end - last.start).toFixed(2));
            }
            break;
        }
        if (remaining <= 5.05) {
            ranges.push({ start, end: duration, duration: parseFloat(remaining.toFixed(2)) });
            break;
        }
        const end = start + segmentLength;
        ranges.push({ start, end, duration: segmentLength });
        start = end;
    }
    return ranges;
}

export class VideoProcessor {
    private tempDir: string;
    private thumbsDir: string;

    constructor(baseTempDir?: string) {
        this.tempDir = baseTempDir || path.resolve(process.cwd(), "storage/temp/crawler/videos");
        this.thumbsDir = path.resolve(this.tempDir, "../thumbnails");

        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
        if (!fs.existsSync(this.thumbsDir)) fs.mkdirSync(this.thumbsDir, { recursive: true });
    }

    getTempDir(): string {
        return this.tempDir;
    }

    getVideoDuration(filePath: string): number {
        try {
            // First attempt with ffprobe
            const output = execFileSync(
                "ffprobe",
                [
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    filePath,
                ],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
            );
            const dur = parseFloat(output.trim());
            if (!isNaN(dur) && dur > 0) return dur;
        } catch (_) {}

        // Fallback: parse ffmpeg stderr
        try {
            execFileSync("ffmpeg", ["-i", filePath], {
                stdio: ["pipe", "pipe", "pipe"],
                encoding: "utf-8",
            });
        } catch (err: any) {
            const stderr = err.stderr ? err.stderr.toString() : "";
            const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
            if (match) {
                const hours = parseFloat(match[1]);
                const minutes = parseFloat(match[2]);
                const seconds = parseFloat(match[3]);
                return hours * 3600 + minutes * 60 + seconds;
            }
        }

        return 4.0;
    }

    processVideo(
        sourceFilePath: string,
        post: ScrapedPost,
        gifMeta?: RedGifsMetadata | null,
        maxSegments = 3
    ): ProcessedSegment[] {
        const duration = this.getVideoDuration(sourceFilePath);
        const segmentLength = 4;
        const results: ProcessedSegment[] = [];

        // Build merged tags
        const rawTags = [
            ...(post.tags || []),
            ...(gifMeta?.tags || []),
        ];
        const uniqueTags = Array.from(new Set(rawTags.map((t) => t.trim().toLowerCase()))).filter(
            (t) => t.length > 1 && !t.startsWith("r/")
        );

        // If subreddit relates to traps / trans / shemales, ensure 'shemale' tag is included
        const subLower = post.subreddit.toLowerCase();
        if (["traps", "shemales", "trans", "transporn", "ts", "femboy", "femboys"].some((k) => subLower.includes(k))) {
            if (!uniqueTags.includes("shemale")) {
                uniqueTags.push("shemale");
            }
        }

        const baseTitle = post.title || gifMeta?.title || `Clip from r/${post.subreddit}`;

        const ranges = calculateSegmentRanges(duration, maxSegments);
        const totalSegments = ranges.length;

        for (let idx = 0; idx < ranges.length; idx++) {
            const range = ranges[idx];
            const segNr = idx + 1;
            const mid = ((range.start + range.end) / 2).toFixed(2);

            const tempKey = crypto.randomUUID();
            const tempVideoName = `${tempKey}.mp4`;
            const tempFirstThumbName = `${tempKey}_first.jpg`;
            const tempMiddleThumbName = `${tempKey}_middle.jpg`;

            const videoOut = path.join(this.tempDir, tempVideoName);
            const firstOut = path.join(this.thumbsDir, tempFirstThumbName);
            const midOut = path.join(this.thumbsDir, tempMiddleThumbName);

            execFileSync(
                "ffmpeg",
                [
                    "-y",
                    "-ss", String(range.start),
                    "-i", sourceFilePath,
                    "-t", String(range.duration),
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-crf", "22",
                    "-maxrate", "6M",
                    "-bufsize", "12M",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-vf", "scale=min(1920\\,iw):-2",
                    videoOut,
                ],
                { stdio: "pipe" }
            );

            execFileSync(
                "ffmpeg",
                ["-y", "-ss", String(range.start), "-i", sourceFilePath, "-strict", "unofficial", "-frames:v", "1", firstOut],
                { stdio: "pipe" }
            );

            execFileSync(
                "ffmpeg",
                ["-y", "-ss", String(mid), "-i", sourceFilePath, "-strict", "unofficial", "-frames:v", "1", midOut],
                { stdio: "pipe" }
            );

            results.push({
                tempKey,
                videoPath: videoOut,
                firstThumbPath: firstOut,
                midThumbPath: midOut,
                tempVideoName,
                tempFirstThumbName,
                tempMiddleThumbName,
                title: baseTitle,
                duration: range.duration,
                startTime: range.start,
                endTime: range.end,
                seriesNr: segNr,
                seriesTotal: totalSegments,
                tags: uniqueTags,
            });
        }

        return results;
    }

    cleanup(segments: ProcessedSegment[]) {
        for (const seg of segments) {
            if (fs.existsSync(seg.videoPath)) fs.unlinkSync(seg.videoPath);
            if (fs.existsSync(seg.firstThumbPath)) fs.unlinkSync(seg.firstThumbPath);
            if (fs.existsSync(seg.midThumbPath)) fs.unlinkSync(seg.midThumbPath);
        }
    }
}
