import { config } from "./config";
import VideoApi from "./VideoApi";
import type { NewVideo, Tag, Video } from "./types";

export type SectionId = 1 | 2 | 3 | 4;
export type PlayerIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type PlayerState = "random" | "favorite" | "new";

type PositionsMap = Record<SectionId, number>;

class State {
    readonly PLAYED_KEY = "playedVideoIds";
    sectionIds: SectionId[] = [1];

    private history: number[] = [];
    private isInHistoryMode: boolean = false;
    private playHistory: number[] = [];
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
    taggedVideos: Video[] | null = null;
    newVideos: NewVideo[] | null = null;
    likedVideos: Video[] | null = null;
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

    constructor(private readonly api: VideoApi) {
        if (this.state === "new") {
            this.fetchNewVideos();
        } else {
            this.resetActiveTags();
        }
        this.tagsPromise = this.fetchAllTags();
        this.taggedVideosPromise = this.queryTags();
        this.loadHistory();
    }

    private createInitialPositions(): PositionsMap {
        return {
            1: this.randomized ? this.randomInRange(1, this.endIndex) : 1,
            2: this.randomized ? this.randomInRange(this.endIndex * 0.25, this.endIndex * 0.5) : 500,
            3: this.randomized ? this.randomInRange(this.endIndex * 0.5, this.endIndex * 0.75) : 1000,
            4: this.randomized ? this.randomInRange(this.endIndex * 0.75, this.endIndex) : 1500,
        };
    }

    private loadHistory(): void {
        try {
            const raw = localStorage.getItem(this.HISTORY_KEY);
            this.playHistory = raw ? JSON.parse(raw) : [];
        } catch (e) {
            console.warn("Failed to load play history", e);
            this.playHistory = [];
        }
    }

