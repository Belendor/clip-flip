import { config } from "./config";

declare global {
    interface Window {
        google: any;
    }
}

export interface AuthUser {
    id: number;
    email?: string | null;
    name?: string | null;
    username?: string | null;
    picture?: string | null;
    isGuest?: boolean;
    guestNumber?: number | null;
    country?: string | null;
    countryCode?: string | null;
    city?: string | null;
    device?: string | null;
    os?: string | null;
    browser?: string | null;
    preference?: string | null;
    blacklist?: string[];
    isAdmin?: boolean;
    likesCount?: number;
    uploadsCount?: number;
    approvedUploads?: number;
    pendingUploads?: number;
    createdAt?: string;
}

export function getOrCreateBrowserId(): string {
    const key = "clipflip_browser_id";
    let bid = "";
    try {
        bid = localStorage.getItem(key) || "";
    } catch (_) {}

    if (!bid) {
        bid = "cf_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now().toString(36);
        try {
            localStorage.setItem(key, bid);
        } catch (_) {}
    }
    return bid;
}

export default class User {
    currentUser: AuthUser | null = null;
    onAuthChange: ((user: AuthUser | null) => void) | null = null;
    onNavigateProfile: (() => void) | null = null;
    private scriptLoadPromise: Promise<void> | null = null;
    private authModalEl: HTMLElement | null = null;

    constructor() {
        this.loadGoogleSignIn.bind(this);
        try {
            const cached = localStorage.getItem("clipflip_user_cache");
            if (cached) {
                this.currentUser = JSON.parse(cached);
                this.renderUser();
            }
        } catch (_) {}
    }

    async init() {
        await this.checkAuth();
        this.renderUser();
    }

    getId(): number | undefined {
        if (this.currentUser?.id) return this.currentUser.id;
        try {
            const saved = localStorage.getItem("clipflip_user_id");
            if (saved) return Number(saved);
        } catch (_) {}
        return undefined;
    }

