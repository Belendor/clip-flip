import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import type { ProcessedSegment, UploadBatchResult } from "./types";

export class ClipFlipUploader {
    private targetBaseUrl: string;

    constructor(targetUrl = "https://clip-flip.com") {
        // Strip trailing slash
        this.targetBaseUrl = targetUrl.replace(/\/+$/, "");
    }

    async uploadSegments(
        segments: ProcessedSegment[],
        commonTags: string[] = []
    ): Promise<UploadBatchResult> {
        if (!segments || segments.length === 0) {
            return { success: true, uploadedCount: 0, videos: [] };
        }

        const BATCH_SIZE = 10;
        const allUploaded: Array<{ id: number; title?: string }> = [];

        console.log(`\n🚀 [4/4] Uploading ${segments.length} prepared segments to ClipFlip server (${this.targetBaseUrl})...`);

        for (let i = 0; i < segments.length; i += BATCH_SIZE) {
            const batch = segments.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

            console.log(`  📤 Uploading batch ${batchNumber}/${totalBatches} (${batch.length} clips)...`);

            const formData = new FormData();

            // Merge tags from batch segments and common tags
            const mergedTags = Array.from(
                new Set([
                    ...commonTags,
                    ...batch.flatMap((s) => s.tags || []),
                ])
            ).filter(Boolean);

            const payloadSegments = batch.map((seg) => ({
                tempKey: seg.tempKey,
                tempVideoName: seg.tempVideoName,
                tempFirstThumbName: seg.tempFirstThumbName,
                tempMiddleThumbName: seg.tempMiddleThumbName,
                title: seg.title,
                seriesNr: seg.seriesNr,
                seriesTotal: seg.seriesTotal,
                startTime: seg.startTime,
                endTime: seg.endTime,
            }));

            formData.append(
                "metadata",
                JSON.stringify({
                    segments: payloadSegments,
                    tags: mergedTags,
                })
            );

            for (const seg of batch) {
                if (fs.existsSync(seg.videoPath)) {
                    formData.append("videos", fs.createReadStream(seg.videoPath), seg.tempVideoName);
                }
                if (fs.existsSync(seg.firstThumbPath)) {
                    formData.append("thumbs", fs.createReadStream(seg.firstThumbPath), seg.tempFirstThumbName);
                }
                if (fs.existsSync(seg.midThumbPath)) {
                    formData.append("thumbs", fs.createReadStream(seg.midThumbPath), seg.tempMiddleThumbName);
                }
            }

            // Target endpoint: if using https://clip-flip.com, hit /api/confirm-segments
            // If hitting local dev directly on port 3000, hit /confirm-segments
            const endpoint = this.targetBaseUrl.includes("localhost") || this.targetBaseUrl.includes(":3000")
                ? `${this.targetBaseUrl}/confirm-segments`
                : `${this.targetBaseUrl}/api/confirm-segments`;

            try {
                const response = await axios.post(endpoint, formData, {
                    headers: {
                        ...formData.getHeaders(),
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    timeout: 180000, // 3 minutes timeout
                });

                if (response.data && response.data.videos) {
                    allUploaded.push(...response.data.videos);
                    console.log(`    ✅ Batch ${batchNumber} saved! ${response.data.videos.length} new clips added.`);
                }
            } catch (err: any) {
                const errMsg = err.response?.data?.error || err.message || "Unknown upload error";
                console.error(`    ❌ Batch ${batchNumber} failed:`, errMsg);
                throw new Error(`Upload failed: ${errMsg}`);
            }
        }

        return {
            success: true,
            uploadedCount: allUploaded.length,
            videos: allUploaded,
        };
    }
}
