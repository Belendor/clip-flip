import State, { type SectionId, PlayerIndex } from "./State";
import HTML from "./HTML";
import { config } from "./config";
import VideoApi from "./VideoApi";
import type { Tag, Video, VideoWithRelations, UpdateVideoPayload, NewVideo } from "./types";
import User from "./User";

type SectionSwapState = Record<SectionId, boolean>;

class Players {
    private readonly metadataCache = new Map<number, Promise<VideoWithRelations | NewVideo | null>>();
    private readonly pendingSwap: SectionSwapState = { 1: false, 2: false, 3: false, 4: false };

    private loadRevision = 0;
    private muted = true;
    private volume = 0.5;
    private searchAbortController: AbortController | null = null;

    constructor(
        private readonly state: State,
        private readonly html: HTML,
        private readonly api: VideoApi,
        private readonly user: User,
    ) {
        try {
            const savedVol = localStorage.getItem("clipflip_volume");
            if (savedVol !== null) this.volume = Math.max(0, Math.min(1, parseFloat(savedVol)));
        } catch (_) {}
        this.muted = true;
        this.state.onEmptyPlays = () => this.showNoVideosBox();
        this.user.init();
    }

    showLoader() {
        document.getElementById("video-loader")?.classList.remove("hidden");
    }

    hideLoader() {
        document.getElementById("video-loader")?.classList.add("hidden");
    }

    async init() {
        this.attachEventListeners();
        this.attachMetadataTabListeners();
        this.user.onAuthChange = async (user) => {
            if (!user && (this.state.state === "new" || this.state.state === "favorite")) {
                await this.switchMode("trending");
                return;
            }
            this.html.metadata.init();
            this.attachMetadataTabListeners();
        };

        const hasCache = await this.state.cacheInitPromise;
        if (hasCache) {
            await this.loadVideos(false);
            void Promise.all([this.state.tagsPromise, this.state.taggedVideosPromise]);
        } else {
            this.showLoader();
            await Promise.all([this.state.tagsPromise, this.state.taggedVideosPromise]);
            await this.loadVideos(true);
        }
    }

    async loadVideos(showSpinner = true): Promise<void> {
        if (showSpinner && !this.state.hasCachedData) {
            this.showLoader();
        }
        const revision = ++this.loadRevision;
        this.state.clearEmptyState();
        this.html.hideNoVideosBox();
        this.resetPlaybackSurface();

        const sections = this.getVisibleSections();
        const results = await Promise.all(sections.map(section => this.loadSection(section, revision)));

        if (revision !== this.loadRevision) return;
        if (results.some(result => !result)) {
            this.hideLoader();
            this.showNoVideosBox();
            return;
        }
        this.hideLoader();
    }

    private getVisibleSections(): SectionId[] {
        return this.state.multiSection ? this.state.sectionIds : [1];
    }

    private getSectionPlayerIndexes(section: SectionId): [PlayerIndex, PlayerIndex] {
        const front = ((section - 1) * 2) as PlayerIndex;
        const back = (front + 1) as PlayerIndex;
        return [front, back];
    }

    private resetPlaybackSurface() {
        for (const section of this.state.sectionIds) {
            const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
            this.state.active[frontIndex] = true;
            this.state.active[backIndex] = false;
            this.state.playing[frontIndex] = false;
            this.state.playing[backIndex] = false;
            this.pendingSwap[section] = false;

            this.resetPlayer(this.html.videoPlayers[frontIndex]);
            this.resetPlayer(this.html.videoPlayers[backIndex]);
            this.setSectionVisualState(section, frontIndex);
        }
        this.updatePlayPauseIcon(false);
    }

    private resetPlayer(player: HTMLVideoElement) {
        player.pause();
        player.removeAttribute("src");
        player.load();
        player.poster = "";
        player.setAttribute("data-video-id", "0");
    }

    private async loadSection(section: SectionId, revision: number): Promise<boolean> {
        const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
        const frontPlayer = this.html.videoPlayers[frontIndex];
        const backPlayer = this.html.videoPlayers[backIndex];

        let currentVideoId = await this.state.takeNextVideoId(section);
        let videoLoaded = false;

        while (currentVideoId !== 0) {
            this.configurePlayer(frontPlayer, currentVideoId, "auto");
            if (revision !== this.loadRevision) return false;

            const ready = await this.waitForVideoReady(frontPlayer);
            if (ready) {
                videoLoaded = true;
                break;
            }

            console.warn(`Video ${currentVideoId} could not be loaded by link (404 or error). Trying next video...`);
            this.state.markVideoAsPlayed(currentVideoId);
            currentVideoId = await this.state.takeNextVideoId(section);
        }

        if (!videoLoaded || currentVideoId === 0) {
            this.state.markEmpty();
            return false;
        }

        await this.playPlayer(frontPlayer, frontIndex);
        if (revision !== this.loadRevision) return false;

        const currentMetadata = await this.getVideoMetadata(currentVideoId, true);
        if (revision !== this.loadRevision) return false;

        if (this.state.adminMode && currentMetadata?.reactions?.length) {
            if (currentMetadata?.reactions?.length > 0) { return this.loadSection(section, revision); }
        }
        this.populateMetadataForm(section, currentMetadata);

        let nextVideoId = await this.state.takeNextVideoId(section);
        while (nextVideoId !== 0) {
            this.queuePlayer(backPlayer, nextVideoId);
            const nextReady = await this.waitForVideoReady(backPlayer);
            if (nextReady) break;
            console.warn(`Queued video ${nextVideoId} could not be loaded by link. Trying next...`);
            this.state.markVideoAsPlayed(nextVideoId);
            nextVideoId = await this.state.takeNextVideoId(section);
        }

        if (nextVideoId === 0) {
            this.resetPlayer(backPlayer);
        }

        this.setSectionActivePlayer(section, frontIndex);
        return true;
    }

