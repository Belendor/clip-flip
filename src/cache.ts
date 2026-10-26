class SimpleCache {
    private dbPromise: Promise<IDBDatabase> | null = null;

    private getDB(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            if (typeof window === "undefined" || !("indexedDB" in window)) {
                reject(new Error("IndexedDB not supported"));
                return;
            }
            const req = indexedDB.open("clipflip_db", 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("cache")) {
                    db.createObjectStore("cache");
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.dbPromise;
    }

    async get<T>(key: string): Promise<T | null> {
        try {
            const db = await this.getDB();
            return new Promise((resolve) => {
                const tx = db.transaction("cache", "readonly");
                const store = tx.objectStore("cache");
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => resolve(null);
            });
        } catch (_) {
            return null;
        }
    }

    async set<T>(key: string, value: T): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve) => {
                const tx = db.transaction("cache", "readwrite");
                const store = tx.objectStore("cache");
                const req = store.put(value, key);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            });
        } catch (_) {}
    }

    async remove(key: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve) => {
                const tx = db.transaction("cache", "readwrite");
                const store = tx.objectStore("cache");
                const req = store.delete(key);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            });
        } catch (_) {}
    }
}

export const dbCache = new SimpleCache();
