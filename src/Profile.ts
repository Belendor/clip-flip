import User, { AuthUser } from "./User";
import VideoApi from "./VideoApi";

export interface AdminUserRecord {
    id: number;
    email: string;
    name: string | null;
    picture: string | null;
    createdAt: string;
    updatedAt?: string;
    likesCount: number;
    uploadsCount: number;
    approvedUploads?: number;
    pendingUploads?: number;
    isAdmin?: boolean;
}

export interface AdminStatsData {
    totalUsers: number;
    totalLikes: number;
    totalVideos: number;
    totalUploads: number;
    pendingUploads: number;
    users: AdminUserRecord[];
}

export default class Profile {
    private user: User;
    private api: VideoApi;
    private container: HTMLElement | null = null;
    private isOpen: boolean = false;
    private onOpenCallback?: () => void;
    private onCloseCallback?: () => void;
    private onWatchFavoritesCallback?: () => void;

    constructor(
        user: User,
        api: VideoApi,
        onOpen?: () => void,
        onClose?: () => void,
        onWatchFavorites?: () => void
    ) {
        this.user = user;
        this.api = api;
        this.onOpenCallback = onOpen;
        this.onCloseCallback = onClose;
        this.onWatchFavoritesCallback = onWatchFavorites;

        this.init();
    }

    private init() {
        this.container = document.getElementById("profile-view");
        if (!this.container) {
            this.container = document.createElement("div");
            this.container.id = "profile-view";
            this.container.className = "profile-view hidden";
            document.body.appendChild(this.container);
        }

        // Wire User dropdown "My Profile" click
        this.user.onNavigateProfile = () => {
            this.open();
        };

        // Popstate handler for browser back/forward buttons
        window.addEventListener("popstate", () => {
            const isProfileRoute =
                window.location.pathname === "/profile" ||
                window.location.hash === "#profile";

            if (isProfileRoute && !this.isOpen) {
                this.open(false);
            } else if (!isProfileRoute && this.isOpen) {
                this.close(false);
            }
        });

        // Check if initial route is /profile or #profile
        if (
            window.location.pathname === "/profile" ||
            window.location.hash === "#profile"
        ) {
            // Give auth a moment to initialize before opening
            setTimeout(() => {
                this.open(false);
            }, 300);
        }
    }

    public open(pushHistory: boolean = true) {
        this.isOpen = true;
        if (this.container) {
            this.container.classList.remove("hidden");
        }

        if (pushHistory) {
            if (window.location.pathname !== "/profile") {
                try {
                    window.history.pushState({ page: "profile" }, "", "/profile");
                } catch (_) {
                    window.location.hash = "profile";
                }
            }
        }

        this.onOpenCallback?.();
        void this.render();
    }

    public close(pushHistory: boolean = true) {
        this.isOpen = false;
        if (this.container) {
            this.container.classList.add("hidden");
            this.container.innerHTML = "";
        }

        if (pushHistory) {
            if (window.location.pathname === "/profile") {
                try {
                    window.history.pushState({}, "", "/");
                } catch (_) {
                    window.location.hash = "";
                }
            }
        }

        this.onCloseCallback?.();
    }