    private configurePlayer(player: HTMLVideoElement, videoId: number, preload: "metadata" | "auto") {
        try {
            localStorage.setItem("clipflip_last_video_id", String(videoId));
        } catch (_) {}
        player.poster = this.buildPosterUrl(videoId);
        player.preload = preload;
        player.muted = this.muted;
        player.defaultMuted = true;
        player.volume = this.volume;
        player.playsInline = true;
        player.autoplay = false;
        player.src = this.buildVideoUrl(videoId);
        player.setAttribute("data-video-id", String(videoId));
        player.load();
    }

    private async queuePlayer(player: HTMLVideoElement, videoId: number): Promise<void> {
        this.configurePlayer(player, videoId, "auto");
        player.pause();
    }

    private buildVideoUrl(videoId: number): string {
        const folderMap = [
            { max: 11255, folder: config.videoSourcePath },
            { max: Infinity, folder: config.videoSourcePath2 }
        ];
        const match = folderMap.find(rule => videoId <= rule.max);
        const folder = this.state.state === "new" ? config.videoSourcePathNew : match?.folder;
        if (!match) throw new Error(`No folder mapping found for videoId: ${videoId}`);
        return `${folder}${videoId}.mp4`;
    }

    private buildPosterUrl(videoId: number): string {
        const folder = this.state.state === "new" ? config.videoSourcePathNew : config.videoSourcePath;
        if (this.state.state === "new") return `${folder}thumbnails/${videoId}_first.jpg`;
        return `${folder}thumbnails/${videoId}.jpg`;
    }

    private getPlayerVideoId(player: HTMLVideoElement): number {
        return Number(player.getAttribute("data-video-id") || "0");
    }

    private async playPlayer(player: HTMLVideoElement, index: PlayerIndex) {
        try {
            player.muted = this.muted;
            await player.play();
            this.state.playing[index] = true;
            this.updatePlayPauseIcon(true);
        } catch (error) {
            console.warn("Autoplay was blocked or interrupted, retrying with muted:", error);
            try {
                player.muted = true;
                this.muted = true;
                this.syncAudioState();
                await player.play();
                this.state.playing[index] = true;
                this.updatePlayPauseIcon(true);
            } catch (fallbackError) {
                this.state.playing[index] = false;
                console.error("Autoplay retry also failed:", fallbackError);
            }
        }
    }

    private async waitForPlaybackStart(player: HTMLVideoElement): Promise<boolean> {
        if (!this.getPlayerVideoId(player)) return false;
        if (!player.paused && player.currentTime > 0) return true;

        return new Promise<boolean>((resolve) => {
            const timeout = window.setTimeout(() => cleanup(false), 1500);
            const cleanup = (result: boolean) => {
                window.clearTimeout(timeout);
                player.removeEventListener("playing", handlePlaying);
                player.removeEventListener("timeupdate", handleTimeUpdate);
                player.removeEventListener("error", handleError);
                resolve(result);
            };
            const handlePlaying = () => cleanup(true);
            const handleTimeUpdate = () => { if (!player.paused && player.currentTime > 0) cleanup(true); };
            const handleError = () => cleanup(false);
            player.addEventListener("playing", handlePlaying, { once: true });
            player.addEventListener("timeupdate", handleTimeUpdate);
            player.addEventListener("error", handleError, { once: true });
        });
    }

    private updatePlayPauseIcon(isPlaying: boolean) {
        this.html.iconPlay.classList.toggle("hidden", isPlaying);
        this.html.iconPause.classList.toggle("hidden", !isPlaying);
    }

    private setSectionActivePlayer(section: SectionId, activeIndex: PlayerIndex) {
        const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
        const inactiveIndex = activeIndex === frontIndex ? backIndex : frontIndex;
        this.state.active[activeIndex] = true;
        this.state.active[inactiveIndex] = false;
        this.state.playing[inactiveIndex] = false;
        this.setSectionVisualState(section, activeIndex);
    }

