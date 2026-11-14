export interface CrawlOptions {
    subreddit: string;
    limit?: number;
    timeFilter?: "day" | "week" | "month" | "year" | "all";
    order?: "top" | "trending" | "latest" | "hot";
    targetUrl?: string;
    tags?: string[];
    mode?: "auto" | "reddit" | "redgifs";
    maxSegmentsPerVideo?: number;
    dryRun?: boolean;
}

export interface ScrapedPost {
    id: string;
    title: string;
    subreddit: string;
    author?: string;
    score?: number;
    url: string;
    redgifsId?: string;
    permalink?: string;
    tags?: string[];
}

export interface RedGifsUrls {
    hd?: string;
    sd?: string;
    poster?: string;
    thumbnail?: string;
    silent?: string;
    html?: string;
}

export interface RedGifsMetadata {
    id: string;
    urls: RedGifsUrls;
    duration: number;
    tags?: string[];
    userName?: string;
    likes?: number;
    views?: number;
    title?: string;
}

export interface ProcessedSegment {
    tempKey: string;
    videoPath: string;
    firstThumbPath: string;
    midThumbPath: string;
    tempVideoName: string;
    tempFirstThumbName: string;
    tempMiddleThumbName: string;
    title: string;
    duration: number;
    startTime: number;
    endTime: number;
    seriesNr: number;
    seriesTotal: number;
    tags: string[];
}

export interface UploadBatchResult {
    success: boolean;
    uploadedCount: number;
    videos: Array<{ id: number; title?: string }>;
}