    private async render() {
        if (!this.container) return;
        const currentUser = this.user.currentUser;

        if (!currentUser) {
            this.container.innerHTML = `
                <div class="profile-backdrop" id="profile-backdrop"></div>
                <div class="profile-modal">
                    <div class="profile-header-bar">
                        <button type="button" class="profile-back-btn" id="profile-back-btn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4">
                                <path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>Back to Videos</span>
                        </button>
                    </div>
                    <div class="profile-content text-center py-12">
                        <div class="text-4xl mb-3">🔒</div>
                        <h2 class="text-xl font-bold text-white mb-2">Sign in required</h2>
                        <p class="text-gray-400 mb-6 text-sm">Please sign in to view your profile and account information.</p>
                        <button type="button" class="profile-action-btn primary" id="profile-login-btn">
                            Sign in with Google
                        </button>
                    </div>
                </div>
            `;
            document.getElementById("profile-back-btn")?.addEventListener("click", () => this.close());
            document.getElementById("profile-backdrop")?.addEventListener("click", () => this.close());
            document.getElementById("profile-login-btn")?.addEventListener("click", () => {
                this.close();
                this.user.promptLogin();
            });
            return;
        }

        const isAdmin = !!currentUser.isAdmin;

        // Render skeleton / initial UI while fetching admin stats if admin
        this.container.innerHTML = `
            <div class="profile-backdrop" id="profile-backdrop"></div>
            <div class="profile-modal">
                <!-- Top Navigation -->
                <div class="profile-header-bar">
                    <button type="button" class="profile-back-btn" id="profile-back-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-4 h-4">
                            <path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Back to Videos</span>
                    </button>
                    <div class="profile-page-title">${isAdmin ? "Admin Profile" : "My Profile"}</div>
                    <button type="button" class="profile-logout-btn" id="profile-logout-btn" title="Log Out">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 mr-1">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="16 17 21 12 16 7" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="21" y1="12" x2="9" y2="12" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Log Out</span>
                    </button>
                </div>

                <div class="profile-scroll-body">
                    <!-- User Card -->
                    <div class="profile-card">
                        <div class="profile-avatar-wrap">
                            <img src="${currentUser.picture || "/favicon.png"}" alt="${currentUser.name || "User"}" class="profile-avatar" />
                            ${isAdmin ? '<span class="profile-admin-crown" title="Administrator">👑</span>' : ""}
                        </div>
                        <div class="profile-user-info">
                            <div class="profile-name-row">
                                <h1 class="profile-name">${currentUser.name || "ClipFlip User"}</h1>
                                ${isAdmin
                                    ? '<span class="admin-badge">ADMIN</span>'
                                    : '<span class="member-badge">MEMBER</span>'
                                }
                            </div>
                            <div class="profile-email">${currentUser.email}</div>
                            <div class="profile-meta-row">
                                <span class="profile-meta-item">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 mr-1 text-pink-400">
                                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    <strong>${currentUser.likesCount ?? 0}</strong> liked clips
                                </span>
                                <span class="profile-meta-divider">•</span>
                                <span class="profile-meta-item">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 mr-1 text-cyan-400">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke-linecap="round" stroke-linejoin="round"/>
                                        <polyline points="17 8 12 3 7 8" stroke-linecap="round" stroke-linejoin="round"/>
                                        <line x1="12" y1="3" x2="12" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    <strong>${currentUser.uploadsCount ?? 0}</strong> uploaded clips
                                </span>
                                ${currentUser.createdAt
                                    ? `<span class="profile-meta-divider">•</span>
                                       <span class="profile-meta-item text-gray-400">
                                           Joined ${new Date(currentUser.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                                       </span>`
                                    : ""
                                }
                            </div>
                        </div>
                    </div>

                    <!-- Admin or Regular Section -->
                    <div id="profile-dynamic-content" class="mt-6">
                        ${isAdmin
                            ? `<div class="profile-loading-spinner text-center py-8 text-gray-400">
                                   <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400 mb-2"></div>
                                   <div>Loading platform analytics...</div>
                               </div>`
                            : this.renderRegularProfileContent(currentUser)
                        }
                    </div>
                </div>
            </div>
        `;

        document.getElementById("profile-back-btn")?.addEventListener("click", () => this.close());
        document.getElementById("profile-backdrop")?.addEventListener("click", () => this.close());
        document.getElementById("profile-logout-btn")?.addEventListener("click", async () => {
            await this.user.logout();
            this.close();
        });

        document.getElementById("profile-watch-likes-btn")?.addEventListener("click", () => {
            this.close();
            this.onWatchFavoritesCallback?.();
        });

        if (isAdmin) {
            await this.loadAndRenderAdminStats();
        }
    }

    private renderRegularProfileContent(user: AuthUser): string {
        return `
            <div class="profile-section">
                <h3 class="profile-section-title">My Activity</h3>
                <div class="profile-stat-grid">
                    <div class="profile-stat-card">
                        <div class="profile-stat-num text-pink-400">${user.likesCount ?? 0}</div>
                        <div class="profile-stat-label">Liked Clips</div>
                    </div>
                    <div class="profile-stat-card">
                        <div class="profile-stat-num text-cyan-400">${user.uploadsCount ?? 0}</div>
                        <div class="profile-stat-label">Uploaded Clips</div>
                    </div>
                </div>
                <div class="mt-4">
                    <button type="button" class="profile-action-btn primary" id="profile-watch-likes-btn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 mr-2">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Watch My Liked Clips</span>
                    </button>
                </div>
            </div>
        `;
    }

    private async loadAndRenderAdminStats() {
        const dynamicContent = document.getElementById("profile-dynamic-content");
        if (!dynamicContent) return;

        try {
            const stats = await this.api.getAdminStats();
            this.renderAdminDashboard(dynamicContent, stats);
        } catch (error) {
            console.error("Failed to load admin stats:", error);
            dynamicContent.innerHTML = `
                <div class="p-4 bg-red-900/30 border border-red-500/30 rounded-xl text-red-200 text-sm">
                    Failed to fetch admin statistics. Please ensure you are logged in as an administrator.
                </div>
            `;
        }
    }

    private renderAdminDashboard(container: HTMLElement, stats: AdminStatsData) {
        container.innerHTML = `
            <!-- Admin KPI Stat Cards -->
            <div class="profile-section">
                <div class="flex items-center justify-between mb-3">
                    <h3 class="profile-section-title flex items-center">
                        <span class="mr-2">👑</span> Platform Statistics
                    </h3>
                    <span class="text-xs text-amber-400/80 font-mono">Live Data</span>
                </div>

                <div class="admin-kpi-grid">
                    <div class="admin-kpi-card">
                        <div class="admin-kpi-header">
                            <span class="admin-kpi-label">Registered Users</span>
                            <span class="admin-kpi-icon text-blue-400">👥</span>
                        </div>
                        <div class="admin-kpi-val text-blue-400">${stats.totalUsers.toLocaleString()}</div>
                        <div class="admin-kpi-sub">Total signed-up accounts</div>
                    </div>

                    <div class="admin-kpi-card">
                        <div class="admin-kpi-header">
                            <span class="admin-kpi-label">Total Likes Cast</span>
                            <span class="admin-kpi-icon text-pink-400">❤️</span>
                        </div>
                        <div class="admin-kpi-val text-pink-400">${stats.totalLikes.toLocaleString()}</div>
                        <div class="admin-kpi-sub">Across all videos & users</div>
                    </div>

                    <div class="admin-kpi-card">
                        <div class="admin-kpi-header">
                            <span class="admin-kpi-label">Total Videos</span>
                            <span class="admin-kpi-icon text-emerald-400">🎬</span>
                        </div>
                        <div class="admin-kpi-val text-emerald-400">${stats.totalVideos.toLocaleString()}</div>
                        <div class="admin-kpi-sub">In database library</div>
                    </div>

                    <div class="admin-kpi-card">
                        <div class="admin-kpi-header">
                            <span class="admin-kpi-label">User Uploads</span>
                            <span class="admin-kpi-icon text-cyan-400">📤</span>
                        </div>
                        <div class="admin-kpi-val text-cyan-400">${stats.totalUploads.toLocaleString()}</div>
                        <div class="admin-kpi-sub">${stats.pendingUploads} pending review</div>
                    </div>
                </div>
            </div>

            <!-- Users & Likes Table Section -->
            <div class="profile-section mt-6">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div>
                        <h3 class="profile-section-title mb-0.5">Registered Users (${stats.users.length})</h3>
                        <p class="text-xs text-gray-400">Users ranked by total likes and clips added</p>
                    </div>
                    <div class="admin-search-wrapper">
                        <input
                            type="text"
                            id="admin-user-search"
                            placeholder="Filter users..."
                            class="admin-search-input"
                            autocomplete="off"
                        />
                    </div>
                </div>

                <div class="admin-table-container">
                    <table class="admin-users-table">
                        <thead>
                            <tr>
                                <th class="text-left">#</th>
                                <th class="text-left">User</th>
                                <th class="text-left">Email</th>
                                <th class="text-right">Likes</th>
                                <th class="text-right">Uploads</th>
                                <th class="text-right">Registered</th>
                            </tr>
                        </thead>
                        <tbody id="admin-users-tbody">
                            ${this.renderUserRows(stats.users)}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Search filter listener
        const searchInput = document.getElementById("admin-user-search") as HTMLInputElement | null;
        const tbody = document.getElementById("admin-users-tbody");

        searchInput?.addEventListener("input", () => {
            const query = searchInput.value.toLowerCase().trim();
            const filtered = stats.users.filter(
                (u) =>
                    (u.name && u.name.toLowerCase().includes(query)) ||
                    u.email.toLowerCase().includes(query) ||
                    String(u.id).includes(query)
            );
            if (tbody) {
                tbody.innerHTML = this.renderUserRows(filtered);
            }
        });
    }

    private renderUserRows(users: AdminUserRecord[]): string {
        if (!users || users.length === 0) {
            return `
                <tr>
                    <td colspan="6" class="text-center py-6 text-gray-400 text-sm">
                        No registered users found
                    </td>
                </tr>
            `;
        }

        return users
            .map((u, index) => {
                const formattedDate = u.createdAt
                    ? new Date(u.createdAt).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                      })
                    : "—";

                const isCurrentUserAdmin = !!u.isAdmin;

                return `
                    <tr class="admin-user-row">
                        <td class="text-gray-500 font-mono text-xs">${index + 1}</td>
                        <td>
                            <div class="flex items-center gap-2.5">
                                <img
                                    src="${u.picture || "/favicon.png"}"
                                    alt="${u.name || "User"}"
                                    class="admin-table-avatar"
                                    onerror="this.src='/favicon.png'"
                                />
                                <div class="flex flex-col">
                                    <span class="admin-table-name font-medium text-white flex items-center gap-1.5">
                                        ${u.name || "Anonymous"}
                                        ${isCurrentUserAdmin ? '<span class="admin-tag-micro">ADMIN</span>' : ""}
                                    </span>
                                    <span class="text-[11px] text-gray-500 font-mono">ID: #${u.id}</span>
                                </div>
                            </div>
                        </td>
                        <td class="text-gray-300 font-mono text-xs select-all">
                            ${u.email}
                        </td>
                        <td class="text-right">
                            <span class="admin-like-pill ${u.likesCount > 0 ? "has-likes" : "zero-likes"}">
                                <svg viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3 mr-1 inline">
                                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                                </svg>
                                <strong>${u.likesCount.toLocaleString()}</strong>
                            </span>
                        </td>
                        <td class="text-right">
                            <span class="admin-upload-pill ${u.uploadsCount > 0 ? "has-uploads" : "zero-uploads"}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3 h-3 mr-1 inline">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke-linecap="round" stroke-linejoin="round"/>
                                    <polyline points="17 8 12 3 7 8" stroke-linecap="round" stroke-linejoin="round"/>
                                    <line x1="12" y1="3" x2="12" y2="15" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                <strong>${u.uploadsCount.toLocaleString()}</strong>
                            </span>
                        </td>
                        <td class="text-right text-gray-400 text-xs">
                            ${formattedDate}
                        </td>
                    </tr>
                `;
            })
            .join("");
    }
}
