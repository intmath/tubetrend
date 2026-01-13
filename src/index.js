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

    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const region = url.searchParams.get("region") || "KR";

        // 1. 실시간 라이브 API (KV 캐시 적용)
        if (url.pathname === "/api/live-ranking") {
            const cacheKey = `live_${region}`;
            if (env.KV) {
                const cached = await env.KV.get(cacheKey);
                if (cached) return new Response(cached, { headers: { "Content-Type": "application/json", "X-Cache": "HIT" } });
            }
            const { results } = await env.DB.prepare(`SELECT channel_name, video_title, viewers, thumbnail, video_id FROM LiveRankings WHERE region = ? ORDER BY viewers DESC LIMIT 50`).bind(region).all();
            const data = JSON.stringify(results || []);
            if (env.KV) ctx.waitUntil(env.KV.put(cacheKey, data, { expirationTtl: 300 }));
            return new Response(data, { headers: { "Content-Type": "application/json" } });
        }

        // 2. 채널 랭킹 API (조회수 정렬 및 SQL 최적화)
        if (url.pathname === "/api/ranking") {
            const sort = url.searchParams.get("sort") || "growth";
            const category = url.searchParams.get("category") || "all";
            const searchStr = url.searchParams.get("search") || "";

            let conditions = ["1=1"];
            let bindings = [];
            if (region !== "ALL") { conditions.push("c.country = ?"); bindings.push(region); }
            if (category !== "all") { conditions.push("c.category = ?"); bindings.push(category); }
            if (searchStr.trim() !== "") { conditions.push("c.title LIKE ?"); bindings.push(`%${searchStr}%`); }

            const orderBy = sort === "views" ? "views_growth DESC" : "growth DESC, current_subs DESC";

            const query = `
                WITH LatestDate AS (SELECT MAX(rank_date) as d FROM ChannelStats)
                SELECT c.id, c.title, c.category, c.country, c.thumbnail, 
                       t.subs AS current_subs, t.views AS current_views,
                       (t.subs - IFNULL(y.subs, t.subs)) AS growth,
                       (t.views - IFNULL(y.views, t.views)) AS views_growth
                FROM Channels c
                JOIN ChannelStats t ON c.id = t.channel_id AND t.rank_date = (SELECT d FROM LatestDate)
                LEFT JOIN ChannelStats y ON c.id = y.channel_id AND y.rank_date = DATE((SELECT d FROM LatestDate), '-1 day')
                WHERE ${conditions.join(" AND ")}
                GROUP BY c.id ORDER BY ${orderBy} LIMIT 100
            `;
            const { results } = await env.DB.prepare(query).bind(...bindings).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // 3. 채널 히스토리 API (중복 날짜 제거)
        if (url.pathname === "/api/channel-history") {
            const channelId = url.searchParams.get("id");
            const { results } = await env.DB.prepare(`SELECT rank_date, MAX(subs) as subs, MAX(views) as views FROM ChannelStats WHERE channel_id = ? GROUP BY rank_date ORDER BY rank_date ASC LIMIT 14`).bind(channelId).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // 4. 데이터 동기화
        if (url.pathname === "/mass-discover") {
            ctx.waitUntil((async () => {
                await this.performMassDiscover(env, region);
                await this.handleDailySync(env);
                await this.syncLiveStreams(env, region);
            })());
            return new Response(JSON.stringify({ success: true }));
        }

        return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },

    async syncLiveStreams(env, region) {
        const API_KEY = this.getApiKey(env);
        let query = "live"; let lang = "en";
        if (region === 'KR') { query = "라이브"; lang = "ko"; }
        else if (region === 'JP') { query = "ライブ"; lang = "ja"; }
        else if (region === 'BR') { query = "ao vivo"; lang = "pt"; }
        else if (region === 'FR') { query = "en direct"; lang = "fr"; }

        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&regionCode=${region}&q=${encodeURIComponent(query)}&relevanceLanguage=${lang}&maxResults=25&key=${API_KEY}`);
        const data = await res.json();
        if (data.items) {
            const videoIds = data.items.map(i => i.id.videoId).join(',');
            const vRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${videoIds}&key=${API_KEY}`);
            const vData = await vRes.json();
            await env.DB.prepare("DELETE FROM LiveRankings WHERE region = ?").bind(region).run();
            const stmts = vData.items.map(item => env.DB.prepare(`INSERT INTO LiveRankings (channel_name, video_title, viewers, thumbnail, video_id, region) VALUES (?, ?, ?, ?, ?, ?)`).bind(item.snippet.channelTitle, item.snippet.title, parseInt(item.liveStreamingDetails?.concurrentViewers || 0), item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default.url, item.id, region));
            await env.DB.batch(stmts);
        }
    },

    async performMassDiscover(env, region) {
        const API_KEY = this.getApiKey(env);
        const categories = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28", "29"];
        const promises = categories.map(catId => fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=${region}&videoCategoryId=${catId}&maxResults=50&key=${API_KEY}`).then(res => res.json()));
        const results = await Promise.all(promises);
        let allStmts = [];
        results.forEach(data => {
            if (data.items) {
                const stmts = data.items.map(item => env.DB.prepare(`INSERT INTO Channels (id, title, country, category, thumbnail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET country = excluded.country`).bind(item.snippet.channelId, item.snippet.channelTitle, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url));
                allStmts.push(...stmts);
            }
        });
        if (allStmts.length > 0) await env.DB.batch(allStmts);
    },

    async handleDailySync(env) {
        const { results } = await env.DB.prepare("SELECT id FROM Channels").all();
        const today = this.getKSTDate();
        for (let i = 0; i < results.length; i += 50) {
            const ids = results.slice(i, i + 50).map(c => c.id).join(',');
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
        body { font-family: 'Pretendard Variable', sans-serif; background-color: #f8fafc; color: #0f172a; overflow-x: hidden; }
        .tab-active { background: #dc2626 !important; color: white !important; box-shadow: 0 10px 15px -3px rgba(220, 38, 38, 0.3); }
        .tab-active-blue { background: #2563eb !important; color: white !important; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.3); }
        .live-dot { animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }
        .modal-animate { animation: slideUp 0.3s ease-out; }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    </style>
</head>
<body class="pb-10">
    <nav class="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b shadow-sm px-6 py-4">
        <div class="max-w-6xl mx-auto flex justify-between items-center">
            <h1 class="text-2xl font-black tracking-tighter italic uppercase underline decoration-red-600 underline-offset-4">TUBE <span class="text-red-600">TREND PRO</span></h1>
            <div class="flex items-center gap-3">
                <select id="regionSelect" onchange="loadData()" class="bg-slate-100 border-none rounded-2xl px-4 py-2 text-xs font-bold outline-none cursor-pointer hover:bg-slate-200 transition-all">
                    <option value="KR" selected>🇰🇷 Korea</option>
                    <option value="US">🇺🇸 USA</option>
                    <option value="JP">🇯🇵 Japan</option>
                    <option value="IN">🇮🇳 India</option>
                    <option value="BR">🇧🇷 Brazil</option>
                    <option value="DE">🇩🇪 Germany</option>
                    <option value="FR">🇫🇷 France</option>
                </select>
                <button onclick="updateSystem()" id="syncBtn" class="bg-slate-900 text-white px-5 py-2.5 rounded-2xl text-xs font-bold hover:bg-red-600 transition-all active:scale-95 shadow-lg shadow-slate-200">Sync Data</button>
            </div>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto px-4 mt-10">
        <div id="syncStatus" class="hidden mb-6 p-4 bg-red-50 text-red-600 rounded-[2rem] border border-red-100 text-sm font-black text-center animate-pulse">
            데이터 동기화가 백그라운드에서 시작되었습니다. 약 5초 후 새로고침 해주세요.
        </div>
        <div class="flex gap-2 mb-10 bg-slate-100 p-1.5 rounded-[2rem] w-fit border border-slate-200 mx-auto shadow-inner">
            <button onclick="switchTab('ranking')" id="btn-tab-rank" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all tab-active">CHANNEL RANK</button>
            <button onclick="switchTab('live')" id="btn-tab-live" class="px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600">LIVE NOW</button>
        </div>
        <div id="section-ranking" class="block">
            <div class="flex flex-col md:flex-row justify-between gap-4 mb-8">
                <input type="text" id="searchInput" oninput="debounceSearch()" placeholder="Search creators..." class="w-full md:w-96 p-4 rounded-[1.5rem] border-2 border-slate-100 bg-white font-bold outline-none focus:border-red-600 transition-all shadow-sm">
                <div class="flex bg-slate-100 p-1 rounded-[1.5rem] border border-slate-200">
                    <button onclick="changeSort('growth')" id="tab-growth" class="px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active">GROWTH</button>
                    <button onclick="changeSort('views')" id="tab-views" class="px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400">VIEWS</button>
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mb-8" id="cat-list">
                <button onclick="changeCategory('all')" id="cat-all" class="px-5 py-2.5 rounded-2xl text-[11px] font-black bg-slate-900 text-white transition-all shadow-md">ALL TOPICS</button>
            </div>
            <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl overflow-x-auto">
                <table class="w-full text-left min-w-[850px]">
                    <thead class="bg-slate-50 border-b text-slate-400 font-black text-[10px] uppercase tracking-widest">
                        <tr><th class="p-6 text-center w-24">Rank</th><th class="p-6">Channel</th><th class="p-6 text-right">Subs</th><th class="p-6 text-right">Total Views</th><th id="growth-header" class="p-6 text-right">24h Growth</th></tr>
                    </thead>
                    <tbody id="table-body" class="divide-y divide-slate-50"></tbody>
                </table>
            </div>
        </div>
        <div id="section-live" class="hidden">
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6" id="live-grid"></div>
        </div>
    </main>

    <div id="modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
        <div class="bg-white w-full max-w-2xl rounded-[3rem] p-0 relative shadow-2xl overflow-hidden modal-animate">
            <div class="bg-slate-50 px-8 pt-12 pb-8 border-b border-slate-100 relative">
                <button onclick="closeModal()" class="absolute top-6 right-8 text-3xl font-light text-slate-400 hover:text-red-600 transition-colors">&times;</button>
                <div class="flex items-center gap-6">
                    <img id="mThumb" class="w-24 h-24 rounded-[2.5rem] shadow-2xl border-4 border-white object-cover">
                    <div class="flex-1">
                        <h3 id="mTitle" class="text-2xl font-black text-slate-900 leading-tight mb-3">Channel</h3>
                        <a id="mChannelLink" target="_blank" class="bg-red-600 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase shadow-lg shadow-red-100 hover:bg-red-700 transition-all active:scale-95">Visit Channel</a>
                    </div>
                </div>
            </div>
            <div class="p-8">
                <div class="grid grid-cols-3 gap-3 mb-8">
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center">
                        <p class="text-[9px] font-black text-slate-400 uppercase mb-1">Subscribers</p>
                        <p id="mSubs" class="text-lg font-black text-slate-900">0</p>
                    </div>
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center">
                        <p class="text-[9px] font-black text-slate-400 uppercase mb-1">Total Views</p>
                        <p id="mViews" class="text-lg font-black text-slate-900">0</p>
                    </div>
                    <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-center">
                        <p class="text-[9px] font-black text-slate-400 uppercase mb-1">Growth</p>
                        <p id="mGrowth" class="text-lg font-black text-emerald-600">+0</p>
                    </div>
                </div>
                <div class="flex gap-2 mb-6 bg-slate-100 p-1 rounded-2xl w-fit mx-auto border shadow-inner">
                    <button onclick="toggleChartType('subs')" id="btn-chart-subs" class="px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active">SUBSCRIBERS</button>
                    <button onclick="toggleChartType('views')" id="btn-chart-views" class="px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400">TOTAL VIEWS</button>
                </div>
                <div class="rounded-3xl border border-slate-100 p-5">
                    <div class="h-60 w-full"><canvas id="hChart"></canvas></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentTab = 'ranking', currentSort = 'growth', currentCategory = 'all', currentRankData = [], chart = null, historyData = [], currentChartType = 'subs', searchTimer;
        const categoryMap = {"1":"Film & Animation","2":"Autos & Vehicles","10":"Music","15":"Pets & Animals","17":"Sports","19":"Travel & Events","20":"Gaming","22":"People & Blogs","23":"Comedy","24":"Entertainment","25":"News & Politics","26":"Howto & Style","27":"Education","28":"Science & Tech","29":"Nonprofits"};

        function formatNum(n) {
            if (n === null || n === undefined) return "0";
            if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n.toLocaleString();
        }

        async function switchTab(t) {
            currentTab = t;
            document.getElementById('btn-tab-rank').className = t === 'ranking' ? 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all tab-active' : 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600';
            document.getElementById('btn-tab-live').className = t === 'live' ? 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all tab-active' : 'px-8 py-3 rounded-[1.5rem] text-sm font-black transition-all text-slate-400 hover:text-slate-600';
            document.getElementById('section-ranking').style.display = t === 'ranking' ? 'block' : 'none';
            document.getElementById('section-live').style.display = t === 'live' ? 'block' : 'none';
            loadData();
        }

        async function loadData() {
            const region = document.getElementById('regionSelect').value;
            const search = document.getElementById('searchInput').value;
            const endpoint = currentTab === 'ranking' ? \`/api/ranking?region=\${region}&sort=\${currentSort}&category=\${currentCategory}&search=\${encodeURIComponent(search)}\` : \`/api/live-ranking?region=\${region}\`;
            try {
                const res = await fetch(endpoint);
                const data = await res.json();
                if (currentTab === 'ranking') renderRanking(data);
                else renderLive(data);
            } catch (e) { console.error(e); }
        }

        function renderRanking(data) {
            const header = document.getElementById('growth-header');
            header.innerText = currentSort === 'views' ? 'View Growth' : '24h Growth';
            
            document.getElementById('table-body').innerHTML = data.map((item, idx) => {
                const growthVal = currentSort === 'views' ? item.views_growth : item.growth;
                return \`
                <tr onclick="openModal('\${item.id}', '\${item.title.replace(/'/g, "")}', '\${item.thumbnail}', \${item.current_subs}, \${item.current_views}, \${growthVal})" class="group hover:bg-slate-50 transition-all cursor-pointer">
                    <td class="p-6 text-center text-xl font-black text-slate-200 group-hover:text-red-600 transition-colors">\${idx + 1}</td>
                    <td class="p-6 flex items-center gap-5">
                        <img src="\${item.thumbnail}" class="w-14 h-14 rounded-2xl shadow-sm object-cover">
                        <div class="font-black text-slate-900 group-hover:text-red-600 transition-colors">\${item.title}</div>
                    </td>
                    <td class="p-6 text-right font-mono font-black text-slate-900">\${formatNum(item.current_subs)}</td>
                    <td class="p-6 text-right font-mono font-bold text-slate-400">\${formatNum(item.current_views)}</td>
                    <td class="p-6 text-right text-emerald-600 font-black text-lg">+\${formatNum(growthVal)}</td>
                </tr>\`;
            }).join('');
        }

        function renderLive(data) {
            document.getElementById('live-grid').innerHTML = data.map(d => \`
                <div class="bg-white rounded-[2rem] p-3 shadow-sm border border-slate-100 hover:shadow-2xl transition-all cursor-pointer group" onclick="window.open('https://youtube.com/watch?v=\${d.video_id}')">
                    <div class="relative mb-4 overflow-hidden rounded-[1.5rem] h-32">
                        <img src="\${d.thumbnail}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500">
                        <div class="absolute top-3 left-3 bg-red-600 text-white px-2 py-1 rounded-lg text-[8px] font-black flex items-center gap-1 shadow-lg shadow-red-200"><span class="w-1.5 h-1.5 bg-white rounded-full live-dot"></span> LIVE</div>
                    </div>
                    <div class="mb-2"><span class="text-[10px] font-black text-red-600 bg-red-50 px-2 py-1 rounded-lg leading-none">\${d.viewers.toLocaleString()}명 시청 중</span></div>
                    <h4 class="font-black text-slate-900 line-clamp-1 text-xs mb-1 group-hover:text-red-600 leading-tight">\${d.video_title}</h4>
                    <p class="text-[10px] font-black text-slate-400 uppercase truncate">\${d.channel_name}</p>
                </div>\`).join('');
        }

        async function openModal(id, title, thumb, subs, views, growth) {
            document.getElementById('modal').classList.remove('hidden');
            document.getElementById('mTitle').innerText = title;
            document.getElementById('mThumb').src = thumb;
            document.getElementById('mSubs').innerText = formatNum(subs);
            document.getElementById('mViews').innerText = formatNum(views);
            document.getElementById('mGrowth').innerText = "+" + formatNum(growth);
            document.getElementById('mChannelLink').href = 'https://www.youtube.com/channel/' + id;
            currentChartType = 'subs';
            updateChartButtons();
            if (chart) chart.destroy();
            try {
                const res = await fetch('/api/channel-history?id=' + id);
                historyData = await res.json();
                setTimeout(renderChart, 200);
            } catch (e) { console.error(e); }
        }

        function toggleChartType(type) { currentChartType = type; updateChartButtons(); renderChart(); }
        
        function updateChartButtons() {
            const isSubs = currentChartType === 'subs';
            document.getElementById('btn-chart-subs').className = isSubs ? "px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active" : "px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400";
            document.getElementById('btn-chart-views').className = !isSubs ? "px-6 py-2 rounded-xl text-[10px] font-black transition-all tab-active-blue" : "px-6 py-2 rounded-xl text-[10px] font-black transition-all text-slate-400";
        }

        function renderChart() {
            const ctx = document.getElementById('hChart').getContext('2d');
            if (chart) chart.destroy();
            const isSubs = currentChartType === 'subs';
            const color = isSubs ? '#dc2626' : '#2563eb';
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: historyData.map(d => d.rank_date.slice(5)),
                    datasets: [{ 
                        data: historyData.map(d => isSubs ? d.subs : d.views), 
                        borderColor: color, backgroundColor: isSubs ? 'rgba(220, 38, 38, 0.1)' : 'rgba(37, 99, 235, 0.1)', 
                        borderWidth: 4, tension: 0.4, fill: true, pointRadius: 4, pointBackgroundColor: color 
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { border: { display: false }, grid: { color: '#f1f5f9' }, ticks: { callback: v => formatNum(v), font: { size: 9, weight: 'bold' } } }, x: { border: { display: false }, grid: { display: false }, ticks: { font: { size: 9, weight: 'bold' } } } } }
            });
        }

        async function updateSystem() {
            const btn = document.getElementById('syncBtn');
            btn.disabled = true; document.getElementById('syncStatus').classList.remove('hidden');
            await fetch('/mass-discover?region=' + document.getElementById('regionSelect').value);
            setTimeout(() => { btn.disabled = false; document.getElementById('syncStatus').classList.add('hidden'); loadData(); }, 3000);
        }

        function closeModal() { document.getElementById('modal').classList.add('hidden'); if(chart) chart.destroy(); }
        
        function changeSort(s) { 
            currentSort = s; 
            document.getElementById('tab-growth').className = s === 'growth' ? 'px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active' : 'px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400';
            document.getElementById('tab-views').className = s === 'views' ? 'px-6 py-2 rounded-2xl text-xs font-black transition-all tab-active' : 'px-6 py-2 rounded-2xl text-xs font-black transition-all text-slate-400';
            loadData(); 
        }

        function changeCategory(c) {
            currentCategory = c;
            document.querySelectorAll('#cat-list button').forEach(b => b.className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-white text-slate-400 border border-slate-100 transition-all hover:bg-slate-50");
            if(c === 'all') document.getElementById('cat-all').className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-slate-900 text-white transition-all shadow-md";
            else document.getElementById('cat-' + c).className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-slate-900 text-white transition-all shadow-md";
            loadData();
        }
        function debounceSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadData, 300); }

        const list = document.getElementById('cat-list');
        Object.keys(categoryMap).forEach(id => {
            const b = document.createElement('button'); b.id = 'cat-' + id; b.innerText = categoryMap[id].toUpperCase();
            b.className = "px-5 py-2.5 rounded-2xl text-[11px] font-black bg-white text-slate-400 border border-slate-100 transition-all hover:bg-slate-50";
            b.onclick = () => changeCategory(id); list.appendChild(b);
        });
        loadData();
    </script>
</body>
</html>
`;