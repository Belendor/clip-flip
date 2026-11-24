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

        // Popstate & hashchange handlers for browser navigation
        window.addEventListener("popstate", () => {
            this.checkRoute();
        });
        window.addEventListener("hashchange", () => {
            this.checkRoute();
        });

        // Check initial route
        setTimeout(() => {
            this.checkRoute();
        }, 200);
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
                            <span class="model-badge">${videos.length} ${videos.length === 1 ? "Clip" : "Clips"}</span>
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
            if (gridContainer && videos.length > 0) {
                for (let i = 0; i < videos.length; i++) {
                    const v = videos[i];
                    const card = document.createElement("div");
                    card.className = "model-video-card";
                    card.dataset.videoId = String(v.id);

                    const seriesText = v.seriesNr != null && v.seriesTotal != null
                        ? `Part ${v.seriesNr}/${v.seriesTotal}`
                        : (v.seriesNr != null ? `Part ${v.seriesNr}` : `#${v.id}`);

                    const tagPill = v.tags && v.tags.length > 0 ? v.tags[0].title : "";
                    const likesCount = v.likes ?? 0;

                    // Thumbnail URL
                    const thumbUrl = `${config.videoThumbnailPath}${v.id}.jpg`;
                    const fallbackThumb = `${config.videoSourcePathNew}thumbnails/${v.id}_first.jpg`;

                    card.innerHTML = `
                        <div class="model-card-media">
                            <img src="${thumbUrl}" alt="Clip ${v.id}" class="model-card-img" loading="lazy" />
                            <div class="model-card-overlay">
                                <span class="model-card-play-icon">▶</span>
                            </div>
                            <span class="model-card-series-badge">${this.escapeHtml(seriesText)}</span>
                        </div>
                        <div class="model-card-footer">
                            <div class="model-card-info">
                                ${tagPill ? `<span class="model-card-tag">#${this.escapeHtml(tagPill)}</span>` : `<span class="model-card-tag">#${v.id}</span>`}
                                <span class="model-card-likes">♥ ${likesCount}</span>
                            </div>
                            ${v.title ? `<div class="model-card-title truncate" title="${this.escapeHtml(v.title)}">${this.escapeHtml(v.title)}</div>` : ""}
                        </div>
                    `;

                    // Handle thumbnail load error
                    const img = card.querySelector("img");
                    if (img) {
                        img.onerror = () => {
                            if (img.src !== fallbackThumb) {
                                img.src = fallbackThumb;
                            }
                        };
                    }

                    // On click: jump to player and play filtered in sequence!
                    card.addEventListener("click", () => {
                        this.close();
                        this.onPlayVideoCallback?.(modelName, v.id);
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
