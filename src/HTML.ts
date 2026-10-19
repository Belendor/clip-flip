import State, { SectionId } from "./State";
import Metadata from "./HTML/Metada";
import type { Tag } from "./types";
import VideoApi from "./VideoApi";

type ToggleTagHandler = (tag: string, active: boolean) => void;
type DeleteTagHandler = (tag: Tag, videoId?: number) => Promise<void>;
type AddTagHandler = (tagTitle: string, tagId?: number) => Promise<void>;

export default class HTML {
    state: State;
    api: VideoApi;
    metadata: Metadata;
    appRoot: HTMLElement;
    videoGrid: HTMLElement;

    hideTimeout: number | null = null;
    readonly HIDE_DELAY = 4000;
    private initialized = false;
    toolbar: HTMLDivElement = document.getElementById("toolbar") as HTMLDivElement;
    hideFormsBtn: HTMLButtonElement = document.getElementById("hideForms") as HTMLButtonElement;
    playPauseBtn: HTMLButtonElement = document.getElementById("playPauseBtn") as HTMLButtonElement;
    fullscreenButton: HTMLButtonElement = document.getElementById("fullScreenBtn") as HTMLButtonElement;
    multiscreenButton: HTMLButtonElement = document.getElementById("multiScreenBtn") as HTMLButtonElement;
    muteToggle: HTMLButtonElement = document.getElementById("muteBtn") as HTMLButtonElement;
    reloadToggle: HTMLButtonElement = document.getElementById("reloadBtn") as HTMLButtonElement;
    iconPlay: HTMLSpanElement;
    iconPause: HTMLSpanElement;

    videoPlayers: HTMLVideoElement[] = [];
    videoTagsContainers: { [key: number]: HTMLDivElement | null } = {
        1: null,
        2: null,
        3: null,
        4: null
    }

    constructor(state: State, api: VideoApi) {
        this.state = state;
        this.api = api;
        this.appRoot = document.getElementById("app-root") as HTMLElement;
        this.metadata = new Metadata(this, this.state, this.api);
        this.videoGrid = document.getElementById("video-grid") as HTMLElement;
        this.iconPlay = document.getElementById("icon-play") as HTMLSpanElement;
        this.iconPause = document.getElementById("icon-pause") as HTMLSpanElement;
        this.mapPlayersById();
        this.init();
    }

    init() {
        if (this.state.multiSection) {
            this.videoGrid.classList.remove("single-view");
        } else {
            this.videoGrid.classList.add("single-view");
        }
        if (this.initialized) {
            return
        }
        this.appRoot.addEventListener("mousemove", this.handleInteraction);
        this.appRoot.addEventListener("click", this.handleInteraction);
        this.hideFormsBtn.addEventListener("click", () => this.hideForms());

        window.addEventListener("keydown", this.handleInteraction);
        this.initialized = true
    }

    private handleInteraction = () => {
        this.showToolbar();

        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
        }