    private setSectionVisualState(section: SectionId, activeIndex: PlayerIndex) {
        const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
        const frontSlot = this.html.videoPlayers[frontIndex].parentElement;
        const backSlot = this.html.videoPlayers[backIndex].parentElement;
        if (!frontSlot || !backSlot) return;

        const frontIsActive = activeIndex === frontIndex;
        frontSlot.classList.toggle("onscreen", frontIsActive);
        frontSlot.classList.toggle("offscreen-right", !frontIsActive);
        backSlot.classList.toggle("onscreen", !frontIsActive);
        backSlot.classList.toggle("offscreen-right", frontIsActive);
    }

    attachMetadataTabListeners() {
        this.html.metadata?.metaDataTabs &&
            Object.values(this.html.metadata.metaDataTabs).forEach((metaTab) => {
                if (!metaTab) return;
                metaTab.onclick = async (e) => {
                    const targetBtn = (e.target as HTMLElement)?.closest<HTMLButtonElement>(".metadata-tab");
                    if (!targetBtn) return;
                    const mode = targetBtn.dataset.mode as "random" | "trending" | "new" | "favorite";
                    if (!mode) return;
                    await this.switchMode(mode);
                };
            });

        this.state.sectionIds.forEach((section) => {
            this.html.metadata.metaDataInputs[section]?.forEach((input) => {
                input.addEventListener("input", async (event) => {
                    event.preventDefault();
                    const target = event.target as HTMLInputElement | HTMLSelectElement;
                    const key = target.name || target.dataset.key || target.id;
                    const value = target.value;
                    if (key && key !== "id") await this.updateMeta(section, key, value);
                });
            });
        });
    }

    private attachEventListeners() {
        const navLeft = document.getElementById('nav-left');
        const navCenter = document.getElementById('nav-center');
        const navRight = document.getElementById('nav-right');
        const videoFront = document.getElementById('v1-front') as HTMLVideoElement | null;
        const videoBack = document.getElementById('v1-back') as HTMLVideoElement | null;

        if (navLeft) {
            navLeft.addEventListener('click', async () => {
                this.state.isGoingBack = true;
                navLeft.style.transition = 'transform 0.1s';
                navLeft.style.transform = 'scale(0.85)';
                setTimeout(() => navLeft.style.transform = 'scale(1)', 150);
                await this.state.modifyPosition(1);
                this.resetPlaybackSurface();
                await this.loadVideos();
            });
        }

        if (navCenter && videoFront && videoBack) {
            navCenter.addEventListener('click', () => {
                navCenter.style.transition = 'transform 0.1s';
                navCenter.style.transform = 'scale(0.85)';
                setTimeout(() => navCenter.style.transform = 'scale(1)', 150);
                this.html.playPauseBtn.click();
            });
        }

        if (navRight) {
            navRight.addEventListener('click', () => {
                navRight.style.transition = 'transform 0.1s';
                navRight.style.transform = 'scale(0.85)';
                setTimeout(() => navRight.style.transform = 'scale(1)', 150);
                if (this.state.active[0]) this.handlePlayerEnded(0 as PlayerIndex);
                else if (this.state.active[1]) this.handlePlayerEnded(1 as PlayerIndex);
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') navLeft?.click();
            else if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); navCenter?.click(); }
            else if (e.key === 'ArrowRight') navRight?.click();
        });

        this.html.playPauseBtn.addEventListener("click", async () => {
            const activeIndexes = Object.keys(this.state.active)
                .map(Number)
                .filter((index) => this.state.active[index as PlayerIndex]) as PlayerIndex[];
            if (activeIndexes.length === 0) return;
            const anyPlaying = activeIndexes.some((index) => this.state.playing[index]);
            this.updatePlayPauseIcon(!anyPlaying);
            await Promise.all(activeIndexes.map((index) => this.togglePlayPause(index, true)));
        });

        this.html.fullscreenButton.addEventListener("click", () => { void this.toggleFullscreen(); });
        document.addEventListener("fullscreenchange", () => {
            this.html.fullscreenButton.classList.toggle("is-fullscreen", !!document.fullscreenElement);
        });

        const volumeTrackBar = document.getElementById("volumeTrackBar");
        const trackContainer = document.getElementById("volumeTrackContainer");
        const volumeWrapper = document.getElementById("volumeSliderWrapper");
        let isDraggingVolume = false;

        const updateVolumeFromPointer = (clientY: number) => {
            const targetEl = volumeTrackBar || trackContainer;
            if (!targetEl) return;
            const rect = targetEl.getBoundingClientRect();
            const rawPercent = ((rect.bottom - clientY) / rect.height) * 100;
            const clamped = Math.max(0, Math.min(100, Math.round(rawPercent)));
            this.volume = clamped / 100;
            this.muted = clamped === 0;
            this.syncAudioState();
        };

        const handlePointerDown = (e: PointerEvent) => {
            e.stopPropagation();
            e.preventDefault();
            isDraggingVolume = true;
            try { (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId); } catch (_) {}
            volumeWrapper?.classList.add("is-active");
            updateVolumeFromPointer(e.clientY);
        };

        const handlePointerMove = (e: PointerEvent) => {
            if (!isDraggingVolume) return;
            e.stopPropagation();
            e.preventDefault();
            updateVolumeFromPointer(e.clientY);
        };