    async checkAuth() {
        try {
            const browserId = getOrCreateBrowserId();
            const res = await fetch(`${config.apiUrl}/auth/me`, {
                credentials: "include",
                headers: {
                    "x-browser-id": browserId,
                },
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.loggedIn && data.user) {
                this.currentUser = data.user;
                try {
                    localStorage.setItem("clipflip_user_id", String(data.user.id));
                    localStorage.setItem("clipflip_user_cache", JSON.stringify(data.user));
                } catch (_) {}
                this.renderUser();
                this.onAuthChange?.(this.currentUser);
            } else {
                this.currentUser = null;
                try {
                    localStorage.removeItem("clipflip_user_id");
                    localStorage.removeItem("clipflip_user_cache");
                } catch (_) {}
            }
        } catch (error) {
            console.warn("Failed to check auth status:", error);
        }
    }

    public loadGoogleSignIn(): Promise<void> {
        if (window.google?.accounts?.id) return Promise.resolve();
        if (this.scriptLoadPromise) return this.scriptLoadPromise;

        this.scriptLoadPromise = new Promise((resolve, reject) => {
            const existingScript = document.querySelector(
                'script[src="https://accounts.google.com/gsi/client"]'
            );
            if (existingScript) {
                existingScript.addEventListener("load", () => resolve());
                existingScript.addEventListener("error", () => reject(new Error("Failed to load Google Sign-In")));
                return;
            }

            const script = document.createElement("script");
            script.src = "https://accounts.google.com/gsi/client";
            script.async = true;
            script.defer = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load Google Sign-In"));
            document.head.appendChild(script);
        });

        return this.scriptLoadPromise;
    }

    public async triggerGoogleLogin() {
        await this.loadGoogleSignIn();
        try {
            window.google.accounts.id.initialize({
                client_id: config.googleClientId,
                callback: this.handleGoogleLogin.bind(this),
            });
            window.google.accounts.id.prompt();
        } catch (e) {
            console.warn("Could not prompt Google Sign-In", e);
        }
    }

    promptLogin(message = "Sign in to save your clips permanently") {
        this.openAuthModal("register");
        this.showLoginToast(message);
    }

    showLoginToast(message: string) {
        document.querySelector(".login-prompt-toast")?.remove();

        const toast = document.createElement("div");
        toast.className = "login-prompt-toast";
        toast.innerHTML = `
            <div class="login-toast-icon">♥</div>
            <div class="login-toast-body">
                <span class="login-toast-title">${message}</span>
            </div>
            <button type="button" class="login-toast-cta">Sign In</button>
            <button type="button" class="login-toast-dismiss" aria-label="Close">&times;</button>
        `;

        const cta = toast.querySelector(".login-toast-cta") as HTMLButtonElement | null;
        const dismiss = toast.querySelector(".login-toast-dismiss") as HTMLButtonElement | null;

        cta?.addEventListener("click", () => {
            toast.remove();
            this.openAuthModal("register");
        });

        dismiss?.addEventListener("click", () => toast.remove());

        document.body.appendChild(toast);
        setTimeout(() => {
            if (toast.isConnected) {
                toast.classList.add("toast-fade-out");
                setTimeout(() => toast.remove(), 300);
            }
        }, 4500);
    }

    async handleGoogleLogin(response: { credential: string }) {
        try {
            const browserId = getOrCreateBrowserId();
            const res = await fetch(`${config.apiUrl}/auth/google`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-browser-id": browserId,
                },
                credentials: "include",
                body: JSON.stringify({ credential: response.credential }),
            });

            const data = await res.json();
            if (!data.success) {
                console.error("Login failed", data);
                return;
            }

            this.currentUser = data.user;
            try { localStorage.setItem("clipflip_user_id", String(data.user.id)); } catch (_) {}
            this.closeAuthModal();
            this.renderUser();
            this.onAuthChange?.(this.currentUser);
        } catch (err) {
            console.error("Auth request error:", err);
        }
    }

    renderUser() {
        const div = document.getElementById("google-login");
        if (!div) return;
        div.innerHTML = "";

        if (!this.currentUser) {
            // Fallback button if user couldn't be loaded
            const authPill = document.createElement("button");
            authPill.type = "button";
            authPill.className = "google-auth-pill";
            authPill.innerHTML = `<span>Sign In</span>`;
            authPill.onclick = () => this.openAuthModal("register");
            div.appendChild(authPill);
            return;
        }

        const isGuest = !!this.currentUser.isGuest;
        const container = document.createElement("div");
        container.className = "user-menu-container";

        const userPill = document.createElement("button");
        userPill.type = "button";
        userPill.className = `google-user-pill ${isGuest ? "is-guest-pill" : ""}`;
        userPill.title = isGuest
            ? `Browsing as ${this.currentUser.name} (Guest)`
            : (this.currentUser.email || this.currentUser.username || "Account");

        // Avatar
        if (isGuest) {
            const guestIcon = document.createElement("div");
            guestIcon.className = "user-avatar guest-avatar-icon flex items-center justify-center bg-slate-800 text-slate-300 flex-shrink-0";
            guestIcon.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="12" cy="7" r="4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            `;
            userPill.appendChild(guestIcon);
        } else {
            const avatar = document.createElement("img");
            avatar.src = this.currentUser.picture || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2394a3b8'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";
            avatar.alt = this.currentUser.name || "User";
            avatar.className = "user-avatar";
            avatar.onerror = () => { avatar.onerror = null; };
            userPill.appendChild(avatar);
        }

        const nameLabel = document.createElement("span");
        nameLabel.className = "user-name";
        nameLabel.textContent = this.currentUser.name || (isGuest ? `Guest ${this.currentUser.guestNumber ?? ""}` : "Account");
        userPill.appendChild(nameLabel);

        if (isGuest) {
            const badge = document.createElement("span");
            badge.className = "guest-badge-micro";
            badge.textContent = "GUEST";
            userPill.appendChild(badge);
        }

        const chevron = document.createElement("span");
        chevron.className = "user-menu-chevron";
        chevron.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13">
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        userPill.appendChild(chevron);

        // Dropdown menu
        const dropdown = document.createElement("div");
        dropdown.className = "user-dropdown-menu hidden";

        const header = document.createElement("div");
        header.className = "user-dropdown-header";

        if (isGuest) {
            header.innerHTML = `
                <div class="user-dropdown-email font-bold text-white">${this.currentUser.name || "Guest Account"}</div>
                <div class="text-[11px] text-slate-400 mt-0.5">Saved on this device · Unlinked</div>
            `;
        } else {
            header.innerHTML = `
                <div class="user-dropdown-email font-semibold text-white">${this.currentUser.name || this.currentUser.username || "Account"}</div>
                <div class="text-[11px] text-slate-400 mt-0.5">${this.currentUser.email || ("@" + this.currentUser.username)}</div>
            `;
        }

        const divider = document.createElement("div");
        divider.className = "user-dropdown-divider";

        const linksList = document.createElement("div");
        linksList.className = "user-dropdown-links";

        if (isGuest) {
            // Guest quick-upgrade actions
            const googleLinkBtn = document.createElement("button");
            googleLinkBtn.type = "button";
            googleLinkBtn.className = "user-dropdown-item font-medium text-sky-400 hover:text-sky-300";
            googleLinkBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="15" height="15" class="dropdown-icon" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                </svg>
                <span class="flex-1 text-left">Link Google Account</span>
            `;
            googleLinkBtn.onclick = (e) => {
                e.stopPropagation();
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
                void this.triggerGoogleLogin();
            };

            const setPasswordBtn = document.createElement("button");
            setPasswordBtn.type = "button";
            setPasswordBtn.className = "user-dropdown-item";
            setPasswordBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="dropdown-icon">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="flex-1 text-left">Set Username & Pass</span>
            `;
            setPasswordBtn.onclick = (e) => {
                e.stopPropagation();
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
                this.openAuthModal("register");
            };

            const loginExistingBtn = document.createElement("button");
            loginExistingBtn.type = "button";
            loginExistingBtn.className = "user-dropdown-item";
            loginExistingBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="dropdown-icon">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="10 17 15 12 10 7" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="15" y1="12" x2="3" y2="12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="flex-1 text-left">Log In to Existing</span>
            `;
            loginExistingBtn.onclick = (e) => {
                e.stopPropagation();
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
                this.openAuthModal("login");
            };

            linksList.appendChild(googleLinkBtn);
            linksList.appendChild(setPasswordBtn);
            linksList.appendChild(loginExistingBtn);
            linksList.appendChild(document.createElement("div")).className = "user-dropdown-divider";
        }

        // Profile link
        const profileBtn = document.createElement("button");
        profileBtn.type = "button";
        profileBtn.className = "user-dropdown-item";
        profileBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="dropdown-icon">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="12" cy="7" r="4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="flex-1 text-left">My Profile</span>
            ${this.currentUser.isAdmin ? '<span class="admin-badge-micro">ADMIN</span>' : ''}
        `;
        profileBtn.onclick = (e) => {
            e.stopPropagation();
            dropdown.classList.add("hidden");
            chevron.classList.remove("is-open");
            this.onNavigateProfile?.();
        };
        linksList.appendChild(profileBtn);

        // If registered user, show Log Out button
        if (!isGuest) {
            const logoutBtn = document.createElement("button");
            logoutBtn.type = "button";
            logoutBtn.className = "user-dropdown-item dropdown-item-danger";
            logoutBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="dropdown-icon">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="16 17 21 12 16 7" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="21" y1="12" x2="9" y2="12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span>Log Out</span>
            `;
            logoutBtn.onclick = (e) => {
                e.stopPropagation();
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
                void this.logout();
            };
            linksList.appendChild(logoutBtn);
        }

        dropdown.appendChild(header);
        dropdown.appendChild(divider);
        dropdown.appendChild(linksList);

        // Toggle dropdown on pill click
        userPill.onclick = (e) => {
            e.stopPropagation();
            const isOpen = !dropdown.classList.contains("hidden");
            if (isOpen) {
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
            } else {
                dropdown.classList.remove("hidden");
                chevron.classList.add("is-open");
            }
        };

        // Close when clicking outside
        const closeDropdown = (e: MouseEvent) => {
            if (!container.contains(e.target as Node)) {
                dropdown.classList.add("hidden");
                chevron.classList.remove("is-open");
            }
        };
        document.addEventListener("click", closeDropdown);

        container.appendChild(userPill);
        container.appendChild(dropdown);
        div.appendChild(container);
    }

    public openAuthModal(initialTab: "register" | "login" = "register") {
        this.closeAuthModal();

        const isGuest = !!this.currentUser?.isGuest;
        const currentGuestName = this.currentUser?.name || "Guest";

        const modalOverlay = document.createElement("div");
        modalOverlay.id = "auth-modal-overlay";
        modalOverlay.className = "auth-modal-overlay";

        modalOverlay.innerHTML = `
            <div class="auth-modal-backdrop"></div>
            <div class="auth-modal-card">
                <button type="button" class="auth-modal-close" aria-label="Close">&times;</button>
                
                <!-- Tabs -->
                <div class="auth-modal-tabs">
                    <button type="button" class="auth-modal-tab ${initialTab === "register" ? "active" : ""}" data-tab="register">
                        ${isGuest ? "Keep Account" : "Create Account"}
                    </button>
                    <button type="button" class="auth-modal-tab ${initialTab === "login" ? "active" : ""}" data-tab="login">
                        Log In
                    </button>
                </div>

                <!-- Tab Body: Register / Upgrade -->
                <div class="auth-tab-content ${initialTab === "register" ? "" : "hidden"}" id="tab-register">
                    <div class="auth-modal-header">
                        <h2 class="auth-modal-title">${isGuest ? `Save ${currentGuestName}` : "Create an Account"}</h2>
                        <p class="auth-modal-desc">
                            ${isGuest 
                                ? "Set a username and password to secure your guest account and keep your likes forever."
                                : "Join ClipFlip to save likes and sync across devices."
                            }
                        </p>
                    </div>

                    <form class="auth-form" id="register-form">
                        <div class="auth-input-group">
                            <label for="reg-username">Username</label>
                            <input type="text" id="reg-username" name="username" placeholder="Choose a username" required minlength="3" autocomplete="username" />
                        </div>
                        <div class="auth-input-group">
                            <label for="reg-password">Password</label>
                            <input type="password" id="reg-password" name="password" placeholder="At least 6 characters" required minlength="6" autocomplete="new-password" />
                        </div>
                        <div class="auth-error-msg hidden" id="register-error"></div>
                        <button type="submit" class="auth-submit-btn">
                            ${isGuest ? "Save Account" : "Sign Up"}
                        </button>
                    </form>

                    <div class="auth-divider"><span>OR</span></div>

                    <button type="button" class="auth-google-btn" id="modal-google-btn-reg">
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                        </svg>
                        <span>${isGuest ? "Link Google Account" : "Continue with Google"}</span>
                    </button>
                </div>

                <!-- Tab Body: Login -->
                <div class="auth-tab-content ${initialTab === "login" ? "" : "hidden"}" id="tab-login">
                    <div class="auth-modal-header">
                        <h2 class="auth-modal-title">Welcome Back</h2>
                        <p class="auth-modal-desc">Sign in with your username & password or Google.</p>
                    </div>

                    <form class="auth-form" id="login-form">
                        <div class="auth-input-group">
                            <label for="login-username">Username</label>
                            <input type="text" id="login-username" name="username" placeholder="Enter username" required autocomplete="username" />
                        </div>
                        <div class="auth-input-group">
                            <label for="login-password">Password</label>
                            <input type="password" id="login-password" name="password" placeholder="Enter password" required autocomplete="current-password" />
                        </div>
                        <div class="auth-error-msg hidden" id="login-error"></div>
                        <button type="submit" class="auth-submit-btn">
                            Log In
                        </button>
                    </form>

                    <div class="auth-divider"><span>OR</span></div>

                    <button type="button" class="auth-google-btn" id="modal-google-btn-login">
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                        </svg>
                        <span>Sign in with Google</span>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modalOverlay);
        this.authModalEl = modalOverlay;

        // Wire tabs
        const tabBtns = modalOverlay.querySelectorAll<HTMLButtonElement>(".auth-modal-tab");
        const tabContents = {
            register: modalOverlay.querySelector("#tab-register") as HTMLElement,
            login: modalOverlay.querySelector("#tab-login") as HTMLElement,
        };

        tabBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                tabBtns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                const tab = btn.dataset.tab as "register" | "login";
                if (tab === "register") {
                    tabContents.register.classList.remove("hidden");
                    tabContents.login.classList.add("hidden");
                } else {
                    tabContents.login.classList.remove("hidden");
                    tabContents.register.classList.add("hidden");
                }
            });
        });

        // Close events
        modalOverlay.querySelector(".auth-modal-close")?.addEventListener("click", () => this.closeAuthModal());
        modalOverlay.querySelector(".auth-modal-backdrop")?.addEventListener("click", () => this.closeAuthModal());
        const escHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                this.closeAuthModal();
                document.removeEventListener("keydown", escHandler);
            }
        };
        document.addEventListener("keydown", escHandler);

        // Google buttons
        modalOverlay.querySelector("#modal-google-btn-reg")?.addEventListener("click", () => {
            void this.triggerGoogleLogin();
        });
        modalOverlay.querySelector("#modal-google-btn-login")?.addEventListener("click", () => {
            void this.triggerGoogleLogin();
        });

        // Handle Register / Upgrade submission
        const registerForm = modalOverlay.querySelector("#register-form") as HTMLFormElement;
        const registerError = modalOverlay.querySelector("#register-error") as HTMLElement;

        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            registerError.classList.add("hidden");
            registerError.textContent = "";

            const username = (modalOverlay.querySelector("#reg-username") as HTMLInputElement).value.trim();
            const password = (modalOverlay.querySelector("#reg-password") as HTMLInputElement).value;

            try {
                const browserId = getOrCreateBrowserId();
                const res = await fetch(`${config.apiUrl}/auth/register`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-browser-id": browserId,
                    },
                    credentials: "include",
                    body: JSON.stringify({ username, password }),
                });

                const data = await res.json();
                if (!res.ok || !data.success) {
                    registerError.textContent = data.error || "Registration failed.";
                    registerError.classList.remove("hidden");
                    return;
                }

                this.currentUser = data.user;
                try { localStorage.setItem("clipflip_user_id", String(data.user.id)); } catch (_) {}
                this.closeAuthModal();
                this.renderUser();
                this.onAuthChange?.(this.currentUser);
            } catch (err: any) {
                registerError.textContent = "Network error. Please try again.";
                registerError.classList.remove("hidden");
            }
        });

        // Handle Login submission
        const loginForm = modalOverlay.querySelector("#login-form") as HTMLFormElement;
        const loginError = modalOverlay.querySelector("#login-error") as HTMLElement;

        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            loginError.classList.add("hidden");
            loginError.textContent = "";

            const username = (modalOverlay.querySelector("#login-username") as HTMLInputElement).value.trim();
            const password = (modalOverlay.querySelector("#login-password") as HTMLInputElement).value;

            try {
                const browserId = getOrCreateBrowserId();
                const res = await fetch(`${config.apiUrl}/auth/login`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-browser-id": browserId,
                    },
                    credentials: "include",
                    body: JSON.stringify({ username, password }),
                });

                const data = await res.json();
                if (!res.ok || !data.success) {
                    loginError.textContent = data.error || "Login failed.";
                    loginError.classList.remove("hidden");
                    return;
                }

                this.currentUser = data.user;
                try { localStorage.setItem("clipflip_user_id", String(data.user.id)); } catch (_) {}
                this.closeAuthModal();
                this.renderUser();
                this.onAuthChange?.(this.currentUser);
            } catch (err: any) {
                loginError.textContent = "Network error. Please try again.";
                loginError.classList.remove("hidden");
            }
        });
    }

    public closeAuthModal() {
        if (this.authModalEl) {
            this.authModalEl.remove();
            this.authModalEl = null;
        }
    }

    async logout() {
        try {
            await fetch(`${config.apiUrl}/auth/logout`, {
                method: "POST",
                credentials: "include",
            });
        } catch (err) {
            console.warn("Logout error:", err);
        }
        this.currentUser = null;
        try {
            localStorage.removeItem("clipflip_user_id");
            localStorage.removeItem("clipflip_user_cache");
        } catch (_) {}
        // After logout, re-check auth to assign or fetch guest session seamlessly
        await this.checkAuth();
        this.renderUser();
        this.onAuthChange?.(this.currentUser);
    }
}
