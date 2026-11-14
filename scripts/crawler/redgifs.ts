import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import type { RedGifsMetadata } from "./types";

export class RedGifsClient {
    private token: string | null = null;
    private tokenExpiresAt: number = 0;
    private readonly userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    async getToken(): Promise<string> {
        const now = Date.now();
        if (this.token && this.tokenExpiresAt > now + 60000) {
            return this.token;
        }

        console.log("🔑 Authenticating with RedGIFs temporary token...");
        const res = await this.httpGet("https://api.redgifs.com/v2/auth/temporary");
        const json = JSON.parse(res);
        if (!json.token) {
            throw new Error(`Failed to obtain RedGIFs token: ${res}`);
        }

        this.token = json.token;
        // Tokens typically valid for 24h; refresh after 12h
        this.tokenExpiresAt = now + 12 * 3600 * 1000;
        return this.token;
    }

    /**
     * Extracts RedGIFs ID from any RedGIFs URL format
     */
    extractId(url: string): string | null {
        if (!url) return null;

        // Matches https://www.redgifs.com/watch/someid or https://v3.redgifs.com/watch/someid
        const watchMatch = url.match(/redgifs\.com\/watch\/([a-zA-Z0-9]+)/i);
        if (watchMatch) return watchMatch[1].toLowerCase();

        // Matches https://www.redgifs.com/ifr/someid
        const ifrMatch = url.match(/redgifs\.com\/ifr\/([a-zA-Z0-9]+)/i);
        if (ifrMatch) return ifrMatch[1].toLowerCase();

        // Matches direct media links: https://media.redgifs.com/SomeId.mp4 or thumbs2.redgifs.com/SomeId.mp4
        const mediaMatch = url.match(/redgifs\.com\/([a-zA-Z0-9]+)(?:-mobile|-silent)?\.(?:mp4|webm|jpg)/i);
        if (mediaMatch && !["watch", "ifr", "explore", "trending", "tags"].includes(mediaMatch[1].toLowerCase())) {
            return mediaMatch[1].toLowerCase();
        }

        return null;
    }

    async getGif(id: string): Promise<RedGifsMetadata | null> {
        const token = await this.getToken();
        try {
            const raw = await this.httpGet(`https://api.redgifs.com/v2/gifs/${id.toLowerCase()}`, {
                Authorization: `Bearer ${token}`,
            });
            const parsed = JSON.parse(raw);
            const gif = parsed.gif;
            if (!gif) return null;

            return {
                id: gif.id,
                urls: gif.urls || {},
                duration: Number(gif.duration) || 0,
                tags: gif.tags || [],
                userName: gif.userName || "",
                likes: Number(gif.likes) || 0,
                views: Number(gif.views) || 0,
            };
        } catch (error) {
            console.warn(`Could not fetch RedGIF info for ${id}:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

    async search(
        query: string,
        count: number = 20,
        order: string = "top",
        page: number = 1
    ): Promise<RedGifsMetadata[]> {
        const token = await this.getToken();
        const encoded = encodeURIComponent(query);
        const url = `https://api.redgifs.com/v2/gifs/search?search_text=${encoded}&count=${count}&order=${order}&page=${page}`;

        try {
            const raw = await this.httpGet(url, {
                Authorization: `Bearer ${token}`,
            });
            const parsed = JSON.parse(raw);
            const gifs = parsed.gifs || [];

            return gifs.map((g: any) => ({
                id: g.id,
                urls: g.urls || {},
                duration: Number(g.duration) || 0,
                tags: g.tags || [],
                userName: g.userName || "",
                likes: Number(g.likes) || 0,
                views: Number(g.views) || 0,
            }));
        } catch (error) {
            console.error(`RedGIFs search failed for "${query}":`, error instanceof Error ? error.message : error);
            return [];
        }
    }

    async downloadFile(fileUrl: string, destPath: string): Promise<void> {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        return new Promise<void>((resolve, reject) => {
            const requestWithRedirects = (currentUrl: string, redirectCount = 0) => {
                if (redirectCount > 5) {
                    reject(new Error(`Too many redirects when downloading: ${fileUrl}`));
                    return;
                }

                const parsed = new URL(currentUrl);
                const client = parsed.protocol === "https:" ? https : http;

                const req = client.get(
                    currentUrl,
                    {
                        headers: {
                            "User-Agent": this.userAgent,
                            Referer: "https://www.redgifs.com/",
                        },
                    },
                    (res) => {
                        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            const nextUrl = new URL(res.headers.location, currentUrl).toString();
                            requestWithRedirects(nextUrl, redirectCount + 1);
                            return;
                        }

                        if (res.statusCode !== 200) {
                            reject(new Error(`Failed to download ${fileUrl} (status: ${res.statusCode})`));
                            return;
                        }

                        const fileStream = fs.createWriteStream(destPath);
                        res.pipe(fileStream);

                        fileStream.on("finish", () => {
                            fileStream.close();
                            resolve();
                        });

                        fileStream.on("error", (err) => {
                            fs.unlink(destPath, () => {});
                            reject(err);
                        });
                    }
                );

                req.on("error", (err) => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            };

            requestWithRedirects(fileUrl);
        });
    }

    private httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const client = parsed.protocol === "https:" ? https : http;

            const req = client.get(
                url,
                {
                    headers: {
                        "User-Agent": this.userAgent,
                        Accept: "application/json, text/plain, */*",
                        ...headers,
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => {
                        data += chunk;
                    });
                    res.on("end", () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                        } else {
                            resolve(data);
                        }
                    });
                }
            );

            req.on("error", reject);
        });
    }
}
