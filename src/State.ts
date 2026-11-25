import { config } from "./config";
import VideoApi from "./VideoApi";
import type { Model, NewVideo, Tag, Video, VideoWithRelations } from "./types";
import { dbCache } from "./cache";

export type SectionId = 1 | 2 | 3 | 4;
export type PlayerIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type PlayerState = "random" | "trending" | "lowest" | "liked" | "favorite" | "new" | "model";

type PositionsMap = Record<SectionId, number>;

class State {
    readonly PLAYED_KEY = "playedVideoIds";
    readonly MODE_KEY = "clipflip_mode";
    readonly LAST_VIDEO_KEY = "clipflip_last_video_id";
    sectionIds: SectionId[] = [1];

    private history: number[] = [];
    private historyIndex: number = -1;
    private readonly HISTORY_KEY = 'video_play_history';

    isGoingBack: boolean = false;
    state: PlayerState = "random"
    multiSection = false;
    randomized = true;
    percentChance = config.defaultPercentChance;
    endIndex = config.defaultEndIndex;
    positions: PositionsMap = this.createInitialPositions();
    activeTags: Map<SectionId, Tag["title"][]> = new Map();
    playing: Record<PlayerIndex, boolean> = {
        0: false, 1: false, 2: false, 3: false,
        4: false, 5: false, 6: false, 7: false,
    };
    apiUrl = config.apiUrl;
    allVideos: Video[] = [];
    taggedVideos: Video[] | null = null;
    taggedVideosBySection: Map<SectionId, Video[]> = new Map();
    trendingVideos: Video[] | null = null;
    lowestVideos: Video[] | null = null;
    newVideos: NewVideo[] | null = null;
    likedVideos: Video[] | null = null;
    activeModel: string | null = null;
    modelVideos: Video[] | null = null;
    allModels: Model[] = [];
    modelsPromise: Promise<void> | undefined;
    taggedVideosPromise: Promise<void> | undefined;
    advancedMode = false;
    active = {
        0: true, 1: false, 2: true, 3: false,
        4: true, 5: false, 6: true, 7: false,
    } as Record<PlayerIndex, boolean>;
    allTags: Tag[] = [];
    tags: Tag[] = [];
    tagsPromise: Promise<void> | undefined;
    played: Set<number> = new Set();
    onEmptyPlays?: () => void;
    emptyPlays = false;
    adminMode = false;
    hasCachedData = false;
    cacheInitPromise: Promise<boolean>;
    blacklistTags: string[] = [];

    constructor(private readonly api: VideoApi) {
        try {
            const savedMode = localStorage.getItem(this.MODE_KEY) as PlayerState | null;
            if (savedMode) {
                this.state = savedMode === "favorite" ? "liked" : savedMode;
            }
        } catch (_) {}

        try {
            const savedBlacklist = localStorage.getItem("clipflip_blacklist_tags");
            if (savedBlacklist) {
                this.blacklistTags = JSON.parse(savedBlacklist);
            }
        } catch (_) {}

        this.played = this.getPlayedVideos();
        this.cacheInitPromise = this.initCache();

        if (this.state === "new") {
            this.randomized = false;
            this.fetchNewVideos();
        } else if (this.state === "trending") {
            this.randomized = false;
            this.fetchTrendingVideos();
        } else if (this.state === "lowest") {
            this.randomized = false;
            this.fetchLowestVideos();
        } else if (this.state === "liked" || this.state === "favorite") {
            this.randomized = false;
            this.fetchLikedVideos();
        } else {
            this.resetActiveTags();
        }
        this.tagsPromise = this.fetchAllTags();
        this.modelsPromise = this.fetchAllModels();
        this.taggedVideosPromise = this.queryTags();
        this.loadHistory();
    }

