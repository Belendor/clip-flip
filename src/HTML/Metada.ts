import { config } from "../config";
import HTML from "../HTML";
import State, { SectionId } from "../State";
import { VideoWithRelations } from "../types";
import VideoApi from "../VideoApi";

export default class Metadata {
    state: State;
    html: HTML;
    api: VideoApi;
    metaDataEdit: { [key: number]: HTMLDivElement | null } = { 1: null, 2: null, 3: null, 4: null };
    metaData: { [key: number]: HTMLDivElement | null } = { 1: null, 2: null, 3: null, 4: null };
    metaVisible: { [key: number]: boolean | null } = { 1: null, 2: null, 3: null, 4: null };
    metaDataTabs: { [key: number]: HTMLDivElement | null } = { 1: null, 2: null, 3: null, 4: null };
    metaDataInputs: { [key: number]: HTMLDivElement[] | null } = { 1: [], 2: [], 3: [], 4: [] };
    uploadFormWrapper: HTMLDivElement | null = null;
    uploadTagSelect: HTMLSelectElement | null = null;
    private uploadToolbarButton: HTMLButtonElement | null = null;

    private readonly editIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M12 20h9" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>`;
    private readonly doneIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6" />
        </svg>`;
    private readonly addTagIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke-linecap="round"></path>
        </svg>`;

    constructor(html: HTML, state: State, api: VideoApi) {
        this.html = html;
        this.state = state;
        this.api = api;
        this.init();
    }

    async init() {
        this.metaVisible = {
            1: true,
            2: this.state.multiSection,
            3: this.state.multiSection,
            4: this.state.multiSection,
        };
        this.state.sectionIds.forEach((section) => {
            if (!this.state.multiSection && section !== 1) return;
            const sectionElement = document.getElementById(`section-${section}`);
            if (!sectionElement) throw new Error(`Section element for section ${section} not found`);
            this.createMetadataForm(section);
        });
        this.html.updateMetadataButton(true);
    }

    private makeDraggable(element: HTMLElement, handle: HTMLElement) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        const onPointerDown = (e: MouseEvent | TouchEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest("button, input, select, textarea, .metadata-tab, a")) return;

            isDragging = true;
            handle.classList.add("is-dragging");
            const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
            const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

            startX = clientX;
            startY = clientY;

            const rect = element.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            element.style.position = "fixed";
            element.style.left = `${initialLeft}px`;
            element.style.top = `${initialTop}px`;
            element.style.bottom = "auto";
            element.style.right = "auto";
            element.style.margin = "0";