        const handlePointerUp = (e: PointerEvent) => {
            if (isDraggingVolume) {
                isDraggingVolume = false;
                try { (e.currentTarget as HTMLElement)?.releasePointerCapture(e.pointerId); } catch (_) {}
                volumeWrapper?.classList.remove("is-active");
            }
        };

        [trackContainer, volumeTrackBar].forEach((el) => {
            if (!el) return;
            el.addEventListener("pointerdown", handlePointerDown);
            el.addEventListener("pointermove", handlePointerMove);
            el.addEventListener("pointerup", handlePointerUp);
            el.addEventListener("pointercancel", handlePointerUp);
        });

        this.html.muteToggle.addEventListener("click", (e) => {
            e.stopPropagation();
            this.muted = !this.muted;
            if (!this.muted && this.volume === 0) {
                this.volume = 0.5;
            }
            this.syncAudioState();
        });
        this.syncAudioState();

        this.html.reloadToggle.addEventListener("click", () => { window.location.replace("/"); });

        const uploadToolbarButton = document.getElementById("uploadVideoBtn") as HTMLButtonElement | null;
        uploadToolbarButton?.addEventListener("click", async () => {
            const shouldOpen = this.html.metadata.uploadFormWrapper?.classList.contains("hidden") ?? false;
            if (shouldOpen) await this.html.metadata.populateUploadTagSelect();
            this.html.metadata.setUploadFormVisibility(shouldOpen);
        });