    async initCache(): Promise<boolean> {
        try {
            const cachedVideos = await dbCache.get<Video[]>("cached_all_videos");
            const cachedTags = await dbCache.get<Tag[]>("cached_all_tags");
            const cachedModels = await dbCache.get<Model[]>("cached_all_models");
            if (cachedModels && cachedModels.length > 0) {
                this.allModels = cachedModels;
            }
            if (cachedTags && cachedTags.length > 0) {
                this.tags = cachedTags;
                this.allTags = [...cachedTags].sort((a, b) =>
                    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
                );
            }
            if (cachedVideos && cachedVideos.length > 0) {
                this.hasCachedData = true;
                const cleanVideos = cachedVideos.filter(v => !this.isBlacklisted(v));
                const unwatched = cleanVideos.filter(v => !this.played.has(v.id)).sort((a, b) => a.id - b.id);
                this.taggedVideos = unwatched;
                this.allVideos = [...cleanVideos].sort((a, b) => a.id - b.id);

                // Prepare trending videos (highest rated first, natural ascending ID for ties)
                const sorted = [...cleanVideos].sort((a: any, b: any) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesB !== likesA) return likesB - likesA;
                    return a.id - b.id;
                });
                this.trendingVideos = sorted;

                // Prepare lowest liked videos (lowest likes first, natural ascending ID for ties)
                const lowestSorted = [...cleanVideos].sort((a: any, b: any) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesA !== likesB) return likesA - likesB;
                    return a.id - b.id;
                });
                this.lowestVideos = lowestSorted;

                // Prepare liked videos (most liked first, natural ascending ID for ties)
                const likedOnly = cleanVideos.filter(v => (v.likes ?? 0) > 0);
                likedOnly.sort((a: any, b: any) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesB !== likesA) return likesB - likesA;
                    return a.id - b.id;
                });
                this.likedVideos = likedOnly;

                let lastId = 0;
                try {
                    const rawLast = localStorage.getItem(this.LAST_VIDEO_KEY);
                    if (rawLast) lastId = Number(rawLast);
                } catch (_) {}

                const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
                const queryId = urlParams?.get("id");
                let urlVideoId = 0;
                if (queryId) {
                    const parsed = parseInt(queryId, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        urlVideoId = parsed;
                    }
                }

                let chosenId = 0;
                if (urlVideoId > 0) {
                    this.state = "random";
                    this.randomized = false;
                    chosenId = urlVideoId;
                } else if (this.state === "trending" && this.trendingVideos.length > 0) {
                    this.randomized = false;
                    chosenId = this.trendingVideos[0].id;
                } else if (this.state === "lowest" && this.lowestVideos && this.lowestVideos.length > 0) {
                    this.randomized = false;
                    chosenId = this.lowestVideos[0].id;
                } else if ((this.state === "liked" || this.state === "favorite") && this.likedVideos.length > 0) {
                    this.randomized = false;
                    const inLiked = lastId && !this.played.has(lastId) && this.likedVideos.some(v => v.id === lastId);
                    chosenId = inLiked ? lastId : this.likedVideos[0].id;
                } else if (lastId && !this.played.has(lastId)) {
                    const found = cleanVideos.find(v => v.id === lastId);
                    chosenId = found ? lastId : (unwatched[0]?.id ?? 0);
                } else if (unwatched.length > 0) {
                    chosenId = unwatched[Math.floor(Math.random() * unwatched.length)].id;
                } else if (cleanVideos.length > 0) {
                    chosenId = cleanVideos[Math.floor(Math.random() * cleanVideos.length)].id;
                }

                if (chosenId) {
                    this.positions = { 1: chosenId, 2: chosenId, 3: chosenId, 4: chosenId };
                }
                return true;
            }
        } catch (err) {
            console.warn("Failed to load cached videos from IndexedDB:", err);
        }
        return false;
    }

    private createInitialPositions(): PositionsMap {
        return {
            1: 0,
            2: 0,
            3: 0,
            4: 0,
        };
    }

    private loadHistory(): void {
        try {
            const raw = localStorage.getItem(this.HISTORY_KEY);
            this.history = raw ? JSON.parse(raw) : [];
            this.historyIndex = this.history.length > 0 ? this.history.length - 1 : -1;
        } catch (e) {
            console.warn("Failed to load play history", e);
            this.history = [];
            this.historyIndex = -1;
        }
    }

    private saveHistory(): void {
        try {
            if (this.history.length > 200) {
                const drop = this.history.length - 200;
                this.history = this.history.slice(drop);
                this.historyIndex = Math.max(0, this.historyIndex - drop);
            }
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(this.history));
        } catch (e) {
            console.warn("Failed to save play history", e);
        }
    }

    resetHistory(): void {
        this.history = [];
        this.historyIndex = -1;
        localStorage.removeItem(this.HISTORY_KEY);
    }

    resetActiveTags(tags: string[] = []) {
        const uniqueTags = [...new Set(tags)];
        const allSections: SectionId[] = [1, 2, 3, 4];
        allSections.forEach((sectionId) => {
            this.activeTags.set(sectionId, [...uniqueTags]);
        });
    }

    markEmpty() {
        if (this.emptyPlays) return;
        this.emptyPlays = true;
        this.onEmptyPlays?.();
    }

    clearEmptyState() {
        this.emptyPlays = false;
    }

    getPlayedVideos(): Set<number> {
        try {
            const raw = localStorage.getItem(this.PLAYED_KEY);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch (_) {
            return new Set();
        }
    }

    savePlayedVideos(): void {
        try {
            localStorage.setItem(this.PLAYED_KEY, JSON.stringify([...this.played]));
        } catch (_) {}
    }

    markVideoAsPlayed(id: number) {
        if (!id || id <= 0) return;
        this.played.add(id);
        // Keep played set bounded to prevent permanent library exhaustion
        if (this.played.size > 500) {
            const arr = [...this.played];
            this.played = new Set(arr.slice(arr.length - 300));
        }
        this.savePlayedVideos();
    }

    clearPlayedVideos() {
        this.played.clear();
        localStorage.removeItem(this.PLAYED_KEY);
    }

    isBlacklisted(video: any): boolean {
        if (!this.blacklistTags || this.blacklistTags.length === 0 || !video) return false;
        const tags = video.tags;
        if (!Array.isArray(tags)) return false;
        return tags.some((t: any) => {
            const title = (typeof t === "string" ? t : t?.title)?.toLowerCase();
            return title && this.blacklistTags.includes(title);
        });
    }

    setBlacklistTags(tags: string[]) {
        this.blacklistTags = (tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean);
        try {
            localStorage.setItem("clipflip_blacklist_tags", JSON.stringify(this.blacklistTags));
        } catch (_) {}

        // Prune blacklisted videos from existing in-memory pools
        if (this.allVideos && this.allVideos.length > 0) {
            this.allVideos = this.allVideos.filter((v) => !this.isBlacklisted(v));
        }
        if (this.taggedVideos && this.taggedVideos.length > 0) {
            this.taggedVideos = this.taggedVideos.filter((v) => !this.isBlacklisted(v));
        }
        if (this.trendingVideos && this.trendingVideos.length > 0) {
            this.trendingVideos = this.trendingVideos.filter((v) => !this.isBlacklisted(v));
        }
        if (this.likedVideos && this.likedVideos.length > 0) {
            this.likedVideos = this.likedVideos.filter((v) => !this.isBlacklisted(v));
        }
        for (const [sec, pool] of this.taggedVideosBySection.entries()) {
            this.taggedVideosBySection.set(sec, pool.filter((v) => !this.isBlacklisted(v)));
        }
    }

    async resetVideoProgress(): Promise<void> {
        console.log("Resetting video cache & progress");
        this.played.clear();
        this.clearEmptyState();
        localStorage.removeItem(this.PLAYED_KEY);
        localStorage.removeItem(this.HISTORY_KEY);
        const tags = this.activeTags.get(1);
        if (tags && tags.length > 0) {
            await this.fetchVideosByTags(1);
        } else {
            await this.fetchAllVideos();
        }
    }

    async queryTags(): Promise<void> {
        const params = new URLSearchParams(window.location.search);
        const queryTagsRaw = params.get("tags");
        const queryAdmin = params.get("admin");
        const queryId = params.get("id");

        let targetVideoId: number | null = null;
        if (queryId) {
            const videoId = parseInt(queryId, 10);
            if (!isNaN(videoId) && videoId > 0) {
                targetVideoId = videoId;
                this.state = "random";
                this.randomized = false;
                this.positions = { 1: videoId, 2: videoId, 3: videoId, 4: videoId };
                this.played.delete(videoId);
                console.log("Starting with video ID from URL:", videoId);
            }
        }
        if (queryAdmin) {
            this.adminMode = true;
            console.log("Admin mode enabled");
        }
        if (!queryTagsRaw) {
            this.resetActiveTags();
            await this.fetchAllVideos();
            if (targetVideoId) {
                this.state = "random";
                this.randomized = false;
                this.positions = { 1: targetVideoId, 2: targetVideoId, 3: targetVideoId, 4: targetVideoId };
            }
            console.log("No URL tags found, fetched all videos from DB");
            return;
        }

        const tagsArray = queryTagsRaw
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        console.log("URL tags found:", queryTagsRaw);
        this.resetActiveTags(tagsArray);
        await this.fetchVideosByTags(1);
        if (targetVideoId) {
            this.state = "random";
            this.randomized = false;
            this.positions = { 1: targetVideoId, 2: targetVideoId, 3: targetVideoId, 4: targetVideoId };
        }
    }

    recordPlayedVideo(videoId: number, section: SectionId = 1): void {
        if (!videoId || videoId === 0) return;

        this.positions[section] = videoId;

        // In multisection mode, history navigation is scoped to section 1 only
        if (this.multiSection && section !== 1) {
            return;
        }

        // If this video is already the current entry in history, do nothing
        if (this.historyIndex >= 0 && this.history[this.historyIndex] === videoId) {
            return;
        }

        // If we are navigating through existing history and moving forward to the next recorded item:
        if (
            this.historyIndex >= 0 &&
            this.historyIndex < this.history.length - 1 &&
            this.history[this.historyIndex + 1] === videoId
        ) {
            this.historyIndex++;
            this.positions[1] = videoId;
            this.saveHistory();
            return;
        }

        // If we diverged while in past history: truncate future history and append
        if (this.historyIndex >= 0 && this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.history.push(videoId);
        this.historyIndex = this.history.length - 1;
        this.positions[1] = videoId;
        this.saveHistory();
    }

    canGoBack(): boolean {
        return this.historyIndex > 0;
    }

    getPreviousVideoId(): number | null {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            const videoId = this.history[this.historyIndex];
            this.positions[1] = videoId;
            this.saveHistory();
            return videoId;
        }
        return null;
    }

    canGoForwardInHistory(): boolean {
        return this.historyIndex >= 0 && this.historyIndex < this.history.length - 1;
    }

    getNextVideoIdFromHistory(): number | null {
        if (this.canGoForwardInHistory()) {
            this.historyIndex++;
            const videoId = this.history[this.historyIndex];
            this.positions[1] = videoId;
            this.saveHistory();
            return videoId;
        }
        return null;
    }

    peekNextQueuedVideoId(currentId?: number, section: SectionId = 1): number {
        // If we went back in history, the next queued video MUST be the video ahead in history
        if (this.canGoForwardInHistory() && (!this.multiSection || section === 1)) {
            return this.history[this.historyIndex + 1];
        }
        // At the frontier: compute the next video segment or random jump for this section
        return this.computeNextVideoId(currentId ?? this.positions[section], section);
    }

    computeNextVideoId(baseId?: number, section: SectionId = 1): number {
        const currentId = baseId ?? this.positions[section] ?? this.positions[1] ?? 0;

        // New mode (iterate stored newVideos array in sequence)
        if (this.state === "new") {
            if (this.newVideos != null && this.newVideos.length > 0) {
                const videoIds = this.newVideos.map((v) => v.id);
                const currentIndex = videoIds.indexOf(currentId);
                const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoIds.length : 0;
                return videoIds[nextIndex];
            }
            return 0;
        }

        // Liked mode (iterate stored array)
        if (this.state === "liked" || this.state === "favorite") {
            if (this.likedVideos != null && this.likedVideos.length > 0) {
                const videoIds = this.likedVideos.map((v) => v.id);
                const currentIndex = videoIds.indexOf(currentId);
                const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoIds.length : 0;
                return videoIds[nextIndex];
            }
            return 0;
        }

        // Trending mode (iterate stored array)
        if (this.state === "trending") {
            if (this.trendingVideos != null && this.trendingVideos.length > 0) {
                const videoIds = this.trendingVideos.map((v) => v.id);
                const currentIndex = videoIds.indexOf(currentId);
                const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoIds.length : 0;
                return videoIds[nextIndex];
            }
            return 0;
        }

        // Lowest mode (iterate stored array from lowest to highest likes)
        if (this.state === "lowest") {
            if (this.lowestVideos != null && this.lowestVideos.length > 0) {
                const videoIds = this.lowestVideos.map((v) => v.id);
                const currentIndex = videoIds.indexOf(currentId);
                const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoIds.length : 0;
                return videoIds[nextIndex];
            }
            return 0;
        }

        // Model mode (iterate stored modelVideos array in sequence)
        if (this.state === "model") {
            if (this.modelVideos != null && this.modelVideos.length > 0) {
                const videoIds = this.modelVideos.map((v) => v.id);
                const currentIndex = videoIds.indexOf(currentId);
                const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoIds.length : 0;
                return videoIds[nextIndex];
            }
            return 0;
        }

        // Tagged / DB videos for this specific section
        const sectionTags = this.activeTags.get(section);
        const hasSectionTags = !!sectionTags && sectionTags.length > 0;
        const defaultPool = this.multiSection
            ? (this.allVideos && this.allVideos.length > 0 ? this.allVideos : (this.taggedVideos || []))
            : (this.taggedVideos || []);
        const sectionPool = hasSectionTags
            ? (this.taggedVideosBySection.get(section) || [])
            : defaultPool;

        const cleanPool = (sectionPool || []).filter((v) => !this.isBlacklisted(v));

        if (cleanPool.length > 0) {
            // In random mode (when randomized flag is true), pick a true random video with repeat prevention
            if (this.randomized) {
                // Candidates excluding the currently playing video
                let unplayed = cleanPool.filter((v) => !this.played.has(v.id) && v.id !== currentId);

                // In multiSection mode, also avoid clips currently playing on other screens
                if (this.multiSection) {
                    const otherScreens = new Set(
                        ([1, 2, 3, 4] as SectionId[])
                            .filter((s) => s !== section)
                            .map((s) => this.positions[s])
                            .filter((id) => id && id > 0)
                    );
                    const candidatesWithoutOtherScreens = unplayed.filter((v) => !otherScreens.has(v.id));
                    if (candidatesWithoutOtherScreens.length > 0) {
                        unplayed = candidatesWithoutOtherScreens;
                    }
                }

                // If all candidate videos in this pool have been played, recycle the pool!
                if (unplayed.length === 0) {
                    cleanPool.forEach((v) => {
                        if (v.id !== currentId) {
                            this.played.delete(v.id);
                        }
                    });
                    this.savePlayedVideos();
                    unplayed = cleanPool.filter((v) => v.id !== currentId);
                }

                // Select a truly random clip from the unplayed pool
                if (unplayed.length > 0) {
                    const randomIndex = Math.floor(Math.random() * unplayed.length);
                    return unplayed[randomIndex].id;
                }

                // If cleanPool has only 1 video total, return it
                return cleanPool[0]?.id ?? 0;
            }

            // Sequential forward playback when randomized is false (e.g. ?id= URL parameter)
            const poolToUse = (this.allVideos && this.allVideos.length > 0) ? this.allVideos : cleanPool;
            const sortedVideos = [...poolToUse].filter((v) => !this.isBlacklisted(v)).sort((a, b) => a.id - b.id);
            const videoIds = sortedVideos.map((video) => video.id);

            // Find next video with ID strictly greater than currentId
            const nextVideoId = videoIds.find((id) => id > currentId);
            if (nextVideoId != null) {
                return nextVideoId;
            }

            // If reached the end of all videos, wrap around to the first video
            return videoIds[0] ?? (currentId + 1);
        }

        if (!this.randomized && currentId > 0) {
            return currentId + 1;
        }

        return 0;
    }

    async takeNextVideoId(section: SectionId, random: boolean = false, skip: boolean = false): Promise<number> {
        if (this.canGoForwardInHistory() && (!this.multiSection || section === 1)) {
            const historyId = this.getNextVideoIdFromHistory();
            if (historyId != null) return historyId;
        }

        const nextId = this.computeNextVideoId(this.positions[section], section);
        this.positions[section] = nextId;
        return nextId;
    }

    async modifyPosition(section: SectionId, random: boolean = false, id: number = 0): Promise<void> {
        if (!(section in this.positions)) {
            throw new Error(`Invalid section: ${section}`);
        }

        if (id) {
            this.positions[section] = id;
            console.log("Position set to specific ID:", id);
            return;
        }

        const nextId = this.computeNextVideoId(this.positions[section], section);
        this.positions[section] = nextId;
    }

    getVideoById(id: number): VideoWithRelations | null {
        for (const pool of this.taggedVideosBySection.values()) {
            const found = pool.find((v) => v.id === id);
            if (found) return found as VideoWithRelations;
        }
        if (this.allVideos && this.allVideos.length > 0) {
            const found = this.allVideos.find((v) => v.id === id);
            if (found) return found as VideoWithRelations;
        }
        if (this.taggedVideos) {
            const found = this.taggedVideos.find((v) => v.id === id);
            if (found) return found as VideoWithRelations;
        }
        if (this.trendingVideos) {
            const found = this.trendingVideos.find((v) => v.id === id);
            if (found) return found as VideoWithRelations;
        }
        if (this.likedVideos) {
            const found = this.likedVideos.find((v) => v.id === id);
            if (found) return found as VideoWithRelations;
        }
        return null;
    }

    updateVideoInState(video: VideoWithRelations) {
        if (!video || !video.id) return;
        const replaceInList = (list: any[] | null) => {
            if (!list) return;
            const idx = list.findIndex(v => v.id === video.id);
            if (idx >= 0) list[idx] = { ...list[idx], ...video };
        };
        replaceInList(this.taggedVideos);
        replaceInList(this.allVideos);
        replaceInList(this.trendingVideos);
        replaceInList(this.likedVideos);
        for (const pool of this.taggedVideosBySection.values()) {
            replaceInList(pool);
        }
        if (this.newVideos) {
            const idx = this.newVideos.findIndex(v => v.id === video.id);
            if (idx >= 0) this.newVideos[idx] = { ...this.newVideos[idx], ...video };
        }
    }

    batchUpdateVideosInState(predicate: (v: any) => boolean, updates: Partial<VideoWithRelations>) {
        const updateInList = (list: any[] | null) => {
            if (!list) return;
            for (let i = 0; i < list.length; i++) {
                if (predicate(list[i])) {
                    list[i] = { ...list[i], ...updates };
                }
            }
        };
        updateInList(this.taggedVideos);
        updateInList(this.allVideos);
        updateInList(this.trendingVideos);
        updateInList(this.likedVideos);
        for (const pool of this.taggedVideosBySection.values()) {
            updateInList(pool);
        }
        if (this.newVideos) {
            for (let i = 0; i < this.newVideos.length; i++) {
                if (predicate(this.newVideos[i])) {
                    this.newVideos[i] = { ...this.newVideos[i], ...updates };
                }
            }
        }
    }

    async fetchAllVideos(): Promise<void> {
        this.played = this.getPlayedVideos();
        this.clearEmptyState();
        try {
            const videos = await this.api.fetchVideos();
            if (videos && videos.length > 0) {
                void dbCache.set("cached_all_videos", videos);
                const cleanVideos = videos.filter((v) => !this.isBlacklisted(v));
                const unwatchedVideos = cleanVideos.filter((video) => !this.played.has(video.id)).sort((a, b) => a.id - b.id);
                this.taggedVideos = unwatchedVideos;
                this.allVideos = [...cleanVideos].sort((a, b) => a.id - b.id);

                const sorted = [...cleanVideos].sort((a: any, b: any) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesB !== likesA) return likesB - likesA;
                    return a.id - b.id;
                });
                this.trendingVideos = sorted;

                const likedOnly = cleanVideos.filter((v) => (v.likes ?? 0) > 0);
                likedOnly.sort((a, b) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesB !== likesA) return likesB - likesA;
                    return a.id - b.id;
                });
                this.likedVideos = likedOnly;

                if (!this.positions[1] || this.positions[1] === 0) {
                    let candidates = unwatchedVideos;
                    if (candidates.length === 0 && cleanVideos.length > 0) {
                        cleanVideos.forEach((v) => this.played.delete(v.id));
                        this.savePlayedVideos();
                        candidates = cleanVideos;
                    }

                    if (candidates.length === 0) {
                        this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
                        return;
                    }

                    const initialVideo = this.randomized
                        ? candidates[Math.floor(Math.random() * candidates.length)]
                        : candidates[0];

                    this.positions = {
                        1: initialVideo.id,
                        2: initialVideo.id,
                        3: initialVideo.id,
                        4: initialVideo.id,
                    };
                }
            }
        } catch (error) {
            console.error("Failed to fetch all videos from API", error);
            if (!this.taggedVideos) {
                this.taggedVideos = [];
                this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
            }
        }
    }

    async fetchVideosByTags(section: SectionId): Promise<void> {
        const tags = this.activeTags.get(section);
        console.log("Fetching videos for section", section, "with tags:", tags);
        this.played = this.getPlayedVideos();
        this.clearEmptyState();

        if (!tags || tags.length === 0) {
            this.taggedVideosBySection.delete(section);
            if (!this.multiSection) {
                await this.fetchAllVideos();
            } else {
                const defaultPool = this.allVideos && this.allVideos.length > 0 ? this.allVideos : (this.taggedVideos || []);
                if (defaultPool.length > 0) {
                    const randomVideo = defaultPool[Math.floor(Math.random() * defaultPool.length)];
                    this.positions[section] = randomVideo.id;
                }
            }
            return;
        }

        try {
            const videos = await this.api.fetchVideosByTags(tags, this.endIndex);
            const cleanVideos = (videos || []).filter((v) => !this.isBlacklisted(v));
            let unwatchedVideos = cleanVideos.filter((video) => !this.played.has(video.id)).sort((a, b) => a.id - b.id);
            if (unwatchedVideos.length === 0 && cleanVideos.length > 0) {
                // Recycle tag pool if all clips have been watched
                cleanVideos.forEach((v) => this.played.delete(v.id));
                this.savePlayedVideos();
                unwatchedVideos = [...cleanVideos];
            }
            this.taggedVideosBySection.set(section, unwatchedVideos);
            if (!this.multiSection) {
                this.taggedVideos = unwatchedVideos;
            }

            if (unwatchedVideos.length === 0) {
                this.positions[section] = 0;
                return;
            }

            const randomVideo = unwatchedVideos[Math.floor(Math.random() * unwatchedVideos.length)];
            this.positions[section] = randomVideo.id;
        } catch (error) {
            console.error(`Failed to fetch videos for section ${section} with tags`, tags, error);
            this.taggedVideosBySection.set(section, []);
            if (!this.multiSection) {
                this.taggedVideos = [];
            }
            this.positions[section] = 0;
        }
    }

    async fetchTrendingVideos(): Promise<void> {
        console.log("Fetching trending (highest rated) videos");
        this.clearEmptyState();
        try {
            const videos = await this.api.fetchVideos("?sort=trending");
            if (videos && videos.length > 0) {
                void dbCache.set("cached_all_videos", videos);
                const onlyLiked = [...videos]
                    .filter((v: any) => (v.likes ?? 0) > 0)
                    .sort((a: any, b: any) => {
                        const likesA = a.likes ?? 0;
                        const likesB = b.likes ?? 0;
                        if (likesB !== likesA) return likesB - likesA;
                        return a.id - b.id;
                    });
                this.trendingVideos = onlyLiked.length > 0 ? onlyLiked : videos;
                this.randomized = false;
                const topVideo = this.trendingVideos[0];
                const topId = topVideo ? topVideo.id : 0;
                this.positions = {
                    1: topId,
                    2: topId,
                    3: topId,
                    4: topId,
                };
            }
        } catch (error) {
            console.error("Failed to fetch trending videos:", error);
            if (!this.trendingVideos) {
                this.trendingVideos = [];
                this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
            }
        }
    }

    async fetchLowestVideos(): Promise<void> {
        console.log("Fetching oldest (lowest likes) videos");
        this.clearEmptyState();
        try {
            const videos = await this.api.fetchVideos("?sort=lowest");
            if (videos && videos.length > 0) {
                void dbCache.set("cached_all_videos", videos);
                const sorted = [...videos].sort((a: any, b: any) => {
                    const likesA = a.likes ?? 0;
                    const likesB = b.likes ?? 0;
                    if (likesA !== likesB) return likesA - likesB;
                    return a.id - b.id;
                });
                this.lowestVideos = sorted;
                this.randomized = false;
                const topVideo = this.lowestVideos[0];
                const topId = topVideo ? topVideo.id : 0;
                this.positions = {
                    1: topId,
                    2: topId,
                    3: topId,
                    4: topId,
                };
            }
        } catch (error) {
            console.error("Failed to fetch lowest videos:", error);
            if (!this.lowestVideos) {
                this.lowestVideos = [];
                this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
            }
        }
    }

    async fetchNewVideos(): Promise<void> {
        console.log("Fetching new videos");
        this.clearEmptyState();
        try {
            if (!this.newVideos || this.newVideos.length === 0) {
                this.newVideos = await this.api.fetchNewVideos();
            }
            this.randomized = false;
            this.positions = { 1: this.newVideos?.[0]?.id || 0, 2: 0, 3: 0, 4: 0 };
        } catch (error) {
            console.error("Failed to fetch new videos:", error);
            this.newVideos = [];
            this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
        }
    }

    async fetchLikedVideos(userId?: number): Promise<void> {
        console.log("Fetching liked videos for user:", userId);
        this.clearEmptyState();
        try {
            const effectiveUserId = userId || (typeof localStorage !== "undefined" ? Number(localStorage.getItem("clipflip_user_id") || "0") : 0);
            let videos: VideoWithRelations[] = [];
            if (effectiveUserId) {
                videos = await this.api.fetchLikedVideos(effectiveUserId);
            }
            if (!videos || videos.length === 0) {
                videos = await this.api.fetchVideos("?sort=liked" + (effectiveUserId ? `&userId=${effectiveUserId}` : ""));
            }
            const userVideos = (videos || []).sort((a, b) => a.id - b.id);
            this.likedVideos = userVideos;
            this.randomized = false;
            if (userVideos.length === 0) {
                this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
                return;
            }
            const firstId = userVideos[0].id;
            this.positions = {
                1: firstId,
                2: firstId,
                3: firstId,
                4: firstId,
            };
        } catch (error) {
            console.error("Failed to fetch liked videos:", error);
            this.likedVideos = [];
            this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
        }
    }

    async fetchAllTags() {
        try {
            const tags = await this.api.fetchTags();
            if (tags && tags.length > 0) {
                void dbCache.set("cached_all_tags", tags);
                this.tags = tags;
                this.allTags = [...tags].sort((a, b) =>
                    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
                );
                console.log("Fetched all tags:", this.allTags.length);
            }
        } catch (error) {
            console.error("Failed to fetch tags:", error);
            if (!this.tags || this.tags.length === 0) {
                this.tags = [];
                this.allTags = [];
            }
        }
    }

    async fetchAllModels(): Promise<void> {
        try {
            const models = await this.api.fetchModels();
            const list = Array.isArray(models) ? models : [];
            this.allModels = [...list].sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            );
            void dbCache.set("cached_all_models", this.allModels);
            console.log("Fetched all models:", this.allModels.length);
        } catch (error) {
            console.error("Failed to fetch models:", error);
            if (!this.allModels) {
                this.allModels = [];
            }
        }
    }

    async fetchModelVideos(modelName: string): Promise<void> {
        console.log("Fetching videos for model:", modelName);
        this.clearEmptyState();
        this.activeModel = modelName;
        this.state = "model";
        this.randomized = false;
        try {
            let matchingVideos: Video[] = [];
            if (this.allVideos && this.allVideos.length > 0) {
                matchingVideos = this.allVideos.filter((v: any) =>
                    Array.isArray(v.models) && v.models.some((m: any) =>
                        (m.name || "").trim().toLowerCase() === modelName.trim().toLowerCase()
                    )
                );
            }

            if (matchingVideos.length > 0) {
                this.modelVideos = matchingVideos;
            } else {
                const details = await this.api.fetchModelDetails(modelName);
                if (details && Array.isArray(details.videos)) {
                    this.modelVideos = details.videos;
                } else {
                    const fallback = await this.api.fetchVideos(`?model=${encodeURIComponent(modelName)}`);
                    this.modelVideos = fallback || [];
                }
            }

            // Sort sequentially by seriesNr or id so clips play in sequence
            this.modelVideos.sort((a: any, b: any) => {
                if (a.seriesNr != null && b.seriesNr != null && a.seriesNr !== b.seriesNr) {
                    return a.seriesNr - b.seriesNr;
                }
                return a.id - b.id;
            });

            const firstId = this.modelVideos[0]?.id || 0;
            this.positions = {
                1: firstId,
                2: firstId,
                3: firstId,
                4: firstId,
            };
        } catch (error) {
            console.error("Failed to fetch model videos:", error);
            this.modelVideos = [];
            this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
        }
    }

    randomInRange(min: number, max: number) {
        const minInt = Math.floor(min);
        const maxInt = Math.floor(max);
        return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
    }
}

export default State;
