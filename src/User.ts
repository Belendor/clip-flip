import { config } from "./config";

declare global {
    interface Window {
        google: any;
    }
}

export interface AuthUser {
    id: number;
    email: string;
    name?: string;
    picture?: string;
}

export default class User {
    currentUser: AuthUser | null = null;
    onAuthChange: ((user: AuthUser | null) => void) | null = null;
    private scriptLoadPromise: Promise<void> | null = null;

    constructor() {
        this.loadGoogleSignIn.bind(this);
    }

    async init() {
        await this.checkAuth();
        if (!this.currentUser) {
            await this.renderGoogleButton();
        } else {
            this.renderUser();
        }
    }

    getId() {
        return this.currentUser?.id;
    }

    async checkAuth() {
        try {
            const res = await fetch(`${config.apiUrl}/auth/me`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.loggedIn) {
                this.currentUser = data.user;
                this.onAuthChange?.(this.currentUser);
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

    async renderGoogleButton() {
        const buttonDiv = document.getElementById("google-login");
        if (!buttonDiv) return;
        buttonDiv.innerHTML = "";

        const authWrapper = document.createElement("div");
        authWrapper.className = "google-auth-wrapper";

        const customBtn = document.createElement("button");
        customBtn.type = "button";
        customBtn.className = "google-auth-pill";
        customBtn.title = "Sign in with Google";
        customBtn.innerHTML = `
            <svg class="google-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            <span class="auth-text">Sign In</span>
        `;

        const hiddenGsiContainer = document.createElement("div");
        hiddenGsiContainer.className = "hidden-gsi-container";
        hiddenGsiContainer.style.position = "absolute";
        hiddenGsiContainer.style.opacity = "0.01";
        hiddenGsiContainer.style.pointerEvents = "auto";
        hiddenGsiContainer.style.inset = "0";
        hiddenGsiContainer.style.zIndex = "2";

        authWrapper.appendChild(customBtn);
        authWrapper.appendChild(hiddenGsiContainer);
        buttonDiv.appendChild(authWrapper);

        await this.loadGoogleSignIn();

        try {
            window.google.accounts.id.initialize({
                client_id: config.googleClientId,
                callback: this.handleGoogleLogin.bind(this),
            });

            window.google.accounts.id.renderButton(hiddenGsiContainer, {
                theme: "filled_black",
                size: "large",
                width: 110,
            });
        } catch (e) {
            console.warn("Could not render GIS overlay button", e);
            customBtn.onclick = () => {
                window.google?.accounts?.id?.prompt();
            };
        }
    }

    async handleGoogleLogin(response: { credential: string }) {
        try {
            const res = await fetch(`${config.apiUrl}/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ credential: response.credential }),
            });

            const data = await res.json();
            if (!data.success) {
                console.error("Login failed", data);
                return;
            }

            this.currentUser = data.user;
            this.renderUser();
            this.onAuthChange?.(this.currentUser);
        } catch (err) {
            console.error("Auth request error:", err);
        }
    }

    renderUser() {
        const div = document.getElementById("google-login");
        if (!div || !this.currentUser) return;
        div.innerHTML = "";

        const container = document.createElement("div");
        container.className = "user-menu-container";

        const userPill = document.createElement("button");
        userPill.type = "button";
        userPill.className = "google-user-pill";
        userPill.title = this.currentUser.email;

        const avatar = document.createElement("img");
        avatar.src = this.currentUser.picture || "/favicon.png";
        avatar.alt = this.currentUser.name || "User";
        avatar.className = "user-avatar";

        const nameLabel = document.createElement("span");
        nameLabel.className = "user-name";
        nameLabel.textContent = this.currentUser.name?.split(" ")[0] || "Account";

        const chevron = document.createElement("span");
        chevron.className = "user-menu-chevron";
        chevron.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13">
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;

        userPill.appendChild(avatar);
        userPill.appendChild(nameLabel);
        userPill.appendChild(chevron);

        // Dropdown menu
        const dropdown = document.createElement("div");
        dropdown.className = "user-dropdown-menu hidden";

        const header = document.createElement("div");
        header.className = "user-dropdown-header";
        const emailSpan = document.createElement("div");
        emailSpan.className = "user-dropdown-email";
        emailSpan.textContent = this.currentUser.email;
        header.appendChild(emailSpan);

        const divider = document.createElement("div");
        divider.className = "user-dropdown-divider";

        const linksList = document.createElement("div");
        linksList.className = "user-dropdown-links";

        // First link: Log Out
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
        this.onAuthChange?.(null);
        await this.renderGoogleButton();
    }
}