        this.html.appRoot.addEventListener("dblclick", (event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("button, input, select, textarea, .tag-card")) return;
            void this.toggleFullscreen();
        });

        this.html.multiscreenButton.addEventListener("click", () => {
            this.state.multiSection = !this.state.multiSection;
            this.html.multiscreenButton.classList.toggle("is-active", this.state.multiSection);
            if (this.state.multiSection) {
                this.state.sectionIds = [1, 2, 3, 4];
                Array.from(document.getElementsByClassName("player")).forEach((player) => {
                    (player as HTMLElement).style.objectFit = "cover";
                });
            } else {
                this.state.sectionIds = [1];
                Array.from(document.getElementsByClassName("player")).forEach((player) => {
                    (player as HTMLElement).style.objectFit = "contain";
                });
            }
            this.html.init();
            this.html.metadata.init();
            this.html.hideForms(true);
            this.loadVideos();
        });

        this.attachSearchListeners();
        this.attachPlayerListeners();
        this.attachMetadataTabListeners();
    }

    private async toggleFullscreen() {
        if (!document.fullscreenElement) {
            try { await document.documentElement.requestFullscreen(); } catch (error) { console.error(`Error: ${(error as Error).message}`); }
            return;
        }
        await document.exitFullscreen();
    }

    private syncAudioState() {
        this.html.muteToggle.classList.toggle("is-muted", this.muted);
        this.html.videoPlayers.forEach((player) => {
            player.muted = this.muted;
            player.volume = this.volume;
        });

        const fillEl = document.getElementById("volumeTrackFill");
        const thumbEl = document.getElementById("volumeTrackThumb");
        const volumeHint = document.getElementById("volumeSliderHint");
        const percent = Math.round(this.volume * 100);

        if (this.muted) {
            if (fillEl) fillEl.style.height = "0%";
            if (thumbEl) thumbEl.style.bottom = "0%";
            if (volumeHint) volumeHint.textContent = "Muted";
        } else {
            if (fillEl) fillEl.style.height = `${percent}%`;
            if (thumbEl) thumbEl.style.bottom = `${percent}%`;
            if (volumeHint) volumeHint.textContent = `${percent}%`;
        }

        try {
            localStorage.setItem("clipflip_volume", String(this.volume));
            localStorage.setItem("clipflip_muted", String(this.muted));
        } catch (_) {}
    }

    private attachSearchListeners() {
        const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
        const advancedPanel = document.getElementById("advancedPanel") as HTMLElement | null;
        if (!searchInput || !advancedPanel) return;

        searchInput.addEventListener("focus", () => {
            advancedPanel.classList.remove("hidden");
            this.renderTagResults(this.state.tags, advancedPanel, searchInput);
        });

        document.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            if (!advancedPanel.contains(target) && target !== searchInput) {
                advancedPanel.classList.add("hidden");
            }
        });

        searchInput.addEventListener("input", async (event) => {
            const value = (event.target as HTMLInputElement).value.trim();
            if (!value) {
                this.renderTagResults(this.state.tags, advancedPanel, searchInput);
                return;
            }
            this.searchAbortController?.abort();
            this.searchAbortController = new AbortController();
            try {
                const tags = await this.api.fetchTags(value);
                this.renderTagResults(tags, advancedPanel, searchInput);
            } catch (error) {
                if ((error as Error).name !== "AbortError") console.error("Failed to search tags", error);
            }
        });
    }

    private attachPlayerListeners() {
        this.html.videoPlayers.forEach((player, index) => {
            player.addEventListener("ended", () => { this.handlePlayerEnded(index as PlayerIndex); });
            player.addEventListener("click", () => { this.togglePlayPause(index as PlayerIndex); });
            player.addEventListener("dblclick", () => { void this.toggleFullscreen(); });
            player.addEventListener("error", () => {
                const videoId = this.getPlayerVideoId(player);
                console.warn(`Player ${index} (videoId ${videoId}) error:`, player.error);
                if (this.state.active[index as PlayerIndex]) {
                    void this.handlePlayerEnded(index as PlayerIndex);
                }
            });
        });
    }

    private renderTagResults(tags: Tag[], advancedPanel: HTMLElement, searchInput: HTMLInputElement) {
        advancedPanel.innerHTML = "";
        if (!tags || tags.length === 0) {
            const emptyNotice = document.createElement("div");
            emptyNotice.className = "col-span-3 text-center py-4 text-sm text-gray-400";
            emptyNotice.textContent = "No matching tags found";
            advancedPanel.appendChild(emptyNotice);
            return;
        }

        tags.forEach((tag) => {
            const card = document.createElement("div");
            card.className = "tag-card";
            card.dataset.tag = tag.title;
            const isActive = this.state.activeTags.get(1)?.includes(tag.title) ?? false;
            if (isActive) card.classList.add("active-tag");

            const defaultImg = `${config.thumbnailSourcePath}thumbnail.jpg`;
            const imgPath = `${config.thumbnailSourcePath}${encodeURIComponent(tag.title)}.jpg`;
            const img = new Image();
            img.onload = () => { card.style.backgroundImage = `url(${imgPath})`; };
            img.onerror = () => { card.style.backgroundImage = `url(${defaultImg})`; };
            img.src = imgPath;

            const title = document.createElement("div");
            title.className = "tag-card-title";
            title.textContent = tag.title + (tag.videoCount ? ` (${tag.videoCount})` : "");
            card.appendChild(title);

            const activeBadge = document.createElement("div");
            activeBadge.className = "tag-card-active-badge";
            activeBadge.textContent = "✓ Active";
            card.appendChild(activeBadge);

            card.addEventListener("click", async (e) => {
                e.stopPropagation();
                await this.toggleTag(tag.title, true);
            });
            advancedPanel.appendChild(card);
        });
    }

    private async getVideoMetadata(videoId: number, refresh: boolean = false): Promise<VideoWithRelations | null> {
        if (!this.metadataCache.has(videoId) || refresh) {
            if (this.state.state == "new") {
                const newVideo = this.state?.newVideos?.find((video) => video.id === videoId) || null;
                if (!newVideo) throw new Error(`New video with ID ${videoId} not found in state`);
                this.metadataCache.set(videoId, Promise.resolve(newVideo));
            } else {
                const fromState = this.state.getVideoById(videoId);
                if (fromState && fromState.tags && fromState.tags.length > 0 && !refresh) {
                    this.metadataCache.set(videoId, Promise.resolve(fromState));
                } else {
                    this.metadataCache.set(
                        videoId,
                        this.api.fetchVideoMetadata(videoId).catch((error) => {
                            console.error(`Error fetching metadata for videoId ${videoId}:`, error);
                            return fromState ?? null;
                        }),
                    );
                }
            }
        }
        return this.metadataCache.get(videoId) ?? null;
    }

    private async waitForVideoReady(video: HTMLVideoElement): Promise<boolean> {
        if (!this.getPlayerVideoId(video)) return false;
        if (video.error) return false;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;

        return new Promise<boolean>((resolve) => {
            const timeout = window.setTimeout(() => { cleanup(false); }, 4000);
            const cleanup = (result: boolean) => {
                window.clearTimeout(timeout);
                video.removeEventListener("canplay", handleReady);
                video.removeEventListener("loadeddata", handleLoadedData);
                video.removeEventListener("error", handleError);
                resolve(result);
            };
            const handleReady = () => cleanup(true);
            const handleLoadedData = async () => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) cleanup(true); };
            const handleError = () => cleanup(false);
            video.addEventListener("canplay", handleReady, { once: true });
            video.addEventListener("loadeddata", handleLoadedData, { once: true });
            video.addEventListener("error", handleError, { once: true });
        });
    }

    private async primePlayer(video: HTMLVideoElement): Promise<void> {
        const ready = await this.waitForVideoReady(video);
        if (!ready) return;
        try { await video.play(); video.pause(); video.currentTime = 0; }
        catch (error) { console.warn("Failed to prime queued video", error); }
    }

    private async handlePlayerEnded(playerIndex: PlayerIndex) {
        const section = (Math.floor(playerIndex / 2) + 1) as SectionId;
        if (this.pendingSwap[section]) return;
        this.pendingSwap[section] = true;

        try {
            const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
            const currentIndex = playerIndex;
            const nextIndex = currentIndex === frontIndex ? backIndex : frontIndex;
            const currentPlayer = this.html.videoPlayers[currentIndex];
            const nextPlayer = this.html.videoPlayers[nextIndex];
            const finishedVideoId = this.getPlayerVideoId(currentPlayer);

            if (finishedVideoId) this.state.markVideoAsPlayed(finishedVideoId);

            let nextVideoId = this.getPlayerVideoId(nextPlayer);
            let ready = false;

            if (nextVideoId) {
                ready = await this.waitForVideoReady(nextPlayer);
            }

            while (!ready) {
                if (nextVideoId) {
                    console.warn(`Video ${nextVideoId} failed to load by link, trying next video...`);
                    this.state.markVideoAsPlayed(nextVideoId);
                }
                nextVideoId = await this.state.takeNextVideoId(section);
                if (nextVideoId === 0) {
                    this.state.markEmpty();
                    this.showNoVideosBox();
                    return;
                }
                this.configurePlayer(nextPlayer, nextVideoId, "auto");
                ready = await this.waitForVideoReady(nextPlayer);
            }

            await this.playPlayer(nextPlayer, nextIndex);
            this.setSectionActivePlayer(section, nextIndex);
            this.state.playing[nextIndex] = true;
            this.updatePlayPauseIcon(true);
            currentPlayer.pause();

            this.getVideoMetadata(nextVideoId)
                .then((nextMetadata) => this.populateMetadataForm(section, nextMetadata))
                .catch((error) => { console.error("Failed to load next metadata:", error); });

            let upcomingVideoId = await this.state.takeNextVideoId(section);
            while (upcomingVideoId !== 0) {
                this.queuePlayer(currentPlayer, upcomingVideoId);
                const upcomingReady = await this.waitForVideoReady(currentPlayer);
                if (upcomingReady) break;
                console.warn(`Upcoming queued video ${upcomingVideoId} failed to load. Trying next...`);
                this.state.markVideoAsPlayed(upcomingVideoId);
                upcomingVideoId = await this.state.takeNextVideoId(section);
            }

            if (upcomingVideoId === 0) {
                this.resetPlayer(currentPlayer);
            }
        } catch (error) {
            console.error("Error during player swap:", error);
            this.showNoVideosBox();
        } finally {
            this.pendingSwap[section] = false;
        }
    }

    private async togglePlayPause(index: PlayerIndex, multi = false): Promise<void> {
        const player = this.html.videoPlayers[index];
        if (this.state.active[index] && this.state.playing[index]) {
            player.pause();
            this.state.playing[index] = false;
            if (!multi) this.updatePlayPauseIcon(false);
            return;
        }
        await this.playPlayer(player, index);
    }

    private async populateMetadataForm(section: SectionId, video: VideoWithRelations | null): Promise<void> {
        if (!video) return;

        const safeTags = Array.isArray(video.tags) ? video.tags : [];
        const safeModels = Array.isArray(video.models) ? video.models : [];

        const form = document.getElementById(`metaForm${section}`) as HTMLDivElement | null;
        if (!form) return;

        const metadataHeader = document.getElementById(`metadata-header-${section}`);

        if (this.state.state !== "new") {
            const oldFavoriteBtn = form.querySelector<HTMLButtonElement>(".favorite-btn");
            if (oldFavoriteBtn) {
                const favoriteBtn = oldFavoriteBtn.cloneNode(true) as HTMLButtonElement;
                oldFavoriteBtn.replaceWith(favoriteBtn);
                const heart = favoriteBtn.querySelector(".favorite-heart") as HTMLSpanElement;
                const count = favoriteBtn.querySelector(".favorite-count") as HTMLSpanElement;
                const currentCount = video.reactions?.length ?? 0;
                const userLiked = video.reactions?.some((r) => r.userId === this.user.currentUser?.id) ?? false;

                if (!userLiked) {
                    heart.textContent = "♡"; count.textContent = String(currentCount); favoriteBtn.classList.remove("active");
                } else {
                    heart.textContent = "♥"; count.textContent = String(currentCount); favoriteBtn.classList.add("active");
                }

                favoriteBtn.addEventListener("click", async () => {
                    if (!this.user.currentUser) {
                        (document.querySelector("#google-login div[role='button']") as HTMLElement)?.click();
                        return;
                    }
                    try {
                        const data = await this.api.react(Number(video.id), "like");
                        const isActive = favoriteBtn.classList.contains("active");
                        if (isActive) { heart.textContent = "♡"; count.textContent = String(data.likes); favoriteBtn.classList.remove("active"); }
                        else { heart.textContent = "♥"; count.textContent = String(data.likes); favoriteBtn.classList.add("active"); }
                    } catch (error) { console.error("Favorite failed", error); }
                });
            }
        }

        form.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
            const key = input.dataset.key || input.name || input.placeholder;
            switch (key) {
                case "id": input.value = String(video.id); break;
                case "Title":
                case "title": input.value = video.title ?? ""; break;
                case "Models":
                case "models": input.value = safeModels.map((model) => model.name ?? "").filter(Boolean).join(", "); break;
                case "Studio":
                case "studio": input.value = video.studio ?? ""; break;
            }
        });

        const handleNextClip = () => {
            if (this.state.active[0]) this.handlePlayerEnded(0 as PlayerIndex);
            else if (this.state.active[1]) this.handlePlayerEnded(1 as PlayerIndex);
        };

        const oldRemoveBtn = form.querySelector(".remove-clip-btn") as HTMLButtonElement | null;
        if (oldRemoveBtn) {
            const removeBtn = oldRemoveBtn.cloneNode(true) as HTMLButtonElement;
            oldRemoveBtn.replaceWith(removeBtn);
            removeBtn.onclick = async () => {
                if (!confirm("Delete this clip?")) return;
                try { await this.api.removeVideo(video.id); this.state.newVideos = this.state.newVideos?.filter((v) => v.id !== video.id) ?? null; handleNextClip(); }
                catch (error) { alert("Failed to delete clip"); console.error("Delete failed", error); }
            };
        }

        const oldSaveBtn = form.querySelector(".add-clip-btn") as HTMLButtonElement | null;
        if (oldSaveBtn) {
            const saveBtn = oldSaveBtn.cloneNode(true) as HTMLButtonElement;
            oldSaveBtn.replaceWith(saveBtn);
            saveBtn.onclick = async () => {
                try { await this.api.saveVideo(video.id); this.state.newVideos = this.state.newVideos?.filter((v) => v.id !== video.id) ?? null; handleNextClip(); }
                catch (error) { alert("Failed to save clip"); console.error("Save failed", error); }
            };
        }

        const tagsWrapper = this.html.videoTagsContainers[section];
        if (!tagsWrapper) return;

        await this.html.renderTags(
            tagsWrapper, safeTags, section, video.id,
            this.toggleTag.bind(this),
            this.removeTag.bind(this),
            async (tagTitle: string, tagId?: number) => {
                const updated = await this.updateMeta(section, "tag", tagTitle, tagId);
                await this.populateMetadataForm(section, updated);
            }
        );
    }

    private async tryPreserveCurrentVideoOnTagChange(section: SectionId): Promise<boolean> {
        if (this.state.taggedVideos == null) return false;
        const activeTags = this.state.activeTags.get(section) ?? [];
        if (activeTags.length === 0) return false;

        const activeIndex = this.getActiveIndexForSection(section);
        const currentPlayer = this.html.videoPlayers[activeIndex];
        const currentVideoId = this.getPlayerVideoId(currentPlayer);
        if (!currentVideoId) return false;

        const currentMetadata = await this.getVideoMetadata(currentVideoId);
        if (!currentMetadata) return false;

        const currentTagTitles = new Set((currentMetadata.tags ?? []).map((tag) => tag.title));
        const matchesAllActiveTags = activeTags.every((tag) => currentTagTitles.has(tag));
        if (!matchesAllActiveTags) return false;

        const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section);
        const inactiveIndex = activeIndex === frontIndex ? backIndex : frontIndex;
        const inactivePlayer = this.html.videoPlayers[inactiveIndex];
        const played = this.state.getPlayedVideos();

        const queuedCandidates = this.state.taggedVideos
            .map((video) => video.id)
            .filter((id) => id !== currentVideoId && !played.has(id));

        if (queuedCandidates.length > 0) await this.queuePlayer(inactivePlayer, queuedCandidates[0]);
        else this.resetPlayer(inactivePlayer);

        this.state.positions[section] = queuedCandidates[1] ?? 0;
        this.setSectionActivePlayer(section, activeIndex);
        await this.populateMetadataForm(section, currentMetadata);
        return true;
    }

    private async removeTag(tag: Tag, videoId?: number) {
        if (!videoId) return;
        try {
            await this.api.removeTag(videoId, tag.title);
            if (this.metadataCache.has(videoId)) this.metadataCache.delete(videoId);
        } catch (error) { console.error("Failed to delete tag", error); }
    }

    showNoVideosBox() {
        this.hideLoader();
        this.state.advancedMode = false;
        this.html.videoPlayers.forEach((player) => { this.resetPlayer(player); });

        const box = document.getElementById("no-videos-box") as HTMLDivElement | null;
        const title = document.getElementById("no-videos-title") as HTMLParagraphElement | null;
        const tagsBox = document.getElementById("active-tags") as HTMLDivElement | null;
        const resetWrapper = document.getElementById("reset-section") as HTMLDivElement | null;
        const resetInfo = resetWrapper?.querySelector(".reset-info") as HTMLParagraphElement | null;
        const resetBtn = resetWrapper?.querySelector("#reset-btn") as HTMLButtonElement | null;

        if (!box || !tagsBox || !resetWrapper || !resetInfo || !resetBtn) return;

        // Ensure primary metadata form remains visible on top so user can switch tabs
        const metaForm1 = document.getElementById("metaForm1");
        if (metaForm1) {
            this.html.metadata.metaVisible[1] = true;
            this.html.metadata.setMetadataVisibility(metaForm1, true);
            this.html.updateMetadataButton(true);
        }

        tagsBox.innerHTML = "";
        const activeTagList = this.state.activeTags.get(1) ?? [];

        if (activeTagList.length > 0) {
            if (title) title.innerHTML = "No more videos found for selected tags.<br>Select a tag below to remove it.";
            const uniqueTags = [...new Set(activeTagList)].map((title) => ({ title }));
            void this.html.renderTags(tagsBox, uniqueTags, 1, undefined, async (tag) => {
                box.setAttribute("hidden", "");
                await this.toggleTag(tag, true);
            });
            resetWrapper.style.display = "block";
        } else {
            if (this.state.getPlayedVideos().size > 0) {
                if (title) title.innerHTML = "You have watched all available videos.<br>Reset your progress to clear cached data and watch everything again.";
                resetWrapper.style.display = "block";
            } else {
                if (title) title.innerHTML = "No videos found.";
                resetWrapper.style.display = "none";
            }
        }

        resetInfo.textContent = "You have watched all available videos. Reset your progress to clear cached data and watch everything again.";
        resetBtn.onclick = async () => {
            resetBtn.disabled = true;
            resetBtn.textContent = "Resetting...";
            box.setAttribute("hidden", "");
            await this.state.resetVideoProgress();
            this.metadataCache.clear();
            void this.loadVideos();
        };

        box.classList.remove("items-center");
        box.classList.add("flex", "flex-col");
        box.removeAttribute("hidden");
    }

    async toggleTag(tag: string, reset = true): Promise<void> {
        this.state.activeTags.forEach((currentTags, sectionId) => {
            const index = currentTags.indexOf(tag);
            if (index >= 0) currentTags.splice(index, 1);
            else currentTags.push(tag);
        });

        document.querySelectorAll<HTMLButtonElement>(".tag-button").forEach((btn) => {
            const btnTag = btn.dataset.tag;
            const btnSection = (Number(btn.dataset.section) || 1) as SectionId;
            const isActive = !!btnTag && (this.state.activeTags.get(btnSection)?.includes(btnTag) ?? false);
            btn.classList.toggle("active-tag", isActive);
            btn.setAttribute("aria-pressed", String(isActive));
        });

        document.querySelectorAll<HTMLElement>(".tag-card").forEach((card) => {
            const cardTag = card.dataset.tag;
            const isActive = !!cardTag && (this.state.activeTags.get(1)?.includes(cardTag) ?? false);
            card.classList.toggle("active-tag", isActive);
        });

        if (!reset) return;

        this.showLoader();
        this.state.clearEmptyState();
        this.html.hideNoVideosBox();
        this.metadataCache.clear();
        await this.state.fetchVideosByTags(1);
        if (await this.tryPreserveCurrentVideoOnTagChange(1)) {
            this.hideLoader();
            return;
        }
        await this.loadVideos();
    }

    async fetchVideos(query?: string): Promise<Video[]> {
        return this.api.fetchVideos(query);
    }

    private getActiveIndexForSection(section: number): PlayerIndex {
        const [frontIndex, backIndex] = this.getSectionPlayerIndexes(section as SectionId);
        return this.state.active[frontIndex] ? frontIndex : backIndex;
    }

    private async updateMeta(section: SectionId, key: string, value: string | string[], tagId?: number): Promise<VideoWithRelations | null> {
        const activeIndex = this.getActiveIndexForSection(section);
        const video = this.html.videoPlayers[activeIndex];
        const videoId = video.getAttribute("data-video-id");
        if (!videoId) { console.error(`Extracted video ID is empty for video at index ${activeIndex}`); return null; }

        const payload: UpdateVideoPayload = { id: videoId };
        if (key === "title") payload.title = value;
        else if (key === "models") payload.models = value;
        else if (key === "studio") payload.studio = value;
        else if (key === "tag") payload.tag = { id: tagId, title: value };

        try {
            await this.api.updateVideo(payload);
            this.metadataCache.delete(Number(videoId));
            return this.getVideoMetadata(Number(videoId));
        } catch (error) {
            console.error(`Failed to update metadata for video ${activeIndex}:`, error);
            return null;
        }
    }

    private async switchMode(mode: "random" | "trending" | "new" | "favorite") {
        if (this.state.state === mode) return;
        this.state.state = mode;
        try {
            localStorage.setItem("clipflip_mode", mode);
        } catch (_) {}
        this.metadataCache.clear();
        this.resetPlaybackSurface();

        switch (mode) {
            case "random":
                this.state.randomized = true;
                this.state.endIndex = config.defaultEndIndex;
                await this.state.modifyPosition(1, true, this.state.randomInRange(1, this.state.endIndex));
                await this.state.modifyPosition(1);
                break;
            case "trending":
                this.state.randomized = false;
                await this.state.fetchTrendingVideos();
                break;
            case "new":
                this.state.randomized = false;
                await this.state.fetchNewVideos();
                break;
            case "favorite":
                const id = this.user?.getId();
                if (!id) {
                    alert("Please sign in to view your favorites.");
                    return;
                }
                await this.state.fetchLikedVideos(id);
                this.state.modifyPosition(1, false, 0);
                break;
        }
        this.html.init();
        this.html.metadata.init();
        this.attachMetadataTabListeners();
        await this.loadVideos();
    }
}

export default Players;
