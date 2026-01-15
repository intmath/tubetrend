export default {
    getApiKeys(env) {
        if (!env.YOUTUBE_API_KEYS) return [];
        return env.YOUTUBE_API_KEYS.split(',').map(key => key.trim());
    },

    // Default Data
    async restoreDefaults(env, region) {
        const { RANKING_DATA, LIVE_DATA } = await import('./default_channels.js');
        const today = this.getKSTDate();

        // 1. Restore Ranking Data (Channels & ChannelStats)
        if (RANKING_DATA && RANKING_DATA.length > 0) {
            console.log(`Restoring ${RANKING_DATA.length} ranking channels...`);
            const stmts = RANKING_DATA.flatMap(item => [
                env.DB.prepare(`INSERT OR IGNORE INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?)`).bind(item.id, item.title, item.country || "KR", item.category || "0", item.thumbnail || ""),
                env.DB.prepare(`INSERT OR IGNORE INTO ChannelStats (channel_id, subs, views, rank_date) VALUES (?, 0, 0, ?)`).bind(item.id, today)
            ]);
            await env.DB.batch(stmts);
        }

        // 2. Restore Live Data (LiveStreamers only)
        if (LIVE_DATA && LIVE_DATA.length > 0) {
            console.log(`Restoring ${LIVE_DATA.length} live streamers...`);
            const liveStmts = LIVE_DATA.map(item =>
                env.DB.prepare(`INSERT OR IGNORE INTO LiveStreamers (channel_id, title, thumbnail, region, last_live_date) VALUES (?, ?, ?, ?, ?)`).bind(item.id, item.title, item.thumbnail || "", region, null)
            );
            await env.DB.batch(liveStmts);
        }
    },

    async fetchWithFallback(url, env) {
        const keys = this.getApiKeys(env);
        if (keys.length === 0) throw new Error("No API Keys found");

        let lastErrorData = null;
        // Start from the first key (Sequential Fallback)

        for (let i = 0; i < keys.length; i++) {
            const currentKey = keys[i];
            const separator = url.includes('?') ? '&' : '?';
            const fullUrl = `${url}${separator}key=${currentKey}`;
            const res = await fetch(fullUrl);

            if (res.ok) return res;

            if (res.status === 403) {
                const data = await res.clone().json();
                if (data.error?.errors?.some(e => e.reason === 'quotaExceeded')) {
                    console.log(`Key ${currentKey.slice(0, 5)}... quota exceeded. Rotated to next key.`);
                    lastErrorData = data;
                    continue;
                }
            }
            return res;
        }
        return new Response(JSON.stringify(lastErrorData || { error: "All keys quota exceeded" }), { status: 403 });
    },

    getKSTDate(offsetDays = 0) {
        const now = new Date();
        const targetDate = new Date(now.getTime() + (9 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000));
        return targetDate.toISOString().split('T')[0];
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const region = url.searchParams.get("region") || "KR";

        // 1. 실시간 라이브 API
        if (url.pathname === "/api/live-ranking") {
            const { results } = await env.DB.prepare(`SELECT channel_name, video_title, viewers, thumbnail, video_id FROM LiveRankings WHERE region = ? ORDER BY viewers DESC LIMIT 100`).bind(region).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // 2. 채널 랭킹 API (절대 순위 반영)
        if (url.pathname === "/api/ranking") {
            const sort = url.searchParams.get("sort") || "subs";
            const category = url.searchParams.get("category") || "all";
            const searchStr = url.searchParams.get("search") || "";
            let filterConditions = ["1=1"];
            let filterBindings = [];
            if (region !== "ALL") { filterConditions.push("c.country = ?"); filterBindings.push(region); }
            if (category !== "all") { filterConditions.push("c.category = ?"); filterBindings.push(category); }
            if (category !== "all") { filterConditions.push("c.category = ?"); filterBindings.push(category); }
            const orderByColumn = sort === "views" ? "MAX(t.views)" : "MAX(t.subs)";

            // Check for Empty DB & Auto-Restore
            const { count } = await env.DB.prepare("SELECT count(*) as count FROM Channels").first();
            if (count === 0) {
                await this.restoreDefaults(env, region);
            }

            const query = `
                WITH LatestDate AS (SELECT MAX(rank_date) as d FROM ChannelStats),
                PrevDate AS (SELECT MAX(rank_date) as pd FROM ChannelStats WHERE rank_date < (SELECT d FROM LatestDate)),
                RankedData AS (
                    SELECT c.id, c.title, c.category, c.country, c.thumbnail, 
                           MAX(t.subs) AS current_subs, MAX(t.views) AS current_views,
                           (MAX(t.subs) - IFNULL(MAX(y.subs), MAX(t.subs))) AS growth,
                           ROW_NUMBER() OVER (ORDER BY ${orderByColumn} DESC) as absolute_rank
                    FROM Channels c
                    JOIN ChannelStats t ON c.id = t.channel_id AND t.rank_date = (SELECT d FROM LatestDate)
                    LEFT JOIN ChannelStats y ON c.id = y.channel_id AND y.rank_date = (SELECT pd FROM PrevDate)
                    WHERE ${filterConditions.join(" AND ")}
                    GROUP BY c.id
                )
                SELECT * FROM RankedData WHERE title LIKE ? ORDER BY absolute_rank ASC LIMIT 300
            `;
            const { results } = await env.DB.prepare(query).bind(...filterBindings, `%${searchStr}%`).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // 3. TOP 300 일괄 수집 (백그라운드)
        if (url.pathname === "/api/batch-collect") {
            ctx.waitUntil((async () => {
                const today = this.getKSTDate();
                let allIds = [];
                let nextToken = "";
                for (let i = 0; i < 6; i++) {
                    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&regionCode=${region}&order=viewCount&maxResults=50&pageToken=${nextToken}`;
                    const res = await this.fetchWithFallback(searchUrl, env);
                    const data = await res.json();
                    if (data.items) allIds.push(...data.items.map(item => item.id.channelId));
                    nextToken = data.nextPageToken;
                    if (!nextToken) break;
                }
                if (allIds.length > 0) {
                    for (let i = 0; i < allIds.length; i += 50) {
                        const batchIds = allIds.slice(i, i + 50).join(',');
                        const vRes = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${batchIds}`, env);
                        const vData = await vRes.json();
                        if (vData.items) {
                            let stmts = vData.items.map(item => [
                                env.DB.prepare(`INSERT INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title`).bind(item.id, item.snippet.title, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url),
                                env.DB.prepare(`INSERT OR REPLACE INTO ChannelStats (channel_id, subs, views, rank_date) VALUES (?, ?, ?, ?)`).bind(item.id, parseInt(item.statistics.subscriberCount || 0), parseInt(item.statistics.viewCount || 0), today)
                            ]).flat();
                            await env.DB.batch(stmts);
                        }
                    }
                }
            })());
            return new Response(JSON.stringify({ success: true }));
        }

        // 4. SYNC (기존 채널 갱신)
        if (url.pathname === "/mass-discover") {
            ctx.waitUntil((async () => {
                await Promise.all([
                    (async () => {
                        await this.performMassDiscover(env, region);
                        await this.handleDailySync(env);
                        await this.syncAllTrends(env, region); // Renamed to syncAllTrends
                    })()
                ]);
            })());
            return new Response(JSON.stringify({ success: true }));
        }

        // 4-1. LIVE SYNC (라이브 검색 전용)
        if (url.pathname === "/api/sync-live") {
            ctx.waitUntil((async () => {
                await this.syncLiveStreams(env, region);
            })());
            return new Response(JSON.stringify({ success: true }));
        }

        // 5. 채널 개별 등록 API (핸들 지원)
        if (url.pathname === "/api/add-channel") {
            const inputId = url.searchParams.get("id");
            let channelUrl = inputId.startsWith('@') ?
                `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(inputId)}` :
                `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${inputId}`;

            const res = await this.fetchWithFallback(channelUrl, env);
            const data = await res.json();
            if (!data.items || data.items.length === 0) return new Response(JSON.stringify({ success: false, error: "Not found" }), { status: 404 });

            const item = data.items[0];
            await env.DB.batch([
                env.DB.prepare(`INSERT INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title`).bind(item.id, item.snippet.title, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url),
                env.DB.prepare(`INSERT OR REPLACE INTO ChannelStats (channel_id, subs, views, rank_date) VALUES (?, ?, ?, ?)`).bind(item.id, parseInt(item.statistics.subscriberCount || 0), parseInt(item.statistics.viewCount || 0), this.getKSTDate())
            ]);
            return new Response(JSON.stringify({ success: true, title: item.snippet.title }));
        }

        // 6. 국가 강제 지정 (Override)
        if (url.pathname === "/api/force-country") {
            const inputId = url.searchParams.get("id");
            const newCountry = url.searchParams.get("country");
            if (!inputId || !newCountry) return new Response(JSON.stringify({ success: false, error: "Missing parameters" }), { status: 400 });

            let targetId = inputId;
            if (inputId.startsWith('@')) {
                const res = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(inputId)}`, env);
                const data = await res.json();
                if (!data.items || data.items.length === 0) return new Response(JSON.stringify({ success: false, error: "Invalid Handle" }), { status: 404 });
                targetId = data.items[0].id;
            }

            const { meta } = await env.DB.prepare("UPDATE Channels SET country = ? WHERE id = ?").bind(newCountry, targetId).run();
            if (meta.changes === 0) return new Response(JSON.stringify({ success: false, error: "Channel not found in DB" }), { status: 404 });
            return new Response(JSON.stringify({ success: true, id: targetId, country: newCountry }));
        }

        // 7. DB HARD RESET (Reset to default_channels.js)
        if (url.pathname === "/api/reset-db") {
            try {
                // Wipe All Tables (Order Matters for Foreign Keys!)
                await env.DB.batch([
                    env.DB.prepare("DELETE FROM ChannelStats"),
                    env.DB.prepare("DELETE FROM LiveRankings"),
                    env.DB.prepare("DELETE FROM LiveStreamers"),
                    env.DB.prepare("DELETE FROM ShortsCache"),
                    env.DB.prepare("DELETE FROM Channels")
                ]);

                // Restore Defaults
                await this.restoreDefaults(env, region);

                return new Response(JSON.stringify({ success: true }));
            } catch (e) {
                return new Response(JSON.stringify({ success: false, error: e.message }));
            }
        }

        if (url.pathname === "/api/trending") {
            const region = url.searchParams.get("region") || "US";
            const category = url.searchParams.get("category") || "all";

            try {
                // ALWAYS Read from Cache
                const { results } = await env.DB.prepare("SELECT data FROM ShortsCache WHERE type = 'regular' AND region = ? ORDER BY rank ASC").bind(region).all();

                let items = [];
                if (results && results.length > 0) {
                    items = results.map(r => JSON.parse(r.data));

                    // Client-side Filtering (Backend)
                    if (category !== 'all') {
                        items = items.filter(i => i.categoryId === category);
                    }
                }

                return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });

            } catch (e) {
                return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
            }
        }

        if (url.pathname === "/api/shorts-viral") {
            const region = url.searchParams.get("region") || "KR";
            try {
                const { results } = await env.DB.prepare("SELECT data FROM ShortsCache WHERE type = 'viral' AND region = ? ORDER BY rank ASC").bind(region).all();
                return new Response(JSON.stringify(results.map(r => JSON.parse(r.data))), { headers: { "Content-Type": "application/json" } });
            } catch (e) {
                return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
            }
        }

        if (url.pathname === "/api/shorts-trending") {
            const region = url.searchParams.get("region") || "KR";
            try {
                const { results } = await env.DB.prepare("SELECT data FROM ShortsCache WHERE type = 'trending' AND region = ? ORDER BY rank ASC").bind(region).all();
                return new Response(JSON.stringify(results.map(r => JSON.parse(r.data))), { headers: { "Content-Type": "application/json" } });
            } catch (e) {
                return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
            }
        }

        if (url.pathname === "/api/channel-history") {
            const channelId = url.searchParams.get("id");
            const { results } = await env.DB.prepare(`SELECT rank_date, MAX(subs) as subs, MAX(views) as views FROM ChannelStats WHERE channel_id = ? GROUP BY rank_date ORDER BY rank_date ASC LIMIT 14`).bind(channelId).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        if (url.pathname === "/api/init-tables") {
            await env.DB.prepare(`DROP TABLE IF EXISTS LiveStreamers`).run();
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS LiveStreamers (
                channel_id TEXT PRIMARY KEY,
                title TEXT,
                thumbnail TEXT,
                last_live_date TEXT,
                region TEXT
            )`).run();
            return new Response("LiveStreamers table initialized.");
        }

        if (url.pathname === "/api/optimize-db") {
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channelstats_date_channel ON ChannelStats(rank_date, channel_id)`).run();
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channels_category ON Channels(category)`).run();
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channels_country ON Channels(country)`).run();
            return new Response("Database optimized with indexes.");
        }

        if (url.pathname === "/api/optimize-db") {
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channelstats_date_channel ON ChannelStats(rank_date, channel_id)`).run();
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channels_category ON Channels(category)`).run();
            await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_channels_country ON Channels(country)`).run();
            return new Response("Database optimized with indexes.");
        }

        if (url.pathname === "/api/all-live-streamers") {
            const { results } = await env.DB.prepare("SELECT channel_id, title, last_live_date FROM LiveStreamers").all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },

    async syncLiveStreams(env, region) {

        // 1. Parallel Execution: Discovery (Search) & Saved Channel Check (Activities)
        const discoveryPromise = (async () => {
            try {
                const res = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&regionCode=${region}&q=${encodeURIComponent(region === 'KR' ? '라이브|실시간' : 'live')}&maxResults=50`, env);
                const data = await res.json();
                return data.items || [];
            } catch (e) {
                console.error("Discovery failed", e);
                return [];
            }
        })();

        const activitiesCheckPromise = (async () => {
            const { results } = await env.DB.prepare("SELECT channel_id FROM LiveStreamers WHERE region = ?").bind(region).all();
            const allSavedIds = results.map(r => r.channel_id);
            console.log(`Checking ${allSavedIds.length} saved channels via Activities API...`);
            return await this.checkLiveStatusViaActivities(env, allSavedIds);
        })();

        const [newChannels, additionalVideoIds] = await Promise.all([discoveryPromise, activitiesCheckPromise]);

        // 2. Accumulate (Insert new channels to LiveStreamers with last_live_date)
        const today = this.getKSTDate();
        const accStmts = newChannels.map(item =>
            env.DB.prepare(`INSERT INTO LiveStreamers (channel_id, title, thumbnail, region, last_live_date) VALUES (?, ?, ?, ?, ?) 
            ON CONFLICT(channel_id) DO UPDATE SET last_live_date=excluded.last_live_date, title=excluded.title, thumbnail=excluded.thumbnail, region=excluded.region`)
                .bind(item.snippet.channelId, item.snippet.channelTitle, item.snippet.thumbnails.default.url, region, today)
        );
        if (accStmts.length > 0) await env.DB.batch(accStmts);

        // 3. Merge Video IDs & Deduplicate
        const allVideoIds = [
            ...newChannels.map(i => i.id.videoId),
            ...additionalVideoIds
        ];
        const uniqueVideoIds = [...new Set(allVideoIds)];

        // 4. Fetch Details for ALL
        let finalLiveItems = [];
        if (uniqueVideoIds.length > 0) {
            for (let i = 0; i < uniqueVideoIds.length; i += 50) {
                const batch = uniqueVideoIds.slice(i, i + 50).join(',');
                try {
                    const vRes = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${batch}`, env);
                    const vData = await vRes.json();
                    if (vData.items) finalLiveItems.push(...vData.items);
                } catch (e) {
                    console.error("Video details fetch failed", e);
                }
            }
        }

        // 6. Sort by Viewers & Save top 100
        finalLiveItems = finalLiveItems.filter(item => item.liveStreamingDetails && (item.liveStreamingDetails.concurrentViewers || item.snippet.liveBroadcastContent === 'live'));
        finalLiveItems.sort((a, b) => parseInt(b.liveStreamingDetails?.concurrentViewers || 0) - parseInt(a.liveStreamingDetails?.concurrentViewers || 0));
        const top100 = finalLiveItems.slice(0, 100);

        await env.DB.prepare("DELETE FROM LiveRankings WHERE region = ?").bind(region).run();

        const stmts = top100.map(item => env.DB.prepare(`INSERT INTO LiveRankings (channel_name, video_title, viewers, thumbnail, video_id, region) VALUES (?, ?, ?, ?, ?, ?)`).bind(
            item.snippet.channelTitle,
            item.snippet.title,
            parseInt(item.liveStreamingDetails?.concurrentViewers || 0),
            item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url,
            item.id,
            region
        ));
        if (stmts.length > 0) await env.DB.batch(stmts);

        // 7. Pruning (Remove inactive channels > 30 days)
        try {
            const thirtyDaysAgo = this.getKSTDate(-30);
            await env.DB.prepare("DELETE FROM LiveStreamers WHERE last_live_date < ?").bind(thirtyDaysAgo).run();
            // Optional: Also delete NULL dates if you want to clean up old legacy data immediately, 
            // but safer to let them stay until they are confirmed inactive or we manually migrate.
            // For now, let's also delete NULLs if we want aggressive cleaning, OR update them to today if found.
            // Let's stick to deleting explicit old dates.
        } catch (e) { console.error("Pruning failed", e); }
    },

    async checkLiveStatusViaActivities(env, channelIds) {
        if (!channelIds || channelIds.length === 0) return [];

        const activityPromises = channelIds.map(async (cid) => {
            try {
                // Cost: 1 unit
                const res = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/activities?part=contentDetails&channelId=${cid}&maxResults=1`, env);
                const data = await res.json();
                if (data.items && data.items.length > 0) {
                    const latest = data.items[0];
                    if (latest.contentDetails?.upload?.videoId) {
                        return latest.contentDetails.upload.videoId;
                    }
                }
            } catch (e) {
                return null;
            }
            return null;
        });

        const results = await Promise.all(activityPromises);
        return [...new Set(results.filter(id => id))];
    },

    async performMassDiscover(env, region) {
        const categories = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28", "29"];
        const promises = categories.map(catId => this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=${region}&videoCategoryId=${catId}&maxResults=50`, env).then(res => res.json()));
        const results = await Promise.all(promises);
        let allStmts = [];
        results.forEach(data => {
            if (data.items) {
                const stmts = data.items.map(item => env.DB.prepare(`INSERT INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title`).bind(item.snippet.channelId, item.snippet.channelTitle, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url));
                allStmts.push(...stmts);
            }
        });
        if (allStmts.length > 0) await env.DB.batch(allStmts);
    },

    async handleDailySync(env) {
        const { results } = await env.DB.prepare("SELECT id FROM Channels").all();
        const today = this.getKSTDate();

        const batchPromises = [];
        for (let i = 0; i < results.length; i += 50) {
            batchPromises.push((async () => {
                const ids = results.slice(i, i + 50).map(c => c.id).join(',');
                const res = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${ids}`, env);
                const data = await res.json();
                if (data.items) {
                    const stmts = data.items.flatMap(item => [
                        // SELF-CORRECTION: Always update country from API if available
                        item.snippet.country ? env.DB.prepare(`UPDATE Channels SET thumbnail = ?, country = ? WHERE id = ?`).bind(item.snippet.thumbnails.default.url, item.snippet.country, item.id)
                            : env.DB.prepare(`UPDATE Channels SET thumbnail = ? WHERE id = ?`).bind(item.snippet.thumbnails.default.url, item.id),
                        env.DB.prepare(`INSERT OR REPLACE INTO ChannelStats (channel_id, subs, views, rank_date) VALUES (?, ?, ?, ?)`).bind(item.id, parseInt(item.statistics.subscriberCount || 0), parseInt(item.statistics.viewCount || 0), today)
                    ]);
                    await env.DB.batch(stmts);
                }
            })());
        }
        await Promise.all(batchPromises);
    },

    async syncAllTrends(env, region) { // Renamed
        try {
            await env.DB.prepare("CREATE TABLE IF NOT EXISTS ShortsCache (video_id TEXT, type TEXT, data TEXT, region TEXT, rank INTEGER, PRIMARY KEY (video_id, type, region))").run();

            // 1. Regular Trending (Videos)
            let regularItems = [];
            // Fetch 4 pages (~200 items)
            let nextToken = "";
            for (let i = 0; i < 4; i++) {
                const searchUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=50&pageToken=${nextToken}`;
                try {
                    const res = await this.fetchWithFallback(searchUrl, env);
                    const data = await res.json();
                    if (data.items) {
                        regularItems.push(...data.items.map(item => ({
                            id: item.id,
                            title: item.snippet.title,
                            channel: item.snippet.channelTitle,
                            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url,
                            views: item.statistics.viewCount,
                            date: item.snippet.publishedAt.slice(0, 10),
                            categoryId: item.snippet.categoryId // Stored for filtering
                        })));
                    }
                    nextToken = data.nextPageToken;
                    if (!nextToken) break;
                } catch (e) { break; }
            }

            // 2. Trending Shorts Logic
            let trendItems = [];
            const searchUrlT = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('쇼츠')}&type=video&videoDuration=short&regionCode=${region}&order=viewCount&maxResults=50`;
            const searchResT = await this.fetchWithFallback(searchUrlT, env);
            const searchDataT = await searchResT.json();

            if (searchDataT.items) {
                const videoIds = searchDataT.items.map(item => item.id.videoId).join(',');
                if (videoIds) {
                    const vRes = await this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds}`, env);
                    const vData = await vRes.json();
                    if (vData.items) {
                        trendItems = vData.items.filter(v => {
                            if (region === 'KR') {
                                const text = (v.snippet.title + " " + v.snippet.description + " " + v.snippet.channelTitle).toLowerCase();
                                return /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
                            }
                            return true;
                        }).map(v => ({
                            id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, thumbnail: v.snippet.thumbnails.high?.url || v.snippet.thumbnails.default.url, views: parseInt(v.statistics.viewCount || 0), date: v.snippet.publishedAt.slice(0, 10), vf: 0 // placeholder
                        }));
                        trendItems.sort((a, b) => b.views - a.views);
                    }
                }
            }

            // 2. Viral Shorts Logic
            let viralItems = [];
            const searchUrlV = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('쇼츠')}&type=video&videoDuration=short&regionCode=${region}&order=viewCount&maxResults=50`;
            const searchResV = await this.fetchWithFallback(searchUrlV, env);
            const searchDataV = await searchResV.json();

            if (searchDataV.items) {
                const videoIds = searchDataV.items.map(item => item.id.videoId).join(',');
                const channelIds = [...new Set(searchDataV.items.map(item => item.snippet.channelId))].join(',');

                const [vRes, cRes] = await Promise.all([
                    this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds}`, env),
                    this.fetchWithFallback(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds}`, env)
                ]);
                const vData = await vRes.json();
                const cData = await cRes.json();

                if (vData.items && cData.items) {
                    const subMap = {};
                    cData.items.forEach(c => subMap[c.id] = parseInt(c.statistics.subscriberCount || 1));

                    viralItems = vData.items.filter(v => {
                        if (region === 'KR') {
                            const text = (v.snippet.title + " " + v.snippet.description + " " + v.snippet.channelTitle).toLowerCase();
                            return /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
                        }
                        return true;
                    }).map(v => {
                        const views = parseInt(v.statistics.viewCount || 0);
                        const subs = subMap[v.snippet.channelId] || 1;
                        const vf = (views / subs);
                        return { id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, thumbnail: v.snippet.thumbnails.high?.url || v.snippet.thumbnails.default.url, views: views, subs: subs, vf: parseFloat(vf.toFixed(2)), date: v.snippet.publishedAt.slice(0, 10) };
                    });
                    viralItems.sort((a, b) => b.vf - a.vf);
                }
            }

            // 3. Save to DB
            await env.DB.prepare("DELETE FROM ShortsCache WHERE region = ?").bind(region).run();

            let stmts = [];
            regularItems.forEach((item, idx) => {
                stmts.push(env.DB.prepare("INSERT INTO ShortsCache (video_id, type, data, region, rank) VALUES (?, ?, ?, ?, ?)").bind(item.id, 'regular', JSON.stringify(item), region, idx));
            });
            trendItems.forEach((item, idx) => {
                stmts.push(env.DB.prepare("INSERT INTO ShortsCache (video_id, type, data, region, rank) VALUES (?, ?, ?, ?, ?)").bind(item.id, 'trending', JSON.stringify(item), region, idx));
            });
            viralItems.forEach((item, idx) => {
                stmts.push(env.DB.prepare("INSERT INTO ShortsCache (video_id, type, data, region, rank) VALUES (?, ?, ?, ?, ?)").bind(item.id, 'viral', JSON.stringify(item), region, idx));
            });

            if (stmts.length > 0) await env.DB.batch(stmts);

        } catch (e) {
            console.error("Trends Sync Failed", e);
        }
    }
};

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css" />
    <title>Tube Trend Pro</title>
    <style>
        body { font-family: 'Pretendard Variable', sans-serif; background-color: #f8fafc; color: #0f172a; }
        .tab-active { background: #dc2626 !important; color: white !important; box-shadow: 0 10px 15px -3px rgba(220, 38, 38, 0.3); }
        .tab-active-blue { background: #2563eb !important; color: white !important; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.3); }
        .modal-animate { animation: slideUp 0.3s ease-out; }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    </style>
</head>
<body class="pb-10">
    <nav class="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b shadow-sm px-6 py-4">
        <div class="max-w-6xl mx-auto flex justify-between items-center">
            <h1 class="text-2xl font-black tracking-tighter uppercase italic">TUBE <span class="text-red-600">TREND PRO</span></h1>
            <div class="flex items-center gap-2">
                <select id="regionSelect" onchange="loadData()" class="bg-slate-100 border-none rounded-2xl px-3 py-2 text-xs font-bold outline-none cursor-pointer">
                    <option value="KR" selected>🇰🇷 Korea</option><option value="US">🇺🇸 USA</option><option value="JP">🇯🇵 Japan</option>
                    <option value="IN">🇮🇳 India</option><option value="BR">🇧🇷 Brazil</option><option value="DE">🇩🇪 Germany</option><option value="FR">🇫🇷 France</option>
                </select>
                <button onclick="batchCollect()" id="batchBtn" class="bg-indigo-600 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg active:scale-95">TOP 300 수집</button>
                <div class="flex gap-1">
                    <button onclick="downloadCSV()" class="bg-emerald-600 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg">CSV (CH)</button>
                    <button onclick="downloadLiveCSV()" class="bg-emerald-800 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg">CSV (LIVE)</button>
                </div>
                <button onclick="syncLive()" id="liveSyncBtn" class="bg-red-600 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg active:scale-95">LIVE SYNC</button>
                <button onclick="updateSystem()" id="syncBtn" class="bg-slate-900 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg">CH SYNC</button>
                <button onclick="openAddModal()" class="bg-violet-600 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg active:scale-95">ADD CHANNEL</button>
                <button onclick="resetDB()" class="bg-red-800 text-white px-4 py-2.5 rounded-2xl text-[10px] font-black shadow-lg">DB RESET</button>
            </div>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto px-4 mt-10">
        <div id="syncStatus" class="hidden mb-6 p-4 bg-indigo-50 text-indigo-600 rounded-[2rem] border border-indigo-100 text-sm font-black text-center animate-pulse">
            백그라운드 작업을 시작했습니다. 잠시 후 새로고침 하세요.
        </div>

        <div class="flex gap-2 mb-8 bg-slate-100 p-1.5 rounded-[2rem] w-fit border border-slate-200 mx-auto shadow-inner">
            <button onclick="switchTab('ranking')" id="btn-tab-rank" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all tab-active">CHANNEL RANK</button>
            <button onclick="switchTab('trending')" id="btn-tab-trend" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600">TRENDING</button>
            <button onclick="switchTab('shorts')" id="btn-tab-shorts" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600">SHORTS</button>
            <button onclick="switchTab('viral')" id="btn-tab-viral" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600">HOT SHORTS</button>
            <button onclick="switchTab('live')" id="btn-tab-live" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600">LIVE NOW</button>
        </div>

        <div class="flex flex-wrap gap-2 mb-8 justify-center" id="cat-list">
            <button onclick="changeCategory('all')" id="cat-all" class="px-5 py-2.5 rounded-2xl text-[11px] font-black bg-slate-900 text-white shadow-md">ALL TOPICS</button>
        </div>



        <div id="section-ranking" class="block">
            <div class="flex flex-col md:flex-row justify-between gap-4 mb-8">
                <input type="text" id="searchInput" oninput="debounceSearch()" placeholder="Search creators..." class="w-full md:w-96 p-4 rounded-[1.5rem] border-2 border-slate-100 bg-white font-bold shadow-sm">
                <div class="flex bg-slate-100 p-1 rounded-[1.5rem] border border-slate-200">
                    <button onclick="changeSort('subs')" id="tab-subs" class="px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active">SUBSCRIBERS</button>
                    <button onclick="changeSort('views')" id="tab-views" class="px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400">VIEWS</button>
                </div>
            </div>
            <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl overflow-hidden">
                <div class="overflow-x-auto">
                    <table class="w-full text-left min-w-[850px]">
                        <thead class="bg-slate-50 border-b text-slate-400 font-black text-[10px] uppercase tracking-widest">
                            <tr><th class="p-6 text-center w-24">Rank</th><th class="p-6">Channel</th><th class="p-6 text-right">Subs</th><th class="p-6 text-right">Total Views</th><th class="p-6 text-right">24h Growth</th></tr>
                        </thead>
                        <tbody id="table-body" class="divide-y divide-slate-50"></tbody>
                    </table>
                </div>
            </div>
            <div id="load-more-container" class="mt-10 flex justify-center hidden"><button onclick="loadMoreRanking()" class="px-10 py-4 bg-white border-2 border-slate-100 text-slate-900 rounded-[2rem] font-black text-sm hover:border-red-600 hover:text-red-600 shadow-xl transition-all">더보기 (VIEW MORE)</button></div>
        </div>

        <div id="section-trending" class="hidden"><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6" id="trend-grid"></div></div>
        <div id="section-live" class="hidden"><div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6" id="live-grid"></div></div>
    </main>

    <div id="modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
        <div class="bg-white w-full max-w-2xl rounded-[3rem] p-0 relative shadow-2xl overflow-hidden modal-animate">
            <div class="bg-slate-50 px-8 pt-12 pb-8 border-b border-slate-100 relative">
                <button onclick="closeModal()" class="absolute top-6 right-8 text-3xl font-light text-slate-400 hover:text-red-600 transition-colors">&times;</button>
                <div class="flex items-center gap-6">
                    <img id="mThumb" class="w-24 h-24 rounded-[2.5rem] shadow-2xl border-4 border-white object-cover">
                    <div class="flex-1"><h3 id="mTitle" class="text-2xl font-black text-slate-900 leading-tight mb-3">Channel</h3><a id="mChannelLink" target="_blank" class="bg-red-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase shadow-lg active:scale-95">Visit Channel</a></div>
                </div>
            </div>
            <div class="p-8">
                <div class="grid grid-cols-3 gap-3 mb-8">
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center"><p class="text-[9px] font-black text-slate-400 uppercase mb-1">Subs</p><p id="mSubs" class="text-lg font-black text-slate-900">0</p></div>
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center"><p class="text-[9px] font-black text-slate-400 uppercase mb-1">Views</p><p id="mViews" class="text-lg font-black text-slate-900">0</p></div>
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center"><p class="text-[9px] font-black text-slate-400 uppercase mb-1">Growth</p><p id="mGrowth" class="text-lg font-black text-emerald-600">+0</p></div>
                </div>
                <div class="flex gap-2 mb-6 bg-slate-100 p-1 rounded-2xl w-fit mx-auto border shadow-inner">
                    <button onclick="toggleChartType('subs')" id="btn-chart-subs" class="px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active">SUBSCRIBERS</button>
                    <button onclick="toggleChartType('views')" id="btn-chart-views" class="px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400">TOTAL VIEWS</button>
                </div>
                <div class="rounded-3xl border border-slate-100 p-5"><div class="h-60 w-full"><canvas id="hChart"></canvas></div></div>
            </div>
        </div>
        </div>
    </div>

    <div id="addModal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
        <div class="bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl modal-animate relative">
            <button onclick="document.getElementById('addModal').classList.add('hidden')" class="absolute top-6 right-8 text-2xl text-slate-400 hover:text-red-600">&times;</button>
            <h3 class="text-xl font-black text-slate-900 mb-6">📺 ADD NEW CHANNEL</h3>
            <div class="space-y-4">
                <div>
                    <label class="block text-xs font-bold text-slate-500 mb-1">CHANNEL ID / HANDLE</label>
                    <input type="text" id="newChannelInput" placeholder="@handle or UC..." class="w-full p-4 rounded-2xl bg-slate-50 border border-slate-200 font-bold text-sm">
                </div>
                <button onclick="addNewChannel()" class="w-full py-4 bg-slate-900 text-white rounded-2xl font-black hover:bg-violet-600 transition-all shadow-lg mt-2">REGISTER CHANNEL</button>
            </div>
        </div>
    </div>

    <div id="overrideModal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
        <div class="bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl modal-animate relative">
            <button onclick="document.getElementById('overrideModal').classList.add('hidden')" class="absolute top-6 right-8 text-2xl text-slate-400 hover:text-red-600">&times;</button>
            <h3 class="text-xl font-black text-slate-900 mb-6">🌏 FORCE COUNTRY OVERRIDE</h3>
            <div class="space-y-4">
                <div>
                    <label class="block text-xs font-bold text-slate-500 mb-1">CHANNEL ID / HANDLE</label>
                    <input type="text" id="ovInputId" placeholder="@handle or UC..." class="w-full p-4 rounded-2xl bg-slate-50 border border-slate-200 font-bold text-sm">
                </div>
                <div>
                     <label class="block text-xs font-bold text-slate-500 mb-1">NEW COUNTRY</label>
                     <select id="ovSelectRegion" class="w-full p-4 rounded-2xl bg-slate-50 border border-slate-200 font-bold text-sm">
                        <option value="KR">🇰🇷 Korea</option><option value="US">🇺🇸 USA</option><option value="JP">🇯🇵 Japan</option>
                        <option value="IN">🇮🇳 India</option><option value="BR">🇧🇷 Brazil</option><option value="DE">🇩🇪 Germany</option><option value="FR">🇫🇷 France</option>
                     </select>
                </div>
                <button onclick="submitOverride()" class="w-full py-4 bg-slate-900 text-white rounded-2xl font-black hover:bg-red-600 transition-all shadow-lg mt-2">CONFIRM UPDATE</button>
            </div>
        </div>
    </div>
    <script>
        let currentTab = 'ranking', currentSort = 'subs', currentCategory = 'all', currentRankData = [], chart = null, historyData = [], currentChartType = 'subs', searchTimer, visibleCount = 100;
        const categoryMap = {"1":"Film & Animation","2":"Autos & Vehicles","10":"Music","15":"Pets & Animals","17":"Sports","19":"Travel & Events","20":"Gaming","22":"People & Blogs","23":"Comedy","24":"Entertainment","25":"News & Politics","26":"Howto & Style","27":"Education","28":"Science & Tech","29":"Nonprofits"};

        function formatNum(n) { if (!n) return "0"; let val = parseInt(n); if (val >= 1e9) return (val / 1e9).toFixed(1) + 'B'; if (val >= 1e6) return (val / 1e6).toFixed(1) + 'M'; if (val >= 1e3) return (val / 1e3).toFixed(1) + 'K'; return val.toLocaleString(); }

        async function switchTab(t) {
            currentTab = t;
            ['btn-tab-rank', 'btn-tab-live', 'btn-tab-trend', 'btn-tab-viral', 'btn-tab-shorts'].forEach(id => {
               const btn = document.getElementById(id);
               if(btn) btn.className = 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600';
            });
            
            const activeId = t === 'ranking' ? 'btn-tab-rank' : (t === 'live' ? 'btn-tab-live' : (t === 'viral' ? 'btn-tab-viral' : (t === 'shorts' ? 'btn-tab-shorts' : 'btn-tab-trend')));
            if(document.getElementById(activeId)) {
                if(t === 'viral') document.getElementById(activeId).className = 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all bg-purple-600 text-white shadow-lg';
                else if(t === 'shorts') document.getElementById(activeId).className = 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all bg-red-600 text-white shadow-lg';
                else document.getElementById(activeId).className = 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all tab-active';
            }
            
            ['section-ranking', 'section-live', 'section-trending'].forEach(id => document.getElementById(id).style.display = 'none');
            
            if (t === 'viral' || t === 'shorts') {
                document.getElementById('section-trending').style.display = 'block'; // Reuse trending grid
            } else {
                document.getElementById('section-' + t).style.display = 'block';
            }
            
            document.getElementById('cat-list').style.display = (t === 'live' || t === 'ranking' || t === 'viral') ? 'none' : 'flex';
            loadData();
        }

        async function loadData() {
            const region = document.getElementById('regionSelect').value;
            const search = document.getElementById('searchInput').value;
            
            if (currentTab === 'ranking') {
                const res = await fetch(\`/api/ranking?region=\${region}&sort=\${currentSort}&category=\${currentCategory}&search=\${encodeURIComponent(search)}\`);
                const data = await res.json();
                currentRankData = data; visibleCount = 100; renderRanking();
            } else if (currentTab === 'live') {
                const res = await fetch(\`/api/live-ranking?region=\${region}\`);
                const data = await res.json();
                renderLive(data);
            } else if (currentTab === 'viral') {
                document.getElementById('trend-grid').innerHTML = '<div class="col-span-full text-center py-20"><div class="animate-spin rounded-full h-12 w-12 border-b-4 border-purple-600 mx-auto"></div></div>';
                const res = await fetch(\`/api/shorts-viral?region=\${region}\`);
                const data = await res.json();
                renderViral(data);
            } else if (currentTab === 'shorts') {
                document.getElementById('trend-grid').innerHTML = '<div class="col-span-full text-center py-20"><div class="animate-spin rounded-full h-12 w-12 border-b-4 border-red-600 mx-auto"></div></div>';
                const res = await fetch(\`/api/shorts-trending?region=\${region}\`);
                const data = await res.json();
                renderTrending(data);
            } else {
                let endpoint = \`/api/trending?region=\${region}&category=\${currentCategory}\`;
                const res = await fetch(endpoint);
                const data = await res.json();
                renderTrending(data);
            }
        }

        function renderViral(items) {
            const grid = document.getElementById('trend-grid');
            if(!items || items.length === 0) { grid.innerHTML = '<div class="col-span-full text-center py-10 text-slate-400 font-bold">No High-Viral Shorts Found</div>'; return; }
            grid.innerHTML = items.map((item, i) => \`
                <div class="group relative bg-white rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 hover:-translate-y-1 ring-1 ring-slate-100">
                    <div class="relative aspect-[9/16]">
                        <img src="\${item.thumbnail}" class="w-full h-full object-cover" loading="lazy">
                        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60"></div>
                        <div class="absolute top-2 left-2 bg-purple-600 text-white text-xs font-black px-2 py-1 rounded shadow-lg z-10">Vf \${item.vf}x</div>
                        <div class="absolute bottom-3 left-3 right-3 text-white">
                            <div class="text-2xl font-black italic mb-1">#\${i+1}</div>
                            <h3 class="font-bold text-sm leading-tight line-clamp-2 mb-1 drop-shadow-md">\${item.title}</h3>
                            <div class="text-[10px] opacity-90 font-medium">\${item.channel}</div>
                        </div>
                    </div>
                    <div class="p-3 bg-slate-50 flex justify-between items-center text-xs font-bold text-slate-600 border-t border-slate-100">
                        <span class="flex items-center gap-1"><span class="text-red-500">▶</span> \${formatNum(item.views)}</span>
                        <span class="text-slate-400">Subs: \${formatNum(item.subs)}</span>
                    </div>
                </div>
            \`).join('');
        }

        function renderRanking() {
            const dataToShow = currentRankData.slice(0, visibleCount);
            document.getElementById('table-body').innerHTML = dataToShow.map(item => \`
                <tr onclick="openModal('\${item.id}', '\${item.title.replace(/'/g, "")}', '\${item.thumbnail}', \${item.current_subs}, \${item.current_views}, \${item.growth})" class="group hover:bg-slate-50 transition-all cursor-pointer border-b">
                    <td class="p-6 text-center text-xl font-black text-slate-200 group-hover:text-red-600">\${item.absolute_rank}</td>
                    <td class="p-6 flex items-center gap-5">
                        <img src="\${item.thumbnail}" class="w-12 h-12 rounded-2xl shadow-sm object-cover"><div class="font-black text-slate-900 group-hover:text-red-600">\${item.title}</div>
                    </td>
                    <td class="p-6 text-right font-mono font-black text-slate-900">\${item.current_subs.toLocaleString()}</td>
                    <td class="p-6 text-right font-mono font-bold text-slate-400">\${item.current_views.toLocaleString()}</td>
                    <td class="p-6 text-right text-emerald-600 font-black text-lg">\${item.growth > 0 ? '+' : ''}\${item.growth.toLocaleString()}</td>
                </tr>\`).join('');
            document.getElementById('load-more-container').classList.toggle('hidden', currentRankData.length <= visibleCount);
        }

        function loadMoreRanking() { visibleCount += 100; renderRanking(); }
        function renderLive(data) { document.getElementById('live-grid').innerHTML = data.map(d => \`<div class="bg-white rounded-[2rem] p-3 shadow-sm border border-slate-100 hover:shadow-2xl transition-all cursor-pointer group" onclick="window.open('https://youtube.com/watch?v=\${d.video_id}')"><div class="relative mb-4 overflow-hidden rounded-[1.5rem] h-32"><img src="\${d.thumbnail}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"><div class="absolute top-3 left-3 bg-red-600 text-white px-2 py-1 rounded-lg text-[8px] font-black">LIVE</div></div><div class="mb-2"><span class="text-[10px] font-black text-red-600 bg-red-50 px-2 py-1 rounded-lg">\${d.viewers.toLocaleString()}명</span></div><h4 class="font-black text-slate-900 line-clamp-1 text-xs">\${d.video_title}</h4><p class="text-[9px] font-bold text-slate-400 truncate">\${d.channel_name}</p></div>\`).join(''); }
        function renderTrending(data) { document.getElementById('trend-grid').innerHTML = data.map(v => \`<div class="bg-white rounded-[2rem] p-3 shadow-sm border border-slate-100 hover:shadow-2xl transition-all cursor-pointer group" onclick="window.open('https://youtube.com/watch?v=\${v.id}')"><div class="relative mb-3 overflow-hidden rounded-[1.5rem] h-40"><img src="\${v.thumbnail}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"></div><div class="px-1"><h4 class="font-black text-slate-900 line-clamp-2 text-[13px] mb-1 group-hover:text-red-600">\${v.title}</h4><p class="text-[10px] font-bold text-slate-400 truncate mb-2">\${v.channel}</p><div class="flex justify-between items-center text-[10px] font-black text-slate-500 bg-slate-50 p-2 rounded-xl"><span>👁 \${formatNum(v.views)}</span><span>📅 \${v.date}</span></div></div></div>\`).join(''); }
        function downloadCSV() { if (!currentRankData.length) return alert("데이터 없음"); let csv = "\uFEFFRank,Channel ID,Channel Name,Country,Subscribers,Total Views,24h Growth\\n"; currentRankData.forEach(item => { csv += \`\${item.absolute_rank},\${item.id},"\${item.title.replace(/"/g, '""')}",\${item.country},\${item.current_subs},\${item.current_views},\${item.growth}\\n\`; }); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); link.download = \`TubeTrend_Ranking_\${new Date().toISOString().slice(0,10)}.csv\`; link.click(); }
        async function downloadLiveCSV() { 
            const res = await fetch('/api/all-live-streamers'); 
            const data = await res.json(); 
            if (!data.length) return alert("라이브 후보 데이터 없음"); 
            let csv = "\uFEFFChannel ID,Channel Name,Last Live Date\\n"; 
            data.forEach(item => { csv += \`\${item.channel_id},"\${item.title ? item.title.replace(/"/g, '""') : ''}",\${item.last_live_date || ''}\\n\`; }); 
            const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); link.download = \`TubeTrend_LiveCandidates_\${new Date().toISOString().slice(0,10)}.csv\`; link.click(); 
        }
        async function openModal(id, title, thumb, subs, views, growth) { document.getElementById('modal').classList.remove('hidden'); document.getElementById('mTitle').innerText = title; document.getElementById('mThumb').src = thumb; document.getElementById('mSubs').innerText = formatNum(subs); document.getElementById('mViews').innerText = formatNum(views); document.getElementById('mGrowth').innerText = "+" + formatNum(growth); document.getElementById('mChannelLink').href = 'https://www.youtube.com/channel/' + id; currentChartType = 'subs'; updateChartButtons(); if (chart) chart.destroy(); const res = await fetch('/api/channel-history?id=' + id); historyData = await res.json(); setTimeout(renderChart, 200); }
        function toggleChartType(type) { currentChartType = type; updateChartButtons(); renderChart(); }
        function updateChartButtons() { const isSubs = currentChartType === 'subs'; document.getElementById('btn-chart-subs').className = isSubs ? "px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active" : "px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400"; document.getElementById('btn-chart-views').className = !isSubs ? "px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active-blue" : "px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400"; }
        function renderChart() { const ctx = document.getElementById('hChart').getContext('2d'); if (chart) chart.destroy(); const isSubs = currentChartType === 'subs'; const color = isSubs ? '#dc2626' : '#2563eb'; chart = new Chart(ctx, { type: 'line', data: { labels: historyData.map(d => d.rank_date.slice(5)), datasets: [{ data: historyData.map(d => isSubs ? d.subs : d.views), borderColor: color, backgroundColor: isSubs ? 'rgba(220, 38, 38, 0.1)' : 'rgba(37, 99, 235, 0.1)', borderWidth: 4, tension: 0.4, fill: true, pointRadius: 4, pointBackgroundColor: color }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { border: { display: false }, grid: { color: '#f1f5f9' }, ticks: { callback: v => formatNum(v), font: { size: 9, weight: 'bold' } } }, x: { border: { display: false }, grid: { display: false }, ticks: { font: { size: 9, weight: 'bold' } } } } } }); }
        async function updateSystem() { const btn = document.getElementById('syncBtn'); btn.disabled = true; document.getElementById('syncStatus').innerText = "채널 정보를 갱신 중입니다... (약 20초 소요)"; document.getElementById('syncStatus').classList.remove('hidden'); await fetch('/mass-discover?region=' + document.getElementById('regionSelect').value); setTimeout(() => { btn.disabled = false; document.getElementById('syncStatus').classList.add('hidden'); loadData(); }, 3000); }
        async function syncLive() { const btn = document.getElementById('liveSyncBtn'); btn.disabled = true; document.getElementById('syncStatus').innerText = "라이브 방송을 검색 중입니다... (약 5초 소요)"; document.getElementById('syncStatus').classList.remove('hidden'); await fetch('/api/sync-live?region=' + document.getElementById('regionSelect').value); setTimeout(() => { btn.disabled = false; document.getElementById('syncStatus').classList.add('hidden'); loadData(); switchTab('live'); }, 2000); }
        async function batchCollect() { const btn = document.getElementById('batchBtn'); btn.disabled = true; document.getElementById('syncStatus').classList.remove('hidden'); await fetch('/api/batch-collect?region=' + document.getElementById('regionSelect').value); setTimeout(() => { btn.disabled = false; document.getElementById('syncStatus').classList.add('hidden'); loadData(); }, 3000); }
        async function addNewChannel() { const idInput = document.getElementById('newChannelInput'); const id = idInput.value.trim(); if (!id) return alert("ID 입력 필요"); const res = await fetch(\`/api/add-channel?id=\${encodeURIComponent(id)}&region=\${document.getElementById('regionSelect').value}\`); const data = await res.json(); if (data.success) { alert(\`[\${data.title}] 등록 완료!\`); idInput.value = ""; document.getElementById('addModal').classList.add('hidden'); loadData(); } else alert("실패: " + (data.error || "형식 확인")); }
        function closeModal() { document.getElementById('modal').classList.add('hidden'); if(chart) chart.destroy(); }
        function openAddModal() { document.getElementById('addModal').classList.remove('hidden'); }
        function openOverrideModal() { document.getElementById('overrideModal').classList.remove('hidden'); }
        async function submitOverride() {
            const id = document.getElementById('ovInputId').value.trim();
            const country = document.getElementById('ovSelectRegion').value;
            if (!id) return alert("Please enter ID");
            const res = await fetch("/api/force-country?id=" + encodeURIComponent(id) + "&country=" + country);
            const data = await res.json();
            if (data.success) { alert("Success! Country updated."); document.getElementById('overrideModal').classList.add('hidden'); document.getElementById('ovInputId').value = ""; loadData(); }
            else { alert("Error: " + data.error); }
        }
        async function resetDB() {
            if(!confirm("⚠️ WARNING: This will delete ALL data (including manually added channels) and restore the default list.\\n\\nAre you sure?")) return;
            const res = await fetch("/api/reset-db");
            const data = await res.json();
            if(data.success) {
                alert("✅ DB Reset Complete!\\n\\nPlease click [CH SYNC] to fetch latest stats.");
                location.reload();
            } else {
                alert("Error: " + data.error);
            }
        }
        function changeSort(s) { currentSort = s; document.getElementById('tab-subs').className = s === 'subs' ? 'px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active' : 'px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400'; document.getElementById('tab-views').className = s === 'views' ? 'px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active' : 'px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400'; loadData(); }
        function changeCategory(c) { currentCategory = c; document.querySelectorAll('#cat-list button').forEach(b => b.className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-white text-slate-400 border border-slate-100 hover:bg-slate-50"); const activeId = c === 'all' ? 'cat-all' : 'cat-' + c; if(document.getElementById(activeId)) document.getElementById(activeId).className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-slate-900 text-white shadow-md"; loadData(); }
        function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadData, 300); }
        const list = document.getElementById('cat-list'); Object.keys(categoryMap).forEach(id => { const b = document.createElement('button'); b.id = 'cat-' + id; b.innerText = categoryMap[id].toUpperCase(); b.className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-white text-slate-400 border border-slate-100 hover:bg-slate-50"; b.onclick = () => changeCategory(id); list.appendChild(b); });
        loadData();
    </script>
</body>
</html>
`;