export default {
    getApiKey(env) {
        if (!env.YOUTUBE_API_KEYS) return null;
        const keys = env.YOUTUBE_API_KEYS.split(',');
        return keys[Math.floor(Math.random() * keys.length)].trim();
    },

    getKSTDate(offsetDays = 0) {
        const now = new Date();
        const targetDate = new Date(now.getTime() + (9 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000));
        return targetDate.toISOString().split('T')[0];
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        const region = url.searchParams.get("region") || "KR";

        if (url.pathname === "/api/live-ranking") {
            const { results } = await env.DB.prepare(`
                SELECT channel_name, video_title, viewers, thumbnail, video_id 
                FROM LiveRankings WHERE region = ? ORDER BY viewers DESC LIMIT 50
            `).bind(region).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // [수정됨] 중복 방지 로직이 강화된 채널 랭킹 API
        if (url.pathname === "/api/ranking") {
            const sort = url.searchParams.get("sort") || "growth";
            const category = url.searchParams.get("category") || "all";
            const searchStr = url.searchParams.get("search") || "";
            let conditions = [];
            let bindings = [];
            if (region !== "ALL") { conditions.push("c.country = ?"); bindings.push(region); }
            if (category !== "all") { conditions.push("c.category = ?"); bindings.push(category); }
            if (searchStr.trim() !== "") { conditions.push("c.title LIKE ?"); bindings.push(`%${searchStr}%`); }

            const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
            const orderBy = sort === "views" ? "current_views DESC" : "growth DESC, current_subs DESC";

            const query = `
                SELECT 
                    c.id, c.title, c.category, c.country, c.thumbnail, 
                    MAX(t.subs) AS current_subs, 
                    MAX(t.views) AS current_views,
                    CASE WHEN y.subs IS NULL THEN NULL ELSE (MAX(t.subs) - MAX(y.subs)) END AS growth,
                    CASE WHEN y.views IS NULL THEN NULL ELSE (MAX(t.views) - MAX(y.views)) END AS views_growth
                FROM Channels c
                JOIN ChannelStats t ON c.id = t.channel_id 
                     AND t.rank_date = (SELECT MAX(rank_date) FROM ChannelStats WHERE channel_id = c.id)
                LEFT JOIN ChannelStats y ON c.id = y.channel_id 
                     AND y.rank_date = DATE((SELECT MAX(rank_date) FROM ChannelStats WHERE channel_id = c.id), '-1 day')
                ${whereClause}
                GROUP BY c.id  -- 핵심: 채널 ID로 그룹화하여 중복 제거
                ORDER BY ${orderBy} LIMIT 100
            `;
            const { results } = await env.DB.prepare(query).bind(...bindings).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        if (url.pathname === "/api/channel-history") {
            const channelId = url.searchParams.get("id");
            const { results } = await env.DB.prepare(`SELECT rank_date, subs, views FROM ChannelStats WHERE channel_id = ? GROUP BY rank_date ORDER BY rank_date ASC LIMIT 7`).bind(channelId).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        if (url.pathname === "/sync-live") {
            try { await this.syncLiveStreams(env, region); return new Response(JSON.stringify({ success: true })); }
            catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 }); }
        }

        if (url.pathname === "/mass-discover") {
            try {
                await this.performMassDiscover(env, region);
                await this.handleDailySync(env);
                await this.syncLiveStreams(env, region);
                return new Response(JSON.stringify({ success: true }));
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500 });
            }
        }

        return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },

    async syncLiveStreams(env, region) {
        const API_KEY = this.getApiKey(env);
        let query = "live"; let lang = "en";
        if (region === 'KR') { query = "라이브"; lang = "ko"; }
        else if (region === 'JP') { query = "ライブ"; lang = "ja"; }
        else if (region === 'BR') { query = "ao vivo"; lang = "pt"; }
        else if (region === 'IN') { query = "live"; lang = "hi"; }

        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&regionCode=${region}&q=${encodeURIComponent(query)}&relevanceLanguage=${lang}&order=viewCount&maxResults=25&key=${API_KEY}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (searchData.items && searchData.items.length > 0) {
            const videoIds = searchData.items.map(i => i.id.videoId).join(',');
            const videoRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${videoIds}&key=${API_KEY}`);
            const videoData = await videoRes.json();
            await env.DB.prepare("DELETE FROM LiveRankings WHERE region = ?").bind(region).run();
            const stmts = videoData.items.map(item => env.DB.prepare(`INSERT INTO LiveRankings (channel_name, video_title, viewers, thumbnail, video_id, region) VALUES (?, ?, ?, ?, ?, ?)`).bind(item.snippet.channelTitle, item.snippet.title, parseInt(item.liveStreamingDetails?.concurrentViewers || 0), item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url, item.id, region));
            await env.DB.batch(stmts);
        }
    },

    async performMassDiscover(env, region) {
        const API_KEY = this.getApiKey(env);
        const categories = ["", "1", "10", "17", "20", "23", "24", "25", "28"];
        for (const catId of categories) {
            const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=${region}${catId ? `&videoCategoryId=${catId}` : ""}&maxResults=50&key=${API_KEY}`);
            const data = await res.json();
            if (data.items) {
                const stmts = data.items.map(item => env.DB.prepare(`INSERT INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET country = excluded.country`).bind(item.snippet.channelId, item.snippet.channelTitle, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url));
                await env.DB.batch(stmts);
            }
        }
    },

    async handleDailySync(env) {
        const { results } = await env.DB.prepare("SELECT id FROM Channels").all();
        const chunks = [];
        for (let i = 0; i < results.length; i += 50) chunks.push(results.slice(i, i + 50));
        const today = this.getKSTDate();
        for (const chunk of chunks) {
            const ids = chunk.map(c => c.id).join(',');
            const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${ids}&key=${this.getApiKey(env)}`);
            const data = await res.json();
            if (data.items) {
                const stmts = data.items.flatMap(item => [
                    env.DB.prepare(`UPDATE Channels SET thumbnail = ? WHERE id = ?`).bind(item.snippet.thumbnails.default.url, item.id),
                    env.DB.prepare(`INSERT OR REPLACE INTO ChannelStats (channel_id, subs, views, rank_date) VALUES (?, ?, ?, ?)`).bind(item.id, parseInt(item.statistics.subscriberCount || 0), parseInt(item.statistics.viewCount || 0), today)
                ]);
                await env.DB.batch(stmts);
            }
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
        .tab-active { background: #dc2626 !important; color: white !important; border-color: #dc2626 !important; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .live-dot { animation: pulse 1.5s infinite; }
        @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
    </style>
</head>
<body>
    <nav class="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b shadow-sm px-4 py-4">
        <div class="max-w-6xl mx-auto flex justify-between items-center">
            <h1 class="text-2xl font-black tracking-tighter">Tube <span class="text-red-600">Trend Pro</span></h1>
            <div class="flex items-center gap-2">
                <select id="regionSelect" onchange="loadData()" class="bg-slate-50 border rounded-xl px-3 py-2 text-xs font-black outline-none focus:border-red-600 cursor-pointer">
                    <option value="KR" selected>🇰🇷 Korea</option>
                    <option value="US">🇺🇸 USA</option>
                    <option value="JP">🇯🇵 Japan</option>
                    <option value="GB">🇬🇧 UK</option>
                    <option value="BR">🇧🇷 Brazil</option>
                    <option value="IN">🇮🇳 India</option>
                </select>
                <button onclick="downloadCSV()" class="bg-emerald-600 text-white px-4 py-2 rounded-xl text-xs font-black">CSV</button>
                <button onclick="updateSystem()" id="syncBtn" class="bg-slate-950 text-white px-4 py-2 rounded-xl text-xs font-black">Sync Data</button>
            </div>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto px-4 py-10">
        <div class="flex gap-2 mb-8 bg-slate-100 p-1.5 rounded-2xl w-fit border shadow-sm">
            <button onclick="switchTab('ranking')" id="btn-tab-rank" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active">Channel Ranking</button>
            <button onclick="switchTab('live')" id="btn-tab-live" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all text-slate-500">Live Streaming</button>
        </div>

        <div id="section-ranking" class="block">
            <div class="flex flex-col md:flex-row justify-between gap-6 mb-4">
                <input type="text" id="searchInput" oninput="debounceSearch()" placeholder="Search channels..." class="w-full md:w-80 p-3.5 rounded-2xl border bg-white font-bold outline-none focus:border-red-600 transition-all">
                <div class="bg-slate-100 p-1 rounded-2xl flex gap-1 border">
                    <button onclick="changeSort('growth')" id="tab-growth" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active">Growth</button>
                    <button onclick="changeSort('views')" id="tab-views" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500">Views</button>
                </div>
            </div>
            <div class="category-container no-scrollbar flex gap-2 overflow-x-auto mb-6" id="cat-list">
                <button onclick="changeCategory('all')" id="cat-all" class="px-6 py-2.5 rounded-xl text-xs font-black bg-slate-950 text-white flex-shrink-0">ALL TOPICS</button>
            </div>
            <div class="bg-white rounded-[2.5rem] border shadow-xl overflow-x-auto">
                <table class="w-full text-left min-w-[850px]">
                    <thead class="bg-slate-50 border-b">
                        <tr><th class="p-6 text-center w-20">Rank</th><th class="p-6">Channel Info</th><th class="p-6 text-right">Subscribers</th><th class="p-6 text-right">Total Views</th><th class="p-6 text-right">24h Growth</th></tr>
                    </thead>
                    <tbody id="table-body"></tbody>
                </table>
            </div>
        </div>

        <div id="section-live" class="hidden">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8" id="live-grid"></div>
        </div>
    </main>

    <div id="modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
        <div class="bg-white w-full max-w-2xl rounded-[3rem] p-8 md:p-12 relative shadow-2xl overflow-y-auto max-h-[90vh]">
            <button onclick="closeModal()" class="absolute top-8 right-10 text-4xl font-light text-slate-300 hover:text-red-600 transition-colors">&times;</button>
            <div class="flex items-center gap-6 mb-10">
                <img id="mThumb" class="w-24 h-24 rounded-[2rem] shadow-xl border-4 border-slate-50 object-cover">
                <div class="flex-1">
                    <div class="flex items-center gap-3 mb-2 flex-wrap">
                        <h3 id="mTitle" class="text-2xl font-black text-slate-900 tracking-tight">Channel</h3>
                        <a id="mChannelLink" target="_blank" class="bg-red-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase shadow-lg flex items-center gap-1 hover:bg-red-700 transition-all active:scale-95">Visit Channel</a>
                    </div>
                    <span id="mCountry" class="inline-block bg-slate-100 px-3 py-1 rounded-lg text-[10px] font-black text-slate-400 uppercase tracking-widest">Country</span>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-4 mb-8">
                <div class="bg-slate-50/50 p-6 rounded-[2.5rem] border-2 border-slate-100 text-center">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-2">Current Subs</p>
                    <p id="mSubsCount" class="text-2xl font-black text-slate-950">0</p>
                </div>
                <div class="bg-slate-50/50 p-6 rounded-[2.5rem] border-2 border-slate-100 text-center">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-2">Total Views</p>
                    <p id="mViewsCount" class="text-2xl font-black text-slate-950">0</p>
                </div>
            </div>
            <div class="flex gap-2 mb-6 bg-slate-100 p-1.5 rounded-2xl">
                <button onclick="toggleChartType('subs')" id="btn-chart-subs" class="flex-1 py-3 rounded-xl text-xs font-black transition-all tab-active">Subscribers</button>
                <button onclick="toggleChartType('views')" id="btn-chart-views" class="flex-1 py-3 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500">Total Views</button>
            </div>
            <div class="h-64 w-full relative"><canvas id="hChart"></canvas></div>
        </div>
    </div>

    <script>
        let currentTab = 'ranking', currentSort = 'growth', currentCategory = 'all', currentRankData = [], chart, historyData = [], currentChartType = 'subs', searchTimer;
        const categoryMap = {"1":"Film","2":"Autos","10":"Music","15":"Pets","17":"Sports","19":"Travel","20":"Gaming","22":"Blogs","23":"Comedy","24":"Entertain","25":"News","26":"Howto","27":"Edu","28":"Tech","29":"Nonprofit"};

        function formatNum(n) {
            if (n === null || n === undefined) return "New";
            if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n.toLocaleString();
        }

        async function switchTab(t) {
            currentTab = t;
            document.getElementById('btn-tab-rank').className = t === 'ranking' ? 'px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active' : 'px-6 py-2.5 rounded-xl text-xs font-black transition-all text-slate-500';
            document.getElementById('btn-tab-live').className = t === 'live' ? 'px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active' : 'px-6 py-2.5 rounded-xl text-xs font-black transition-all text-slate-500';
            document.getElementById('section-ranking').style.display = t === 'ranking' ? 'block' : 'none';
            document.getElementById('section-live').style.display = t === 'live' ? 'block' : 'none';
            loadData();
        }

        async function loadData() {
            if (currentTab === 'ranking') loadRanking();
            else loadLiveRanking();
        }

        async function loadRanking() {
            const region = document.getElementById('regionSelect').value;
            const search = document.getElementById('searchInput').value;
            const res = await fetch(\`/api/ranking?region=\${region}&sort=\${currentSort}&category=\${currentCategory}&search=\${encodeURIComponent(search)}\`);
            currentRankData = await res.json();
            const tbody = document.getElementById('table-body');
            tbody.innerHTML = currentRankData.map((item, idx) => {
                const displayGrowth = currentSort === 'views' ? item.views_growth : item.growth;
                const growthText = displayGrowth === null ? "New" : "+" + formatNum(displayGrowth);
                return \`
                <tr onclick="openModal('\${item.id}', '\${item.title.replace(/'/g, "")}', '\${item.thumbnail}', \${item.current_subs}, \${item.current_views}, '\${item.country}')" class="group hover:bg-slate-50 transition-all cursor-pointer border-b">
                    <td class="p-6 text-center text-2xl font-black text-slate-200 group-hover:text-red-600 transition-colors">\${idx + 1}</td>
                    <td class="p-6 flex items-center gap-5">
                        <img src="\${item.thumbnail}" class="w-14 h-14 rounded-2xl shadow-sm border-2 border-white object-cover">
                        <div><div class="font-black text-slate-900 group-hover:text-red-600">\${item.title}</div><div class="text-[9px] font-black text-slate-400 uppercase">\${item.country} | \${categoryMap[item.category] || 'ETC'}</div></div>
                    </td>
                    <td class="p-6 text-right font-mono font-black text-slate-950">\${formatNum(item.current_subs)}</td>
                    <td class="p-6 text-right font-mono font-bold text-slate-400">\${formatNum(item.current_views)}</td>
                    <td class="p-6 text-right \${displayGrowth === null ? 'text-blue-500' : 'text-emerald-600'} font-black text-lg">\${growthText}</td>
                </tr>\`;
            }).join('');
        }

        async function loadLiveRanking() {
            const region = document.getElementById('regionSelect').value;
            const res = await fetch(\`/api/live-ranking?region=\${region}\`);
            const data = await res.json();
            const grid = document.getElementById('live-grid');
            if (data.length === 0) { grid.innerHTML = '<p class="col-span-3 text-center p-20 font-bold text-slate-300">No Live Streams found. Click Sync.</p>'; return; }
            grid.innerHTML = data.map(d => \`
                <div class="bg-white rounded-[2.5rem] p-5 shadow-lg border hover:shadow-2xl transition-all cursor-pointer group" onclick="window.open('https://youtube.com/watch?v=\${d.video_id}')">
                    <div class="relative mb-5 overflow-hidden rounded-[2rem]">
                        <img src="\${d.thumbnail}" class="w-full h-48 object-cover group-hover:scale-105 transition-transform duration-500">
                        <div class="absolute top-4 left-4 bg-red-600 text-white px-3 py-1 rounded-lg text-[10px] font-black flex items-center gap-1.5 shadow-lg shadow-red-200">
                            <span class="w-2 h-2 bg-white rounded-full live-dot"></span> LIVE
                        </div>
                        <div class="absolute bottom-4 right-4 bg-black/70 backdrop-blur-md text-white px-3 py-1.5 rounded-xl text-[11px] font-bold">
                            \${d.viewers.toLocaleString()} watching
                        </div>
                    </div>
                    <h4 class="font-black text-slate-900 line-clamp-2 mb-2 group-hover:text-red-600">\${d.video_title}</h4>
                    <p class="text-[11px] font-black text-slate-400 uppercase tracking-tight">\${d.channel_name}</p>
                </div>\`).join('');
        }

        async function openModal(id, title, thumb, subs, views, country) {
            const modal = document.getElementById('modal');
            modal.classList.remove('hidden');
            document.getElementById('mTitle').innerText = title;
            document.getElementById('mThumb').src = thumb;
            document.getElementById('mSubsCount').innerText = formatNum(subs);
            document.getElementById('mViewsCount').innerText = formatNum(views);
            document.getElementById('mCountry').innerText = country;
            document.getElementById('mChannelLink').href = 'https://www.youtube.com/channel/' + id;
            if (chart) chart.destroy();
            try {
                const hRes = await fetch('/api/channel-history?id=' + id);
                historyData = await hRes.json();
                currentChartType = 'subs';
                updateChartUI();
                requestAnimationFrame(() => { setTimeout(renderChart, 100); });
            } catch (e) { console.error("History loading failed", e); }
        }

        function toggleChartType(type) { currentChartType = type; updateChartUI(); renderChart(); }
        function updateChartUI() {
            const btnSubs = document.getElementById('btn-chart-subs');
            const btnViews = document.getElementById('btn-chart-views');
            btnSubs.className = currentChartType === 'subs' ? "flex-1 py-3 rounded-xl text-xs font-black transition-all tab-active" : "flex-1 py-3 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500";
            btnViews.className = currentChartType === 'views' ? "flex-1 py-3 rounded-xl text-xs font-black transition-all tab-active" : "flex-1 py-3 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500";
        }

        function renderChart() {
            const canvas = document.getElementById('hChart');
            const ctx = canvas.getContext('2d');
            if (chart) chart.destroy();
            const isSubs = currentChartType === 'subs';
            const color = isSubs ? '#dc2626' : '#2563eb';
            if (!historyData || historyData.length === 0) return;
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: historyData.map(d => d.rank_date.slice(5)),
                    datasets: [{ data: historyData.map(d => isSubs ? d.subs : d.views), borderColor: color, backgroundColor: color + '15', borderWidth: 5, tension: 0.4, fill: true, pointRadius: 5, pointBackgroundColor: color }]
                },
                options: { responsive: true, maintainAspectRatio: false, animation: { duration: 500 }, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false, ticks: { callback: v => formatNum(v) } } } }
            });
        }

        function downloadCSV() {
            let csv = "\uFEFFRank,Channel,Country,Subs,Views,Growth\\n";
            currentRankData.forEach((d, i) => csv += \`\${i+1},"\${d.title}",\${d.country},\${d.current_subs},\${d.current_views},\${d.growth}\\n\`);
            const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = "TubeTrend_Data.csv"; a.click();
        }

        function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadRanking, 300); }
        function changeSort(s) { 
            currentSort = s; 
            document.getElementById('tab-growth').className = s === 'growth' ? 'px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active' : 'px-6 py-2.5 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500';
            document.getElementById('tab-views').className = s === 'views' ? 'px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active' : 'px-6 py-2.5 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500';
            loadRanking(); 
        }
        function changeCategory(c) {
            currentCategory = c;
            document.querySelectorAll('#cat-list button').forEach(b => b.className = "px-6 py-2.5 rounded-xl text-xs font-black bg-white text-slate-400 border-2 border-slate-100 whitespace-nowrap transition-all flex-shrink-0");
            document.getElementById('cat-' + c).className = "px-6 py-2.5 rounded-xl text-xs font-black bg-slate-950 text-white flex-shrink-0 tab-active";
            loadRanking();
        }
        async function updateSystem() {
            const reg = document.getElementById('regionSelect').value;
            const btn = document.getElementById('syncBtn');
            btn.disabled = true; btn.innerText = "Syncing...";
            await fetch('/mass-discover?region=' + reg);
            await loadData();
            btn.disabled = false; btn.innerText = "Sync Data";
        }
        function closeModal() { document.getElementById('modal').classList.add('hidden'); }

        const list = document.getElementById('cat-list');
        Object.keys(categoryMap).forEach(id => {
            const b = document.createElement('button'); b.id = 'cat-' + id; b.innerText = categoryMap[id].toUpperCase();
            b.className = "px-6 py-2.5 rounded-xl text-xs font-black bg-white text-slate-400 border-2 border-slate-100 whitespace-nowrap transition-all flex-shrink-0";
            b.onclick = () => changeCategory(id); list.appendChild(b);
        });
        loadData();
    </script>
</body>
</html>
`;