import VideoApi from "./VideoApi";
import State from "./State";
import { config } from "./config";
import type { VideoWithRelations } from "./types";

export default class TagPage {
    private api: VideoApi;
    private state: State;
    private container: HTMLElement | null = null;
    private isOpen: boolean = false;
    private currentTagName: string | null = null;
    private onPlayVideoCallback?: (tagName: string, videoId: number) => void;
    private onOpenCallback?: () => void;
    private onCloseCallback?: () => void;

    constructor(
        api: VideoApi,
        state: State,
        onPlayVideo?: (tagName: string, videoId: number) => void,
        onOpen?: () => void,
        onClose?: () => void
    ) {
        this.api = api;
        this.state = state;
        this.onPlayVideoCallback = onPlayVideo;
        this.onOpenCallback = onOpen;
        this.onCloseCallback = onClose;

        this.init();
    }

    private init() {
        this.container = document.getElementById("tag-view");
        if (!this.container) {
            this.container = document.createElement("div");
            this.container.id = "tag-view";
            this.container.className = "model-view hidden tag-view";
            document.body.appendChild(this.container);
        }

        // Prevent touch swipe propagation from bubbling to Player swipe handlers
        const stopTouchBubble = (e: TouchEvent) => {
            e.stopPropagation();
        };
        this.container.addEventListener("touchstart", stopTouchBubble, { passive: true });
        this.container.addEventListener("touchmove", stopTouchBubble, { passive: true });
        this.container.addEventListener("touchend", stopTouchBubble, { passive: true });

        // Popstate & hashchange handlers for browser navigation
        window.addEventListener("popstate", () => {
            this.checkRoute();
        });
        window.addEventListener("hashchange", () => {
            this.checkRoute();
        });

        // Check initial route immediately on init
        this.checkRoute();
    }

    public isTagOpen(): boolean {
        return this.isOpen;
    }