            document.addEventListener("mousemove", onPointerMove);
            document.addEventListener("mouseup", onPointerUp);
            document.addEventListener("touchmove", onPointerMove, { passive: false });
            document.addEventListener("touchend", onPointerUp);
        };

        const onPointerMove = (e: MouseEvent | TouchEvent) => {
            if (!isDragging) return;
            if ("touches" in e) e.preventDefault();

            const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
            const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

            const deltaX = clientX - startX;
            const deltaY = clientY - startY;

            const maxLeft = Math.max(10, window.innerWidth - element.offsetWidth - 10);
            const maxTop = Math.max(10, window.innerHeight - element.offsetHeight - 10);

            const newLeft = Math.min(Math.max(10, initialLeft + deltaX), maxLeft);
            const newTop = Math.min(Math.max(10, initialTop + deltaY), maxTop);

            element.style.left = `${newLeft}px`;
            element.style.top = `${newTop}px`;
        };

        const onPointerUp = () => {
            if (!isDragging) return;
            isDragging = false;
            handle.classList.remove("is-dragging");
            document.removeEventListener("mousemove", onPointerMove);
            document.removeEventListener("mouseup", onPointerUp);
            document.removeEventListener("touchmove", onPointerMove);
            document.removeEventListener("touchend", onPointerUp);
        };

        handle.addEventListener("mousedown", onPointerDown);
        handle.addEventListener("touchstart", onPointerDown, { passive: true });
    }

    private createMetadataForm(section: SectionId): void {
        const form = document.getElementById(`metaForm${section}`) as HTMLDivElement | null;
        this.metaData[section] = form;
        if (!form) throw new Error("Metadata form not found");
        form.replaceChildren();

        if (!this.metaVisible[section] && this.metaVisible[section] == null) {
            throw Error("Visibility not found");
        }
        this.setMetadataVisibility(form, Boolean(this.metaVisible[section]));

        const dragHandle = document.createElement("div");
        dragHandle.className = "metadata-drag-handle";
        dragHandle.title = "Drag window to move";
        dragHandle.innerHTML = `<span class="drag-indicator"></span>`;
        this.makeDraggable(form, dragHandle);

        const topBar = document.createElement("div");
        topBar.className = "metadata-top-bar";

        const metaDataTabs = this.createMetadaTabs(section);

        const closeMetadataBtn = document.createElement("button");
        closeMetadataBtn.type = "button";
        closeMetadataBtn.className = "metadata-close-btn";
        closeMetadataBtn.innerHTML = "&times;";
        closeMetadataBtn.title = "Hide metadata";
        closeMetadataBtn.addEventListener("click", () => {
            this.state.advancedMode = false;
            this.metaVisible[section] = false;
            this.setMetadataVisibility(form, false);
            this.html.updateMetadataButton(false);
        });

        topBar.append(metaDataTabs, closeMetadataBtn);

        const divider1 = document.createElement("div");
        divider1.className = "metadata-divider";

        const metaDataBody = this.createMetadaBody(section, form);
        const metaDataEdit = this.createMetadaEdit(section);
        form.append(dragHandle, topBar, divider1, metaDataBody, metaDataEdit);

        const uploadFormWrapper = document.createElement("div");
        uploadFormWrapper.className = "upload-form hidden";
        uploadFormWrapper.style.minWidth = "16rem";

        const uploadDragHandle = document.createElement("div");
        uploadDragHandle.className = "metadata-drag-handle";
        uploadDragHandle.title = "Drag upload window";
        uploadDragHandle.innerHTML = `<span class="drag-indicator"></span>`;
        this.makeDraggable(uploadFormWrapper, uploadDragHandle);

        const closeUploadBtn = document.createElement("button");
        closeUploadBtn.type = "button";
        closeUploadBtn.className = "upload-close-btn";
        closeUploadBtn.setAttribute("aria-label", "Close upload window");
        closeUploadBtn.innerHTML = "&times;";
        closeUploadBtn.addEventListener("click", () => { this.setUploadFormVisibility(false); });

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.className = "block w-full mb-2";

        const uploadTitleInput = document.createElement("input");
        uploadTitleInput.type = "text";
        uploadTitleInput.placeholder = "Title";
        uploadTitleInput.className = "block w-full mb-2 border border-gray-400 px-2 py-1 rounded";

        const uploadTagSelect = document.createElement("select");
        uploadTagSelect.className = "block w-full mb-2 border border-gray-400 px-2 py-1 rounded";
        if (section === 1) { this.uploadTagSelect = uploadTagSelect; }

        const submitUploadBtn = document.createElement("button");
        submitUploadBtn.type = "button";
        submitUploadBtn.textContent = "Upload";
        submitUploadBtn.className = "upload-submit-btn";
        submitUploadBtn.addEventListener("click", async () => {
            if (!fileInput.files?.length) { alert("Please select a file."); return; }
            const formData = new FormData();
            Array.from(fileInput.files).forEach((file) => formData.append("files", file));
            formData.append("title", uploadTitleInput.value);
            formData.append("tagId", uploadTagSelect.value);
            try {
                await this.api.uploadVideo(formData);
                alert("Upload successful");
                this.setUploadFormVisibility(false);
            } catch (error) {
                console.error("Upload failed", error);
                alert("Upload failed");
            }
        });

        uploadFormWrapper.append(uploadDragHandle, closeUploadBtn, fileInput, uploadTitleInput, uploadTagSelect, submitUploadBtn);
        this.uploadFormWrapper = uploadFormWrapper;
        if (section === 1) { this.html.appRoot.appendChild(this.uploadFormWrapper); }
    }

    setUploadFormVisibility(visible: boolean) {
        if (!this.uploadFormWrapper) return;
        this.uploadFormWrapper.classList.toggle("hidden", !visible);
        this.uploadToolbarButton?.classList.toggle("is-active", visible);
    }

    createMetadaTabs(section: SectionId) {
        const tabsContainer = document.createElement("div");
        tabsContainer.className = "metadata-tabs";

        const createTab = (text: "random" | "new" | "favorite") => {
            const tab = document.createElement("button");
            tab.className = `metadata-tab${this.state.state === text ? " active" : ""}`;
            tab.textContent = text.charAt(0).toUpperCase() + text.slice(1);
            return tab;
        };

        const tabRandom = createTab("random");
        const tabNew = createTab("new");
        const tabFavorite = createTab("favorite");
        tabsContainer.append(tabRandom, tabNew, tabFavorite);
        this.metaDataTabs[section] = tabsContainer;
        return tabsContainer;
    }

    createMetadaInput(section: SectionId) {
        const makeInput = (label: string, placeholder: string, key: keyof VideoWithRelations, readonly = false) => {
            const row = document.createElement("div");
            row.className = "metadata-field-row";

            const labelEl = document.createElement("label");
            labelEl.className = "metadata-field-label";
            labelEl.textContent = label;

            const input = document.createElement("input");
            input.type = "text";
            input.name = key;
            input.dataset.key = key;
            input.placeholder = placeholder;
            input.className = "input-fields metadata-edit-input";
            if (readonly) {
                input.readOnly = true;
                input.classList.add("input-readonly");
            }
            this.metaDataInputs[section]?.push(input);

            row.append(labelEl, input);
            return row;
        };

        const titleRow = makeInput("Title", "Video title", "title");
        const modelRow = makeInput("Models", "Models (comma-separated)", "models");
        const studioRow = makeInput("Studio", "Studio name", "studio");
        const idRow = makeInput("Video ID", "id", "id", true);

        const fieldsWrapper = this.html.createDiv(`metadata-fields-${section}`, "metadata-fields");
        fieldsWrapper.append(titleRow, modelRow, studioRow, idRow);
        return fieldsWrapper;
    }

    async populateUploadTagSelect() {
        if (!this.uploadTagSelect) return;
        await this.state.tagsPromise;
        this.uploadTagSelect.innerHTML = "";
        this.state.allTags.forEach((tag) => {
            if (tag.id == null) return;
            const option = document.createElement("option");
            option.value = String(tag.id);
            option.textContent = tag.title;
            this.uploadTagSelect?.appendChild(option);
        });
    }

    createMetadaEdit(section: SectionId) {
        const editorPanel = this.html.createDiv(`metadata-editor-${section}`, "metadata-editor hidden");
        const editorActions = this.html.createDiv(`metadata-actions-${section}`, "metadata-actions");
        const metaDataInput = this.createMetadaInput(section);
        editorPanel.append(editorActions, metaDataInput);
        this.metaDataEdit[section] = editorPanel;
        return editorPanel;
    }

    createMetadaBody(section: SectionId, form: HTMLElement) {
        const editToggleBtn = document.createElement("button");
        editToggleBtn.type = "button";
        editToggleBtn.className = `edit-toggle metadata-edit-btn ${this.state.multiSection ? "hidden" : ""}`;
        editToggleBtn.innerHTML = `${this.editIcon}<span>Edit</span>`;
        editToggleBtn.title = "Edit metadata";

        const toggleEditMode = () => {
            const nextAdvancedMode = !this.state.advancedMode;
            this.state.advancedMode = nextAdvancedMode;
            this.metaDataEdit[section]?.classList.toggle("hidden", !nextAdvancedMode);
            document.querySelectorAll<HTMLElement>(".tag-delete").forEach((button) => {
                button.classList.toggle("hidden", !nextAdvancedMode);
            });
            document.querySelectorAll<HTMLElement>(".add-tag-pill").forEach((el) => el.classList.toggle("hidden", !nextAdvancedMode));
            editToggleBtn.innerHTML = nextAdvancedMode
                ? `${this.doneIcon}<span>Done</span>`
                : `${this.editIcon}<span>Edit</span>`;
            editToggleBtn.title = nextAdvancedMode ? "Return to view mode" : "Edit metadata";
        };

        editToggleBtn.addEventListener("click", toggleEditMode);

        const videoTagsContainer = this.html.createDiv(`video-tags-${section}`, "metadata-tags-panel");
        const videoTagsWrapper = this.html.createDiv(`video-tags-wrapper-${section}`, "tag-container metadata-tag-list");

        if (this.state.state === "new") {
            const middleRow = document.createElement("div");
            middleRow.className = "metadata-middle-row";

            const clipActions = document.createElement("div");
            clipActions.className = "clip-actions";
            editToggleBtn.classList.add("hidden");

            const addClipBtn = document.createElement("button");
            addClipBtn.type = "button";
            addClipBtn.className = "clip-action-btn add-clip-btn";
            addClipBtn.innerHTML = `<span>Approve</span>`;
            addClipBtn.title = "Approve clip";

            const removeClipBtn = document.createElement("button");
            removeClipBtn.type = "button";
            removeClipBtn.className = "clip-action-btn remove-clip-btn";
            removeClipBtn.innerHTML = `<span>Delete</span>`;
            removeClipBtn.title = "Delete clip";

            clipActions.append(addClipBtn, removeClipBtn);
            middleRow.append(clipActions);

            const divider2 = document.createElement("div");
            divider2.className = "metadata-divider";

            videoTagsContainer.append(middleRow, divider2, videoTagsWrapper);
        } else {
            editToggleBtn.classList.remove("hidden");

            const middleRow = document.createElement("div");
            middleRow.className = "metadata-middle-row";

            const actionGroup = document.createElement("div");
            actionGroup.className = "metadata-action-group";

            const favoriteBtn = document.createElement("button");
            favoriteBtn.type = "button";
            favoriteBtn.className = "reaction-btn favorite-btn";
            favoriteBtn.innerHTML = `<span class="favorite-heart">♡</span><span class="favorite-count">0</span>`;
            favoriteBtn.title = "Favorite";

            // Edit first, then favorite
            actionGroup.append(editToggleBtn, favoriteBtn);
            middleRow.append(actionGroup);

            const divider2 = document.createElement("div");
            divider2.className = "metadata-divider";

            videoTagsContainer.append(middleRow, divider2, videoTagsWrapper);
        }

        this.html.videoTagsContainers[section] = videoTagsWrapper;
        return videoTagsContainer;
    }

    createMetadaEditTags(section: SectionId) {
        const tagButtonWrapper = this.html.createDiv(`tag-button-wrapper-${section}`, "relative inline-block");
        return tagButtonWrapper;
    }

    setMetadataVisibility(form: HTMLElement, visibility: boolean) {
        if (visibility) {
            form.classList.remove("hidden");
        } else {
            form.classList.add("hidden");
        }
    }
}
