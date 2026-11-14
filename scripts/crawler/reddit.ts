import https from "https";
import { RedGifsClient } from "./redgifs";
import type { CrawlOptions, ScrapedPost } from "./types";

export class RedditCrawler {
    private redgifs: RedGifsClient;
    private redditToken: string | null = null;
    private redditTokenExpiresAt: number = 0;
    private readonly userAgent = "nodejs:clipflip-crawler:v1.0.0 (by /u/clipflip-admin)";

    constructor(redgifs: RedGifsClient) {
        this.redgifs = redgifs;
    }

    async getRedditOAuthToken(): Promise<string | null> {
        const clientId = process.env.REDDIT_CLIENT_ID;
        const clientSecret = process.env.REDDIT_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return null;
        }

        const now = Date.now();
        if (this.redditToken && this.redditTokenExpiresAt > now + 60000) {
            return this.redditToken;
        }

        try {
            console.log("🔐 Authenticating with Reddit API (OAuth2)...");
            const authHeader = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
            const postData = "grant_type=client_credentials";

            const res = await new Promise<string>((resolve, reject) => {
                const req = https.request(
                    "https://www.reddit.com/api/v1/access_token",
                    {
                        method: "POST",
                        headers: {
                            Authorization: authHeader,
                            "User-Agent": this.userAgent,
                            "Content-Type": "application/x-www-form-urlencoded",
                            "Content-Length": Buffer.byteLength(postData),
                        },
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (c) => (data += c));
                        res.on("end", () => resolve(data));
                    }
                );
                req.on("error", reject);
                req.write(postData);
                req.end();
            });

            const parsed = JSON.parse(res);
            if (parsed.access_token) {
                this.redditToken = parsed.access_token;
                this.redditTokenExpiresAt = now + (parsed.expires_in || 3600) * 1000;
                console.log("✅ Reddit OAuth authenticated successfully!");
                return this.redditToken;
            }
            console.warn("Reddit auth response:", res);
        } catch (error) {
            console.warn("Could not authenticate with Reddit API:", error instanceof Error ? error.message : error);
        }

        return null;
    }

    async crawl(options: CrawlOptions): Promise<ScrapedPost[]> {
        const sub = options.subreddit.replace(/^r\//i, "").trim();
        const limit = options.limit || 25;
        const timeFilter = options.timeFilter || "month";
        const order = options.order || "top";

        console.log(`\n🔎 [1/4] Crawling posts for subreddit: r/${sub} (order: ${order}, time: ${timeFilter}, limit: ${limit})...`);

        // Mode 1: If Reddit OAuth credentials available, query Reddit OAuth API directly
        const oauthToken = await this.getRedditOAuthToken();
        if (oauthToken && options.mode !== "redgifs") {
            try {
                const posts = await this.fetchRedditOAuth(sub, order, timeFilter, limit, oauthToken);
                if (posts.length > 0) {
                    console.log(`📥 Successfully scraped ${posts.length} posts from Reddit OAuth!`);
                    return posts;
                }
            } catch (err) {
                console.warn("Reddit OAuth fetch failed, falling back to RedGIFs direct crawler...", err);
            }
        }

        // Mode 2: Direct RedGIFs search for subreddit tags / keywords
        console.log(`ℹ️ Crawling RedGIFs library directly for query "r/${sub}" or "${sub}"...`);
        const redgifsPosts = await this.crawlFromRedGifs(sub, limit, order);
        console.log(`📥 Found ${redgifsPosts.length} videos from RedGIFs!`);
        return redgifsPosts;
    }

    private async fetchRedditOAuth(
        subreddit: string,
        order: string,
        timeFilter: string,
        limit: number,
        token: string
    ): Promise<ScrapedPost[]> {
        const endpoint = `https://oauth.reddit.com/r/${subreddit}/${order}?t=${timeFilter}&limit=${limit}`;

        const raw = await new Promise<string>((resolve, reject) => {
            https
                .get(
                    endpoint,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "User-Agent": this.userAgent,
                        },
                    },
                    (res) => {
                        let data = "";
                        res.on("data", (c) => (data += c));
                        res.on("end", () => resolve(data));
                    }
                )
                .on("error", reject);
        });

        const json = JSON.parse(raw);
        const children = json.data?.children || [];
        const results: ScrapedPost[] = [];

        for (const item of children) {
            const data = item.data;
            if (!data) continue;

            const url = data.url_overridden_by_dest || data.url || "";
            const redgifsId = this.redgifs.extractId(url);

            results.push({
                id: data.id,
                title: data.title || `Clip from r/${subreddit}`,
                subreddit,
                author: data.author,
                score: data.score,
                url,
                redgifsId: redgifsId || undefined,
                permalink: data.permalink ? `https://reddit.com${data.permalink}` : undefined,
                tags: [
                    subreddit,
                    ...(data.link_flair_text ? [data.link_flair_text] : []),
                ],
            });
        }

        return results;
    }

    private async crawlFromRedGifs(
        query: string,
        limit: number,
        order: string
    ): Promise<ScrapedPost[]> {
        const redgifsOrder = order === "hot" ? "trending" : order === "new" ? "latest" : order;
        // Search by subreddit name with prefix "r/sub" or bare "sub"
        let gifs = await this.redgifs.search(`r/${query}`, limit, redgifsOrder);
        if (!gifs || gifs.length === 0) {
            gifs = await this.redgifs.search(query, limit, redgifsOrder);
        }

        return gifs.slice(0, limit).map((g) => ({
            id: g.id,
            title: g.tags && g.tags.length > 0 ? g.tags.slice(0, 3).join(", ") : `Clip from r/${query}`,
            subreddit: query,
            author: g.userName,
            score: g.likes || 0,
            url: g.urls.hd || `https://www.redgifs.com/watch/${g.id}`,
            redgifsId: g.id,
            tags: [query, ...(g.tags || [])],
        }));
    }
}