    private checkRoute() {
        const path = window.location.pathname;
        const hash = window.location.hash;

        let tagName: string | null = null;
        if (path.startsWith("/tag/")) {
            tagName = decodeURIComponent(path.replace("/tag/", "").replace(/\/$/, ""));
        } else if (hash.startsWith("#tag/") || hash.startsWith("#/tag/")) {
            const cleanHash = hash.replace(/^#\/?tag\//, "");
            tagName = decodeURIComponent(cleanHash);
        }

        if (tagName && tagName.trim().length > 0) {
            if (!this.isOpen || this.currentTagName !== tagName) {
                this.open(tagName, false);
            }
        } else if (this.isOpen) {
            this.close(false);
        }
    }

    public open(tagName: string, pushHistory: boolean = true) {
        this.isOpen = true;
        this.currentTagName = tagName.trim();
        document.body.classList.add("modal-open");
        if (this.container) {
            this.container.classList.remove("hidden");
        }

        if (pushHistory) {
            const targetPath = `/tag/${encodeURIComponent(this.currentTagName)}`;
            if (window.location.pathname !== targetPath) {
                try {
                    window.history.pushState({ page: "tag", tag: this.currentTagName }, "", targetPath);
                } catch (_) {
                    window.location.hash = `#tag/${encodeURIComponent(this.currentTagName)}`;
                }
            }
        }

        this.onOpenCallback?.();
        void this.render(this.currentTagName);
    }

    public close(pushHistory: boolean = true) {
        this.isOpen = false;
        this.currentTagName = null;
        document.body.classList.remove("modal-open");
        if (this.container) {
            this.container.classList.add("hidden");
            this.container.innerHTML = "";
        }

        if (pushHistory) {
            if (window.location.pathname.startsWith("/tag/")) {
                try {
                    window.history.pushState({}, "", "/");
                } catch (_) {
                    window.location.hash = "";
                }
            } else if (window.location.hash.startsWith("#tag/") || window.location.hash.startsWith("#/tag/")) {
                window.location.hash = "";
            }
        }

        this.onCloseCallback?.();
    }

    private async render(tagName: string) {
        if (!this.container) return;

        // Render skeleton / loading state
        this.container.innerHTML = `
            <div class="model-backdrop" id="tag-backdrop"></div>
            <div class="model-modal">
                <div class="model-header-bar">
                    <button type="button" class="model-back-btn" id="tag-back-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4">
                            <path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Back to Videos</span>
                    </button>
                    <span class="model-modal-title">Tag</span>
                    <button type="button" class="model-close-btn" id="tag-close-btn" aria-label="Close">&times;</button>
                </div>
                <div class="model-scroll-body">
                    <div class="model-loading-box">
                        <div class="model-spinner"></div>
                        <p class="text-sm text-gray-400 mt-3">Loading #${this.escapeHtml(tagName)} clips...</p>
                    </div>
                </div>
            </div>
        `;

        const backdrop = this.container.querySelector("#tag-backdrop");
        const backBtn = this.container.querySelector("#tag-back-btn");
        const closeBtn = this.container.querySelector("#tag-close-btn");
        backdrop?.addEventListener("click", () => this.close());
        backBtn?.addEventListener("click", () => this.close());
        closeBtn?.addEventListener("click", () => this.close());

        try {
            // Fetch tag details from API
            let tagData: { id?: number; name?: string; title?: string; videos?: VideoWithRelations[] } | null = null;
            try {
                tagData = await this.api.fetchTagDetails(tagName);
            } catch (err) {
                console.warn("fetchTagDetails failed, falling back to query", err);
            }

            // Exclude clips with no title
            let videos: VideoWithRelations[] = (tagData?.videos || []).filter(
                (v: any) => v.title && String(v.title).trim().length > 0
            );

            // If empty, fallback to searching allVideos or videos endpoint (also filtering for titled clips only)
            if (videos.length === 0 && this.state.allVideos && this.state.allVideos.length > 0) {
                videos = this.state.allVideos.filter((v: any) =>
                    v.title && String(v.title).trim().length > 0 &&
                    Array.isArray(v.tags) && v.tags.some((t: any) =>
                        (t.title || "").trim().toLowerCase() === tagName.trim().toLowerCase()
                    )
                );
            }

            if (videos.length === 0) {
                try {
                    const searched = await this.api.fetchVideos(`?tag=${encodeURIComponent(tagName)}`);
                    videos = (searched || []).filter(
                        (v: any) => v.title && String(v.title).trim().length > 0
                    );
                } catch (_) {}
            }

            const scrollBody = this.container.querySelector(".model-scroll-body");
            if (!scrollBody) return;

            // Sort videos sequentially by seriesNr / id
            videos.sort((a: any, b: any) => {
                if (a.seriesNr != null && b.seriesNr != null && a.seriesNr !== b.seriesNr) {
                    return a.seriesNr - b.seriesNr;
                }
                return a.id - b.id;
            });

            // Group clips by title (excluding any clip without title)
            interface TagVideoGroup {
                key: string;
                title: string;
                videos: VideoWithRelations[];
            }

            const groups: TagVideoGroup[] = [];
            const groupMap = new Map<string, TagVideoGroup>();

            for (const v of videos) {
                const trimmedTitle = (v.title || "").trim();
                if (!trimmedTitle) continue;
                const groupKey = `title:${trimmedTitle.toLowerCase()}`;

                let group = groupMap.get(groupKey);
                if (!group) {
                    group = {
                        key: groupKey,
                        title: trimmedTitle,
                        videos: [],
                    };
                    groupMap.set(groupKey, group);
                    groups.push(group);
                }
                group.videos.push(v);
            }

            // Ensure videos inside each group are in sequential order
            for (const g of groups) {
                g.videos.sort((a: any, b: any) => {
                    const sA = a.seriesNr ?? (a.startTime != null ? a.startTime : 0);
                    const sB = b.seriesNr ?? (b.startTime != null ? b.startTime : 0);
                    if (sA !== sB) return sA - sB;
                    return a.id - b.id;
                });
            }

            const totalTitledVideos = groups.reduce((acc, g) => acc + g.videos.length, 0);
            const badgeCountText = groups.length < totalTitledVideos
                ? `${totalTitledVideos} Clips (${groups.length} Sets)`
                : `${totalTitledVideos} ${totalTitledVideos === 1 ? "Clip" : "Clips"}`;

            const displayName = tagName.charAt(0).toUpperCase() + tagName.slice(1);

            scrollBody.innerHTML = `
                <div class="model-banner-card">
                    <div class="model-avatar-circle" style="background: linear-gradient(135deg, rgba(14, 165, 233, 0.35), rgba(99, 102, 241, 0.45)); border-color: rgba(56, 189, 248, 0.4);">
                        <span class="text-sky-300 font-bold text-2xl font-mono">#</span>
                    </div>
                    <div class="model-banner-info">
                        <div class="model-title-row">
                            <h2 class="model-name-title">#${this.escapeHtml(displayName)}</h2>
                            <span class="model-badge">${badgeCountText}</span>
                        </div>
                        <div class="model-banner-actions">
                            ${totalTitledVideos > 0 ? `
                                <button type="button" class="model-play-all-btn" id="tag-play-all-btn">
                                    <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4">
                                        <polygon points="5 3 19 12 5 21 5 3"/>
                                    </svg>
                                    <span>Play All in Player</span>
                                </button>
                            ` : ""}
                        </div>
                    </div>
                </div>

                <div class="model-grid-section">
                    <div class="model-grid-header">
                        <h3 class="model-grid-title">All Clips</h3>
                        <span class="text-xs text-gray-400">Click any clip to play from that point in sequence</span>
                    </div>
                    ${totalTitledVideos === 0 ? `
                        <div class="model-empty-box">
                            <p class="text-gray-400 text-sm">No titled clips found for tag "#${this.escapeHtml(tagName)}".</p>
                        </div>
                    ` : `
                        <div class="model-clips-grid" id="tag-clips-grid"></div>
                    `}
                </div>
            `;

            const playAllBtn = scrollBody.querySelector("#tag-play-all-btn");
            if (playAllBtn && videos.length > 0) {
                playAllBtn.addEventListener("click", () => {
                    this.close();
                    this.onPlayVideoCallback?.(tagName, videos[0].id);
                });
            }

            const gridContainer = scrollBody.querySelector("#tag-clips-grid");
            if (gridContainer && groups.length > 0) {
                for (let i = 0; i < groups.length; i++) {
                    const group = groups[i];
                    const total = group.videos.length;
                    const v0 = group.videos[0];

                    const card = document.createElement("div");
                    card.className = "model-video-card";
                    card.dataset.videoId = String(v0.id);

                    const initialTag = v0.tags && v0.tags.length > 0 ? v0.tags[0].title : "";
                    const initialLikes = v0.likes ?? 0;

                    const thumbUrl0 = `${config.videoThumbnailPath}${v0.id}.jpg`;

                    const seriesText = total > 1
                        ? `<span class="badge-num">1</span><span class="badge-slash text-white/50">/</span><span class="badge-total">${total}</span>`
                        : (v0.seriesNr != null
                            ? (v0.seriesTotal != null ? `Part ${v0.seriesNr}/${v0.seriesTotal}` : `Part ${v0.seriesNr}`)
                            : `#${v0.id}`);

                    // Segment dots/bars for multi-clip groups
                    const segmentsHtml = total > 1
                        ? `<div class="model-card-segments">
                            ${group.videos.map((_, idx) => `<span class="model-card-segment${idx === 0 ? " active" : ""}"></span>`).join("")}
                           </div>`
                        : "";

                    card.innerHTML = `
                        <div class="model-card-media">
                            <img src="${thumbUrl0}" alt="${this.escapeHtml(group.title)}" class="model-card-img" loading="lazy" />
                            <div class="model-card-overlay">
                                <span class="model-card-play-icon">▶</span>
                            </div>
                            <span class="model-card-series-badge">${seriesText}</span>
                            ${segmentsHtml}
                        </div>
                        <div class="model-card-footer">
                            <div class="model-card-info">
                                <span class="model-card-tag">${initialTag ? `#${this.escapeHtml(initialTag)}` : `#${v0.id}`}</span>
                                <span class="model-card-likes">♥ ${initialLikes}</span>
                            </div>
                            <div class="model-card-title truncate" title="${this.escapeHtml(group.title)}">${this.escapeHtml(group.title)}</div>
                        </div>
                    `;

                    const img = card.querySelector("img") as HTMLImageElement | null;
                    const badgeNumEl = card.querySelector(".model-card-series-badge .badge-num") as HTMLElement | null;
                    const tagEl = card.querySelector(".model-card-tag") as HTMLElement | null;
                    const likesEl = card.querySelector(".model-card-likes") as HTMLElement | null;

                    let currentIndex = 0;
                    let hoverTimer: any = null;
                    let preloaded = false;

                    const preloadImages = () => {
                        if (preloaded || total <= 1) return;
                        preloaded = true;
                        for (let k = 1; k < total; k++) {
                            const pImg = new Image();
                            pImg.src = `${config.videoThumbnailPath}${group.videos[k].id}.jpg`;
                        }
                    };

                    const updateActiveIndex = (nextIndex: number) => {
                        if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= total) return;
                        currentIndex = nextIndex;
                        const activeVideo = group.videos[currentIndex];
                        card.dataset.videoId = String(activeVideo.id);

                        if (img) {
                            img.src = `${config.videoThumbnailPath}${activeVideo.id}.jpg`;
                        }
                        if (badgeNumEl) {
                            badgeNumEl.textContent = String(currentIndex + 1);
                        }
                        if (likesEl) {
                            likesEl.textContent = `♥ ${activeVideo.likes ?? 0}`;
                        }
                        if (tagEl) {
                            const curTag = activeVideo.tags && activeVideo.tags.length > 0 ? activeVideo.tags[0].title : "";
                            tagEl.textContent = curTag ? `#${curTag}` : `#${activeVideo.id}`;
                        }

                        const segments = card.querySelectorAll(".model-card-segment");
                        segments.forEach((seg, sIdx) => {
                            seg.classList.toggle("active", sIdx === currentIndex);
                        });
                    };

                    if (img) {
                        img.addEventListener("error", () => {
                            const curId = card.dataset.videoId || String(v0.id);
                            img.src = `${config.videoSourcePathNew}thumbnails/${curId}_first.jpg`;
                        });
                    }

                    // Hover scrubbing across segments
                    if (total > 1) {
                        const mediaContainer = card.querySelector(".model-card-media") as HTMLElement | null;
                        if (mediaContainer) {
                            mediaContainer.addEventListener("mouseenter", () => {
                                preloadImages();
                            });

                            mediaContainer.addEventListener("mousemove", (e: MouseEvent) => {
                                const rect = mediaContainer.getBoundingClientRect();
                                const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                                const fraction = x / rect.width;
                                const targetIndex = Math.min(Math.floor(fraction * total), total - 1);
                                updateActiveIndex(targetIndex);
                            });

                            mediaContainer.addEventListener("mouseleave", () => {
                                updateActiveIndex(0);
                            });
                        }
                    }

                    // Click card to play selected clip
                    card.addEventListener("click", () => {
                        const activeVideo = group.videos[currentIndex] || v0;
                        this.close();
                        this.onPlayVideoCallback?.(tagName, activeVideo.id);
                    });

                    gridContainer.appendChild(card);
                }
            }
        } catch (error) {
            console.error("Error rendering TagPage:", error);
            const scrollBody = this.container.querySelector(".model-scroll-body");
            if (scrollBody) {
                scrollBody.innerHTML = `
                    <div class="model-empty-box">
                        <p class="text-red-400 text-sm">Failed to load clips for #${this.escapeHtml(tagName)}.</p>
                        <button type="button" class="model-source-btn mt-3" id="tag-retry-btn">Retry</button>
                    </div>
                `;
                scrollBody.querySelector("#tag-retry-btn")?.addEventListener("click", () => {
                    void this.render(tagName);
                });
            }
        }
    }

    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