    private saveHistory(): void {
        try {
            if (this.playHistory.length > 100) {
                this.playHistory = this.playHistory.slice(-100);
            }
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(this.playHistory));
        } catch (e) {
            console.warn("Failed to save play history", e);
        }
    }

    resetActiveTags(tags: string[] = []) {
        const uniqueTags = [...new Set(tags)];
        this.sectionIds.forEach((sectionId) => {
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
        const raw = localStorage.getItem(this.PLAYED_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    }

    markVideoAsPlayed(id: number) {
        this.played.add(id);
        localStorage.setItem(this.PLAYED_KEY, JSON.stringify([...this.played]));
    }

    clearPlayedVideos() {
        this.played.clear();
        localStorage.removeItem(this.PLAYED_KEY);
    }

    resetVideoProgress() {
        console.log("Resetting video cache & progress");
        this.played.clear();
        this.clearEmptyState();
        localStorage.clear();
        this.positions = this.createInitialPositions();
    }

    async queryTags(): Promise<void> {
        const params = new URLSearchParams(window.location.search);
        const queryTagsRaw = params.get("tags");
        const queryAdmin = params.get("admin");
        const queryId = params.get("id");

        if (queryId) {
            const videoId = parseInt(queryId, 10);
            if (!isNaN(videoId)) {
                this.modifyPosition(1, false, videoId);
                console.log("Starting with video ID from URL:", videoId);
                this.randomized = false;
                return;
            }
        }
        if (queryAdmin) {
            this.adminMode = true;
            console.log("Admin mode enabled");
            return;
        }
        if (!queryTagsRaw) {
            this.resetActiveTags();
            this.taggedVideos = null;
            console.log("No URL tags found, showing all videos");
            return;
        }

        const tagsArray = queryTagsRaw
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        console.log("URL tags found:", queryTagsRaw);
        this.resetActiveTags(tagsArray);
        await this.fetchVideosByTags(1);
    }

    async takeNextVideoId(section: SectionId, random: boolean = false, skip: boolean = false): Promise<number> {
        const currentVideoId = this.positions[section];
        await this.modifyPosition(section);
        return currentVideoId;
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

        this.played = this.getPlayedVideos();

        // ── BACK LOGIC ────────────────────────────────────────────
        if (this.isGoingBack) {
            if (this.playHistory.length > 1) {
                this.playHistory.pop();
                const previousId = this.playHistory[this.playHistory.length - 1];
                this.positions[section] = previousId;
                console.log(`↩ Back to video: ${previousId}`);
                if (this.playHistory.length <= 1) this.isGoingBack = false;
                this.saveHistory();
                return;
            } else {
                this.isGoingBack = false;
            }
        }

        // ── FORWARD LOGIC ─────────────────────────────────────────
        const currentPos = this.positions[section];
        if (currentPos !== 0) {
            if (this.playHistory.length === 0 || this.playHistory[this.playHistory.length - 1] !== currentPos) {
                this.playHistory.push(currentPos);
            }
            this.saveHistory();
        }

        // Favorites
        if (this.state === "favorite" && this.likedVideos != null) {
            if (this.likedVideos.length === 0) { this.positions[section] = 0; return; }
            const availableVideos = this.likedVideos.filter(video => !this.played.has(video.id));
            if (availableVideos.length === 0) { this.positions[section] = 0; return; }
            if (this.randomized) {
                const roll = Math.random() * 100;
                if (roll < this.percentChance || random) {
                    const randomVideo = availableVideos[Math.floor(Math.random() * availableVideos.length)];
                    this.positions[section] = randomVideo.id;
                    return;
                }
            }
            const videoIds = availableVideos.map(video => video.id);
            const currentIndex = videoIds.indexOf(this.positions[section]);
            this.positions[section] = videoIds[currentIndex + 1] ?? videoIds[0];
            return;
        }

        // Tagged
        if (this.taggedVideos != null) {
            if (this.taggedVideos.length === 0) { this.positions[section] = 0; return; }
            const availableTagged = this.taggedVideos.filter((video) => !this.played.has(video.id));
            if (availableTagged.length === 0) { this.positions[section] = 0; return; }
            if (this.randomized) {
                const roll = Math.random() * 100;
                if (roll < this.percentChance || random) {
                    const randomVideo = availableTagged[Math.floor(Math.random() * availableTagged.length)];
                    this.positions[section] = randomVideo.id;
                    return;
                }
            }
            const videoIds = availableTagged.map((video) => video.id);
            const currentIndex = videoIds.indexOf(this.positions[section]);
            this.positions[section] = videoIds[currentIndex + 1] ?? videoIds[0];
            return;
        }

        // Default untagged
        if (this.randomized) {
            const roll = Math.random() * 100;
            if (roll < this.percentChance) {
                this.positions[section] = Math.floor(Math.random() * this.endIndex) + 1;
                return;
            }
        }
        this.positions[section] = this.positions[section] + 1 > this.endIndex ? 1 : this.positions[section] + 1;
    }

    async fetchVideosByTags(section: SectionId): Promise<void> {
        const tags = this.activeTags.get(section);
        console.log("Fetching videos for section", section, "with tags:", tags);
        this.played = this.getPlayedVideos();
        this.clearEmptyState();

        if (!tags || tags.length === 0) {
            this.taggedVideos = null;
            this.positions = this.createInitialPositions();
            return;
        }

        try {
            const videos = await this.api.fetchVideosByTags(tags, this.endIndex);
            const unwatchedVideos = videos.filter((video) => !this.played.has(video.id));
            this.taggedVideos = unwatchedVideos;
            const randomVideo = videos[Math.floor(Math.random() * videos.length)];
            this.positions = { 1: randomVideo.id, 2: randomVideo.id, 3: randomVideo.id, 4: randomVideo.id };
        } catch (error) {
            console.error(`Failed to fetch videos for section ${section} with tags`, tags, error);
            this.taggedVideos = [];
            this.positions = { 1: 0, 2: 0, 3: 0, 4: 0 };
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
            this.positions = { 1: this.newVideos[0]?.id || 0, 2: 0, 3: 0, 4: 0 };
        } catch (error) {
            console.error("Failed to fetch new videos:", error);
        }
    }

    async fetchLikedVideos(userId: number): Promise<void> {
        console.log("Fetching liked videos");
        this.clearEmptyState();
        try {
            if (!this.likedVideos || this.likedVideos.length === 0) {
                this.likedVideos = await this.api.fetchLikedVideos(userId);
            }
            this.randomized = true;
            this.positions = { 1: this.likedVideos[0]?.id || 0, 2: 0, 3: 0, 4: 0 };
        } catch (error) {
            console.error("Failed to fetch liked videos:", error);
        }
    }

    async fetchAllTags() {
        try {
            const tags = await this.api.fetchTags();
            this.tags = tags;
            this.allTags = [...tags].sort((a, b) =>
                a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
            );
            console.log("Fetched all tags:", this.allTags.length);
        } catch (error) {
            console.error("Failed to fetch tags:", error);
            this.tags = [];
            this.allTags = [];
        }
    }

    randomInRange(min: number, max: number) {
        const minInt = Math.floor(min);
        const maxInt = Math.floor(max);
        return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
    }
}

export default State;
