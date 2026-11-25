import VideoApi from "./VideoApi";
import State from "./State";
import { config } from "./config";
import type { VideoWithRelations } from "./types";

export default class ModelPage {
    private api: VideoApi;
    private state: State;
    private container: HTMLElement | null = null;
    private isOpen: boolean = false;
    private currentModelName: string | null = null;
    private onPlayVideoCallback?: (modelName: string, videoId: number) => void;
    private onOpenCallback?: () => void;
    private onCloseCallback?: () => void;

    constructor(
        api: VideoApi,
        state: State,
        onPlayVideo?: (modelName: string, videoId: number) => void,
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
        this.container = document.getElementById("model-view");
        if (!this.container) {
            this.container = document.createElement("div");
            this.container.id = "model-view";
            this.container.className = "model-view hidden";
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

    public isModelOpen(): boolean {
        return this.isOpen;
    }

    private checkRoute() {
        const path = window.location.pathname;
        const hash = window.location.hash;

        let modelName: string | null = null;
        if (path.startsWith("/model/")) {
            modelName = decodeURIComponent(path.replace("/model/", "").replace(/\/$/, ""));
        } else if (hash.startsWith("#model/") || hash.startsWith("#/model/")) {
            const cleanHash = hash.replace(/^#\/?model\//, "");
            modelName = decodeURIComponent(cleanHash);
        }

        if (modelName && modelName.trim().length > 0) {
            if (!this.isOpen || this.currentModelName !== modelName) {
                this.open(modelName, false);
            }
        } else if (this.isOpen) {
            this.close(false);
        }
    }

    public open(modelName: string, pushHistory: boolean = true) {
        this.isOpen = true;
        this.currentModelName = modelName.trim();
        document.body.classList.add("modal-open");
        if (this.container) {
            this.container.classList.remove("hidden");
        }

        if (pushHistory) {
            const targetPath = `/model/${encodeURIComponent(this.currentModelName)}`;
            if (window.location.pathname !== targetPath) {
                try {
                    window.history.pushState({ page: "model", model: this.currentModelName }, "", targetPath);
                } catch (_) {
                    window.location.hash = `#model/${encodeURIComponent(this.currentModelName)}`;
                }
            }
        }

        this.onOpenCallback?.();
        void this.render(this.currentModelName);
    }

    public close(pushHistory: boolean = true) {
        this.isOpen = false;
        this.currentModelName = null;
        document.body.classList.remove("modal-open");
        if (this.container) {
            this.container.classList.add("hidden");
            this.container.innerHTML = "";
        }

        if (pushHistory) {
            if (window.location.pathname.startsWith("/model/")) {
                try {
                    window.history.pushState({}, "", "/");
                } catch (_) {
                    window.location.hash = "";
                }
            } else if (window.location.hash.startsWith("#model/") || window.location.hash.startsWith("#/model/")) {
                window.location.hash = "";
            }
        }

        this.onCloseCallback?.();
    }

    private async render(modelName: string) {
        if (!this.container) return;

        // Render skeleton / loading state
        this.container.innerHTML = `
            <div class="model-backdrop" id="model-backdrop"></div>
            <div class="model-modal">
                <div class="model-header-bar">
                    <button type="button" class="model-back-btn" id="model-back-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4">
                            <path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Back to Videos</span>
                    </button>
                    <span class="model-modal-title">Model</span>
                    <button type="button" class="model-close-btn" id="model-close-btn" aria-label="Close">&times;</button>
                </div>
                <div class="model-scroll-body">
                    <div class="model-loading-box">
                        <div class="model-spinner"></div>
                        <p class="text-sm text-gray-400 mt-3">Loading ${this.escapeHtml(modelName)} clips...</p>
                    </div>
                </div>
            </div>
        `;

        const backdrop = this.container.querySelector("#model-backdrop");
        const backBtn = this.container.querySelector("#model-back-btn");
        const closeBtn = this.container.querySelector("#model-close-btn");
        backdrop?.addEventListener("click", () => this.close());
        backBtn?.addEventListener("click", () => this.close());
        closeBtn?.addEventListener("click", () => this.close());

        try {
            // Fetch model details from API
            let modelData: { id?: number; name: string; source?: string | null; videos: VideoWithRelations[] } | null = null;
            try {
                modelData = await this.api.fetchModelDetails(modelName);
            } catch (err) {
                console.warn("fetchModelDetails failed, falling back to local pool / query", err);
            }

            let videos: VideoWithRelations[] = modelData?.videos || [];

            // If empty, fallback to searching allVideos or videos endpoint
            if (videos.length === 0 && this.state.allVideos && this.state.allVideos.length > 0) {
                videos = this.state.allVideos.filter((v: any) =>
                    Array.isArray(v.models) && v.models.some((m: any) =>
                        (m.name || "").trim().toLowerCase() === modelName.trim().toLowerCase()
                    )
                );
            }

            if (videos.length === 0) {
                try {
                    const searched = await this.api.fetchVideos(`?model=${encodeURIComponent(modelName)}`);
                    videos = searched || [];
                } catch (_) {}
            }

            // Determine source URL
            const rawSource = modelData?.source || (videos[0] as any)?.source;
            const fallbackSource = `https://www.redgifs.com/users/${encodeURIComponent(modelName.trim().toLowerCase().replace(/\s+/g, ''))}`;
            const finalSourceUrl = (rawSource && rawSource.trim().length > 0) ? rawSource.trim() : fallbackSource;

            const scrollBody = this.container.querySelector(".model-scroll-body");
            if (!scrollBody) return;

            // Sort videos sequentially by seriesNr / id
            videos.sort((a: any, b: any) => {
                if (a.seriesNr != null && b.seriesNr != null && a.seriesNr !== b.seriesNr) {
                    return a.seriesNr - b.seriesNr;
                }
                return a.id - b.id;
            });

            // Group clips by title
            interface ModelVideoGroup {
                key: string;
                title: string;
                videos: VideoWithRelations[];
            }

            const groups: ModelVideoGroup[] = [];
            const groupMap = new Map<string, ModelVideoGroup>();

            for (const v of videos) {
                const trimmedTitle = (v.title || "").trim();
                const groupKey = trimmedTitle ? `title:${trimmedTitle.toLowerCase()}` : `id:${v.id}`;

                let group = groupMap.get(groupKey);
                if (!group) {
                    group = {
                        key: groupKey,
                        title: trimmedTitle || `Clip #${v.id}`,
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

            const badgeCountText = groups.length < videos.length
                ? `${videos.length} Clips (${groups.length} Sets)`
                : `${videos.length} ${videos.length === 1 ? "Clip" : "Clips"}`;

            // Build Header Card
            const initials = modelName.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

            scrollBody.innerHTML = `
                <div class="model-banner-card">
                    <div class="model-avatar-circle">
                        <span>${this.escapeHtml(initials || "👤")}</span>
                    </div>
                    <div class="model-banner-info">
                        <div class="model-title-row">
                            <h2 class="model-name-title">${this.escapeHtml(modelName)}</h2>
                            <span class="model-badge">${badgeCountText}</span>
                        </div>
                        <div class="model-banner-actions">
                            ${finalSourceUrl ? `
                                <a href="${this.escapeHtml(finalSourceUrl)}" target="_blank" rel="noopener noreferrer" class="model-source-btn" title="Open external website">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4">
                                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                    </svg>
                                    <span>Source ↗</span>
                                </a>
                            ` : ""}
                            ${videos.length > 0 ? `
                                <button type="button" class="model-play-all-btn" id="model-play-all-btn">
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
                    ${videos.length === 0 ? `
                        <div class="model-empty-box">
                            <p class="text-gray-400 text-sm">No clips found for model "${this.escapeHtml(modelName)}".</p>
                        </div>
                    ` : `
                        <div class="model-clips-grid" id="model-clips-grid"></div>
                    `}
                </div>
            `;

            const playAllBtn = scrollBody.querySelector("#model-play-all-btn");
            if (playAllBtn && videos.length > 0) {
                playAllBtn.addEventListener("click", () => {
                    this.close();
                    this.onPlayVideoCallback?.(modelName, videos[0].id);
                });
            }

            const gridContainer = scrollBody.querySelector("#model-clips-grid");
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
                    const fallbackThumb0 = `${config.videoSourcePathNew}thumbnails/${v0.id}_first.jpg`;

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
                        img.onerror = () => {
                            const activeVideo = group.videos[currentIndex] || v0;
                            const fallback = `${config.videoSourcePathNew}thumbnails/${activeVideo.id}_first.jpg`;
                            if (img.src !== fallback) {
                                img.src = fallback;
                            }
                        };
                    }

                    if (total > 1) {
                        const startCycle = () => {
                            preloadImages();
                            clearInterval(hoverTimer);
                            hoverTimer = setInterval(() => {
                                const next = (currentIndex + 1) % total;
                                updateActiveIndex(next);
                            }, 800);
                        };

                        const stopCycle = () => {
                            clearInterval(hoverTimer);
                            hoverTimer = null;
                            updateActiveIndex(0);
                        };

                        card.addEventListener("mouseenter", () => {
                            startCycle();
                        });

                        card.addEventListener("mouseleave", () => {
                            stopCycle();
                        });

                        card.addEventListener("mousemove", (e) => {
                            const rect = card.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            const ratio = Math.max(0, Math.min(0.999, x / rect.width));
                            const targetIdx = Math.floor(ratio * total);
                            if (targetIdx !== currentIndex) {
                                updateActiveIndex(targetIdx);
                                clearInterval(hoverTimer);
                                hoverTimer = setInterval(() => {
                                    const next = (currentIndex + 1) % total;
                                    updateActiveIndex(next);
                                }, 800);
                            }
                        });
                    }

                    // On click: jump to player and play filtered in sequence!
                    card.addEventListener("click", () => {
                        const activeVideo = group.videos[currentIndex] || v0;
                        if (hoverTimer) {
                            clearInterval(hoverTimer);
                            hoverTimer = null;
                        }
                        this.close();
                        this.onPlayVideoCallback?.(modelName, activeVideo.id);
                    });

                    gridContainer.appendChild(card);
                }
            }
        } catch (error) {
            console.error("Failed to render model page:", error);
            const scrollBody = this.container.querySelector(".model-scroll-body");
            if (scrollBody) {
                scrollBody.innerHTML = `
                    <div class="p-8 text-center text-red-400">
                        <p class="font-bold mb-2">Error loading model clips</p>
                        <p class="text-xs text-gray-400">${this.escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p>
                    </div>
                `;
            }
        }
    }

    private escapeHtml(str: string): string {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }
}
