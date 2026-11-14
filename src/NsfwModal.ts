import State from "./State";
import VideoApi from "./VideoApi";
import User from "./User";

export function isNsfwAccepted(): boolean {
    try {
        return localStorage.getItem("clipflip_nsfw_accepted") === "true";
    } catch (_) {
        return false;
    }
}

export function showNsfwModal(
    state: State,
    api: VideoApi,
    user: User,
    onAccepted?: () => void
): void {
    if (document.getElementById("nsfw-modal-overlay")) return;

    let selectedPreference: "straight" | "trans" = "straight";

    const overlay = document.createElement("div");
    overlay.id = "nsfw-modal-overlay";
    overlay.className = "nsfw-modal-overlay";

    overlay.innerHTML = `
        <div class="nsfw-modal-backdrop"></div>
        <div class="nsfw-modal-card">
            <div class="nsfw-modal-badge">
                <span class="nsfw-18-pill">🔞 18+ ADULT CONTENT</span>
            </div>

            <h2 class="nsfw-modal-title">Age Verification & Content Preference</h2>
            
            <p class="nsfw-modal-desc">
                ClipFlip contains sexually explicit material intended strictly for adults aged 18 and older. 
                Please choose your content preference to personalize your experience.
            </p>

            <div class="nsfw-choices-container">
                <div class="nsfw-choice-card active" data-pref="straight" id="nsfw-choice-straight">
                    <div class="nsfw-choice-radio">
                        <div class="nsfw-radio-dot"></div>
                    </div>
                    <div class="nsfw-choice-content">
                        <div class="nsfw-choice-header">
                            <span class="nsfw-choice-icon">👩‍❤️‍👨</span>
                            <span class="nsfw-choice-name">Straight</span>
                            <span class="nsfw-choice-tag">Filters: -shemale</span>
                        </div>
                        <p class="nsfw-choice-desc">
                            Standard content only. Transgender and shemale clips are automatically blacklisted from your feed.
                        </p>
                    </div>
                </div>

                <div class="nsfw-choice-card" data-pref="trans" id="nsfw-choice-trans">
                    <div class="nsfw-choice-radio">
                        <div class="nsfw-radio-dot"></div>
                    </div>
                    <div class="nsfw-choice-content">
                        <div class="nsfw-choice-header">
                            <span class="nsfw-choice-icon">🏳️‍⚧️</span>
                            <span class="nsfw-choice-name">Trans / All</span>
                            <span class="nsfw-choice-tag active">All library</span>
                        </div>
                        <p class="nsfw-choice-desc">
                            Includes all categories, including shemale & transgender clips.
                        </p>
                    </div>
                </div>
            </div>

            <div class="nsfw-modal-footer">
                <button type="button" class="nsfw-confirm-btn" id="nsfw-confirm-btn">
                    <span>I am 18 or older · Enter ClipFlip</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4 ml-1.5 inline">
                        <path d="M5 12h14M12 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <div class="nsfw-exit-wrap">
                    <a href="https://www.google.com" class="nsfw-exit-link">Under 18? Click here to exit</a>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const cardStraight = overlay.querySelector("#nsfw-choice-straight");
    const cardTrans = overlay.querySelector("#nsfw-choice-trans");
    const confirmBtn = overlay.querySelector("#nsfw-confirm-btn");

    cardStraight?.addEventListener("click", () => {
        selectedPreference = "straight";
        cardStraight.classList.add("active");
        cardTrans?.classList.remove("active");
    });

    cardTrans?.addEventListener("click", () => {
        selectedPreference = "trans";
        cardTrans.classList.add("active");
        cardStraight?.classList.remove("active");
    });

    confirmBtn?.addEventListener("click", async () => {
        const isStraight = selectedPreference === "straight";
        const blacklist = isStraight ? ["shemale"] : [];

        // 1. Update State in memory
        state.setBlacklistTags(blacklist);

        // 2. Persist in localStorage
        try {
            localStorage.setItem("clipflip_nsfw_accepted", "true");
            localStorage.setItem("clipflip_preference", selectedPreference);
            localStorage.setItem("clipflip_blacklist_tags", JSON.stringify(blacklist));
        } catch (_) {}

        // 3. Persist to API
        try {
            void api.updateUserPreferences({
                preference: selectedPreference,
                blacklist: blacklist,
                userId: user.currentUser?.id,
            });
        } catch (err) {
            console.warn("Failed to sync preference with server:", err);
        }

        // 4. Update currentUser in memory
        if (user.currentUser) {
            user.currentUser.preference = selectedPreference;
            user.currentUser.blacklist = blacklist;
        }

        // Animate out and remove
        overlay.classList.add("nsfw-fade-out");
        setTimeout(() => {
            overlay.remove();
            onAccepted?.();
        }, 220);
    });
}