        if (this.state.playing[0] || this.state.playing[1]) {
            this.hideTimeout = window.setTimeout(() => {
                this.hideToolbar();
            }, this.HIDE_DELAY);
        }
    };

    private mapPlayersById(): void {
        const idMap = [
            "v1-front", "v1-back",
            "v2-front", "v2-back",
            "v3-front", "v3-back",
            "v4-front", "v4-back",
        ];

        idMap.forEach((id) => {
            const element = document.getElementById(id) as HTMLVideoElement | null;
            if (!element) {
                throw new Error(`Video element with ID ${id} not found.`);
            }

            this.videoPlayers.push(element);
        });
    }

    showToolbar() {
        this.toolbar.style.opacity = "1";
        this.toolbar.style.pointerEvents = "auto";
    }

    hideToolbar() {
        this.toolbar.style.opacity = "0";
        this.toolbar.style.pointerEvents = "none";
    }

    hideForms(forceHide: boolean = false) {
        const firstSectionId = this.state.sectionIds[0];
        const targetState = forceHide ? false : !this.metadata.metaVisible[firstSectionId];

        this.state.sectionIds.forEach((sectionId) => {
            const formElement = this.metadata.metaData[sectionId];

            if (formElement) {
                this.metadata.metaVisible[sectionId] = targetState;
                this.metadata.setMetadataVisibility(formElement, targetState);
            }
        });
    }

    createDiv(id: string, className = ""): HTMLDivElement {
        const div = document.createElement("div");
        div.id = id;
        div.className = className;
        return div;
    }

    hideNoVideosBox() {
        document.getElementById("no-videos-box")?.setAttribute("hidden", "");
    }

    async renderTags(
        container: HTMLElement,
        tags: Tag[],
        section: SectionId,
        videoId?: number,
        onToggleTag?: ToggleTagHandler,
        onDeleteTag?: DeleteTagHandler,
        onAddTag?: AddTagHandler,
    ) {
        container.innerHTML = "";
        const fragment = document.createDocumentFragment();
        const visibleCount = 7;

        tags.forEach((tag, index) => {
            const button = document.createElement("button");
            button.className = `tag-button section-tag-${section}`;
            button.classList.add(
                "px-2", "py-1", "text-base", "font-semibold", "rounded-2xl",
                "bg-black/30", "backdrop-blur-lg", "border", "border-white/40",
                "text-white", "shadow-md", "hover:bg-black/50", "hover:scale-105",
                "transition-all", "duration-200", "ease-out",
            );

            if (index >= visibleCount) {
                button.classList.add("hidden-tag", "hidden");
            }

            if (this.state.activeTags.get(section)?.includes(tag.title)) {
                button.classList.add("active-tag");
            }

            const textSpan = document.createElement("span");
            textSpan.textContent = tag.title;
            button.appendChild(textSpan);

            button.addEventListener("click", (event) => {
                event.stopPropagation();
                onToggleTag?.(tag.title, true);
            });

            const deleteButton = document.createElement("span");
            deleteButton.className = "tag-delete ml-2 px-1 hover:text-red-500 transition-colors cursor-pointer font-bold";
            deleteButton.classList.toggle("hidden", !this.state.advancedMode);
            deleteButton.innerHTML = "&times;";
            deleteButton.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation();

                if (!onDeleteTag || !videoId) return;
                if (!confirm(`Remove tag "${tag.title}" from this video?`)) return;

                await onDeleteTag(tag, videoId);
                button.remove();
            });

            button.appendChild(deleteButton);
            fragment.appendChild(button);
        });

        if (tags.length > visibleCount) {
            const toggleButton = document.createElement("button");
            toggleButton.textContent = "...";
            toggleButton.className = "px-2 py-1 m-1 text-xs rounded-full bg-white/10 text-white hover:bg-white/30";
            toggleButton.onclick = (event) => {
                event.stopPropagation();
                container.querySelectorAll(".hidden-tag").forEach((element) => element.classList.toggle("hidden"));
                toggleButton.textContent = toggleButton.textContent === "..." ? "less" : "...";
            };
            fragment.appendChild(toggleButton);
        }

        if (!onAddTag) return;

        const addPillWrapper = document.createElement("div");
        addPillWrapper.className = "relative block";

        const addPill = document.createElement("button");
        addPill.className = `add-tag-pill ${this.state.advancedMode ? "" : "hidden"}`;
        addPill.type = "button";
        addPill.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>Add tag</span>`;

        const popover = document.createElement("div");
        popover.className = "tag-search-popover hidden";

        const filterInput = document.createElement("input");
        filterInput.type = "text";
        filterInput.className = "tag-search-input";
        filterInput.placeholder = "Filter tags...";

        const resultsDiv = document.createElement("div");
        resultsDiv.className = "tag-search-results";

        const renderFilteredOptions = async (query: string = "") => {
            await this.state.tagsPromise;
            resultsDiv.innerHTML = "";
            const cleanQuery = query.toLowerCase().trim();
            const matches = this.state.allTags.filter((t) =>
                !cleanQuery || t.title.toLowerCase().includes(cleanQuery)
            );

            if (matches.length === 0) {
                const emptyMsg = document.createElement("div");
                emptyMsg.className = "text-xs text-gray-400 p-2 text-center";
                emptyMsg.textContent = "No matching tags";
                resultsDiv.appendChild(emptyMsg);
                return;
            }

            matches.slice(0, 30).forEach((t) => {
                const item = document.createElement("div");
                item.className = "tag-search-item";
                item.textContent = t.title;
                item.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    popover.classList.add("hidden");
                    await onAddTag(t.title, t.id);
                });
                resultsDiv.appendChild(item);
            });
        };

        filterInput.addEventListener("input", () => {
            void renderFilteredOptions(filterInput.value);
        });

        addPill.addEventListener("click", async (e) => {
            e.stopPropagation();
            const isHidden = popover.classList.contains("hidden");
            if (isHidden) {
                filterInput.value = "";
                await renderFilteredOptions();
                popover.classList.remove("hidden");
                setTimeout(() => filterInput.focus(), 50);
            } else {
                popover.classList.add("hidden");
            }
        });

        document.addEventListener("click", (e) => {
            if (!addPillWrapper.contains(e.target as Node)) {
                popover.classList.add("hidden");
            }
        });

        popover.append(filterInput, resultsDiv);
        addPillWrapper.append(addPill, popover);
        fragment.appendChild(document.createElement("br"));
        fragment.appendChild(addPillWrapper);

        container.appendChild(fragment);
    }
}
