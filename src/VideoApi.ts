import type { Tag, Video, VideoWithRelations, UpdateVideoPayload, NewVideo } from "./types";
import { config } from './config';

export default class VideoApi {
    constructor() { }

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetch(`${config.apiUrl}${path}`, init);
        if (!response.ok) {
            throw new Error(`Request failed (${response.status}) for ${path}`);
        }
        return response.json() as Promise<T>;
    }

    async fetchTags(search?: string): Promise<Tag[]> {
        const query = search ? `?search=${encodeURIComponent(search)}` : "";
        return this.request<Tag[]>(`/tags${query}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
    }

    async fetchNewVideos(): Promise<NewVideo[]> {
        return this.request<NewVideo[]>(`/new`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
    }

    async fetchLikedVideos(userId: number): Promise<VideoWithRelations[]> {
        return this.request<VideoWithRelations[]>(`/videos/favorites/${userId}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
    }

    async fetchVideosByTags(tags: string[], limit: number): Promise<Video[]> {
        return this.request<Video[]>("/videos/by-tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags, limit, matchType: "all" }),
        });
    }

    private tagsByTitleCache = new Map<string, Promise<Tag[]>>();

    async fetchTagsByTitle(title: string): Promise<Tag[]> {
        const cleanTitle = title.trim();
        if (!cleanTitle) return [];
        const cacheKey = cleanTitle.toLowerCase();
        if (this.tagsByTitleCache.has(cacheKey)) {
            return this.tagsByTitleCache.get(cacheKey)!;
        }

        const promise = this.request<Tag[]>(`/videos/tags-by-title?title=${encodeURIComponent(cleanTitle)}`)
            .catch((err) => {
                console.error("fetchTagsByTitle error:", err);
                this.tagsByTitleCache.delete(cacheKey);
                return [];
            });

        this.tagsByTitleCache.set(cacheKey, promise);
        return promise;
    }

    async fetchVideoMetadata(videoId: number): Promise<VideoWithRelations> {
        return this.request<VideoWithRelations>(`/videos/${videoId}`);
    }

    async fetchVideos(search?: string): Promise<Video[]> {
        if (!search) {
            return this.request<Video[]>("/videos");
        }
        if (search.startsWith("?")) {
            return this.request<Video[]>(`/videos${search}`);
        }
        return this.request<Video[]>(`/videos?search=${encodeURIComponent(search)}`);
    }

    async updateVideo(payload: UpdateVideoPayload): Promise<VideoWithRelations> {
        return this.request<VideoWithRelations>("/videos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    async removeTag(videoId: number, tagTitle: string): Promise<void> {
        await this.request("/videos/remove-tag", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tagTitle, videoId }),
        });
    }

    async removeVideo(videoId: number): Promise<void> {
        await this.request(`/video/${videoId}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
        });
    }

    async saveVideo(videoId: number): Promise<void> {
        await this.request(`/video/${videoId}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
    }

    async uploadVideo(formData: FormData): Promise<void> {
        const response = await fetch(`${config.apiUrl}/upload-video`, {
            method: "POST",
            body: formData,
            credentials: "include",
        });
        if (!response.ok) {
            let msg = `Upload failed (${response.status})`;
            try {
                const data = await response.json();
                if (data.error) msg = data.error;
            } catch (_) {}
            throw new Error(msg);
        }
    }

    async react(videoId: number, type: "like") {
        const res = await fetch(`${config.apiUrl}/videos/${videoId}/reaction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ type }),
        });
        if (!res.ok) throw new Error("Reaction failed");
        return res.json();
    }

    async getAdminStats(): Promise<{
        totalUsers: number;
        totalLikes: number;
        totalVideos: number;
        totalUploads: number;
        pendingUploads: number;
        users: Array<{
            id: number;
            email: string;
            name: string | null;
            picture: string | null;
            createdAt: string;
            updatedAt?: string;
            likesCount: number;
            uploadsCount: number;
            approvedUploads?: number;
            pendingUploads?: number;
            isAdmin?: boolean;
        }>;
    }> {
        const res = await fetch(`${config.apiUrl}/admin/stats`, {
            credentials: "include",
        });
        if (!res.ok) {
            throw new Error(`Failed to load admin stats (${res.status})`);
        }
        const data = await res.json();
        return data.stats;
    }
}
