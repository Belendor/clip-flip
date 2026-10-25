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
            if (data.loggedIn) this.currentUser = data.user;
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
        await this.loadGoogleSignIn();
        const buttonDiv = document.getElementById("google-login");
        if (!buttonDiv) return;
        buttonDiv.innerHTML = "";

        window.google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: this.handleGoogleLogin.bind(this),
        });

        window.google.accounts.id.renderButton(buttonDiv, {
            theme: "filled_black",
            type: "icon",
            size: "medium",
        });
    }

    async handleGoogleLogin(response: { credential: string }) {
        const res = await fetch(`${config.apiUrl}/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ credential: response.credential }),
        });

        const data = await res.json();
        if (!data.success) { console.error("Login failed"); return; }

        this.currentUser = data.user;
        this.renderUser();
    }

    renderUser() {
        const div = document.getElementById("google-login");
        if (!div || !this.currentUser) return;

        div.innerHTML = `
            <img
                src="${this.currentUser.picture}"
                title="${this.currentUser.email}"
                style="width:38px;height:38px;border-radius:50%;cursor:pointer;"
            />
        `;
        div.onclick = () => { this.logout(); };
    }

    async logout() {
        await fetch(`${config.apiUrl}/auth/logout`, {
            method: "POST",
            credentials: "include",
        });
        this.currentUser = null;
        await this.renderGoogleButton();
    }
}
