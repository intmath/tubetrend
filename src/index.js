export default {
    getApiKey(env) {
        if (!env.YOUTUBE_API_KEYS) return null;
        const keys = env.YOUTUBE_API_KEYS.split(',');
        return keys[Math.floor(Math.random() * keys.length)];
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        const region = url.searchParams.get("region") || "KR";
        const sort = url.searchParams.get("sort") || "growth";
        const category = url.searchParams.get("category") || "all";
        const searchStr = url.searchParams.get("search") || "";

        // [API] 랭킹 조회 - 검색 및 정렬 로직 강화
        if (url.pathname === "/api/ranking") {
            try {
                let conditions = [];
                let bindings = [];

                // 검색어 필터 추가
                if (searchStr.trim() !== "") {
                    conditions.push("c.title LIKE ?");
                    bindings.push(`%${searchStr}%`);
                }

                // 국가 필터 추가
                if (region !== "ALL") {
                    conditions.push("c.country = ?");
                    bindings.push(region);
                }

                // 카테고리 필터 추가
                if (category !== "all") {
                    conditions.push("c.category = ?");
                    bindings.push(category);
                }

                const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

                // 정렬 로직 (Views 버튼 대응)
                const orderBy = sort === "views" ? "t.views DESC" : "growth DESC, t.subs DESC";

                const query = `
          SELECT c.id, c.title, c.category, c.country, c.thumbnail, t.subs AS current_subs, t.views AS current_views,
                 (t.subs - IFNULL(y.subs, t.subs)) AS growth
          FROM Channels c
          JOIN ChannelStats t ON c.id = t.channel_id 
               AND t.rank_date = (SELECT MAX(rank_date) FROM ChannelStats WHERE channel_id = c.id)
          LEFT JOIN ChannelStats y ON c.id = y.channel_id 
               AND y.rank_date = DATE((SELECT MAX(rank_date) FROM ChannelStats WHERE channel_id = c.id), '-1 day')
          ${whereClause}
          ORDER BY ${orderBy} LIMIT 100
        `;
                const { results } = await env.DB.prepare(query).bind(...bindings).all();
                return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
            } catch (e) {
                return new Response("[]", { status: 500 });
            }
        }

        // [API] 히스토리 조회
        if (url.pathname === "/api/channel-history") {
            const channelId = url.searchParams.get("id");
            const { results } = await env.DB.prepare(`SELECT rank_date, subs, views FROM ChannelStats WHERE channel_id = ? ORDER BY rank_date ASC LIMIT 7`).bind(channelId).all();
            return new Response(JSON.stringify(results || []), { headers: { "Content-Type": "application/json" } });
        }

        // [관리] 데이터 수집
        if (url.pathname === "/mass-discover") {
            const targetRegion = url.searchParams.get("region") || "KR";
            await this.performMassDiscover(env, targetRegion);
            await this.handleDailySync(env);
            return new Response(JSON.stringify({ success: true }));
        }

        return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },

    async performMassDiscover(env, region) {
        const API_KEY = this.getApiKey(env);
        const categories = ["", "1", "10", "17", "20", "23", "24", "25", "28"];
        for (const catId of categories) {
            const catParam = catId ? `&videoCategoryId=${catId}` : "";
            const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=${region}${catParam}&maxResults=50&key=${API_KEY}`);
            const data = await res.json();
            if (data.items) {
                const stmts = data.items.map(item => env.DB.prepare(`
          INSERT INTO Channels (id, title, country, category, thumbnail) 
          VALUES (?, ?, ?, ?, ?) 
          ON CONFLICT(id) DO UPDATE SET country = excluded.country, thumbnail = excluded.thumbnail
        `).bind(item.snippet.channelId, item.snippet.channelTitle, region, item.snippet.categoryId || "0", item.snippet.thumbnails.default.url));
                await env.DB.batch(stmts);
            }
        }
    },

    async handleDailySync(env) {
        const { results } = await env.DB.prepare("SELECT id FROM Channels").all();
        const chunks = [];
        for (let i = 0; i < results.length; i += 50) chunks.push(results.slice(i, i + 50));
        const today = new Date().toISOString().split('T')[0];
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
        body { font-family: 'Pretendard Variable', sans-serif; background-color: #ffffff; color: #0f172a; }
        .tab-active { background: #dc2626 !important; color: white !important; border-color: #dc2626 !important; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .category-container { display: flex; gap: 0.6rem; overflow-x: auto; padding: 1rem 0; }
    </style>
</head>
<body class="bg-white">
    <nav class="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b-2 border-slate-100 px-4 py-4">
        <div class="max-w-6xl mx-auto flex justify-between items-center">
            <h1 class="text-2xl font-black tracking-tighter">Tube <span class="text-red-600">Trend Pro</span></h1>
            <div class="flex items-center gap-2">
                <select id="regionSelect" onchange="loadRanking()" class="bg-slate-50 border-2 border-slate-200 rounded-xl px-3 py-2 text-xs font-black outline-none focus:border-red-600 cursor-pointer">
                    <option value="ALL">🌍 Global</option>
                    <option value="KR" selected>🇰🇷 Korea</option>
                    <option value="US">🇺🇸 USA</option>
                    <option value="JP">🇯🇵 Japan</option>
                    <option value="GB">🇬🇧 UK</option>
                    <option value="BR">🇧🇷 Brazil</option>
                </select>
                <button onclick="downloadCSV()" class="bg-emerald-600 text-white px-4 py-2 rounded-xl text-xs font-black shadow-md hover:bg-emerald-700 transition-all">CSV</button>
                <button onclick="updateSystem()" id="syncBtn" class="bg-slate-950 text-white px-4 py-2 rounded-xl text-xs font-black transition-all active:scale-95">Sync Data</button>
            </div>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto px-4 py-8">
        <div class="flex flex-col md:flex-row justify-between gap-6 mb-4">
            <input type="text" id="searchInput" oninput="debounceSearch()" placeholder="Search channels..." class="w-full md:w-80 p-3.5 rounded-2xl border-2 border-slate-100 font-bold outline-none focus:border-red-600 transition-all shadow-sm">
            <div class="bg-slate-100 p-1 rounded-2xl flex gap-1 border border-slate-200">
                <button onclick="changeSort('growth')" id="tab-growth" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all tab-active">Growth</button>
                <button onclick="changeSort('views')" id="tab-views" class="px-6 py-2.5 rounded-xl text-xs font-black transition-all bg-transparent text-slate-500">Views</button>
            </div>
        </div>
        
        <div class="category-container no-scrollbar" id="cat-list">
            <button onclick="changeCategory('all')" id="cat-all" class="px-6 py-2.5 rounded-xl text-xs font-black bg-slate-950 text-white flex-shrink-0">ALL TOPICS</button>
        </div>

        <div class="bg-white rounded-[2.5rem] border-2 border-slate-100 shadow-2xl overflow-x-auto mt-6">
            <table class="w-full text-left min-w-[850px]">
                <thead class="bg-slate-50 border-b-2">
                    <tr>
                        <th class="p-6 text-[10px] font-black uppercase text-slate-400 text-center w-20">Rank</th>
                        <th class="p-6 text-[10px] font-black uppercase text-slate-400">Channel Info</th>
                        <th class="p-6 text-right text-[10px] font-black uppercase text-slate-400">Subscribers</th>
                        <th class="p-6 text-right text-[10px] font-black uppercase text-slate-400">Total Views</th>
                        <th class="p-6 text-right text-[10px] font-black uppercase text-slate-400">24h Growth</th>
                    </tr>
                </thead>
                <tbody id="table-body" class="divide-y-2 divide-slate-50"></tbody>
            </table>
        </div>
    </main>

    <div id="modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
        <div class="bg-white w-full max-w-2xl rounded-[3rem] p-8 md:p-12 relative shadow-2xl">
            <button onclick="closeModal()" class="absolute top-8 right-10 text-4xl font-light text-slate-300 hover:text-red-600">&times;</button>
            <div class="flex items-center gap-6 mb-8">
                <img id="mThumb" class="w-20 h-20 rounded-2xl shadow-lg border">
                <div class="flex-1">
                    <div class="flex items-center gap-3 mb-1">
                        <h3 id="mTitle" class="text-2xl font-black text-slate-900 leading-tight">Channel Name</h3>
                        <a id="mChannelLink" target="_blank" class="bg-red-600 text-white px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase">Visit Channel</a>
                    </div>
                    <span id="mCountry" class="bg-slate-100 px-3 py-1 rounded-lg text-[10px] font-black text-slate-400 uppercase">Country</span>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-4 mb-8">
                <div class="bg-slate-50 p-6 rounded-[2rem] border-2 border-slate-100 text-center">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-1">Subscribers</p>
                    <p id="mSubsCount" class="text-2xl font-black">0</p>
                </div>
                <div class="bg-slate-50 p-6 rounded-[2rem] border-2 border-slate-100 text-center">
                    <p class="text-[10px] font-black text-slate-400 uppercase mb-1">Total Views</p>
                    <p id="mViewsCount" class="text-2xl font-black">0</p>
                </div>
            </div>
            <div class="h-64 w-full relative"><canvas id="hChart"></canvas></div>
        </div>
    </div>

    <script>
        let currentSort = 'growth', currentCategory = 'all', currentRankData = [], chart, searchTimer;
        const categoryMap = {"1":"Film","10":"Music","17":"Sports","20":"Gaming","22":"Blogs","23":"Comedy","24":"Entertain","25":"News","26":"Howto","27":"Edu","28":"Tech"};

        function formatNum(n) {
            if (!n) return "0";
            if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n.toLocaleString();
        }

        async function loadRanking() {
            const region = document.getElementById('regionSelect').value;
            const search = document.getElementById('searchInput').value;
            // sort 파라미터를 API에 전달하도록 수정
            const res = await fetch(\`/api/ranking?region=\${region}&sort=\${currentSort}&category=\${currentCategory}&search=\${encodeURIComponent(search)}\`);
            currentRankData = await res.json();
            const tbody = document.getElementById('table-body');
            
            if (currentRankData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="p-20 text-center text-slate-400 font-bold italic">No data. Click Sync.</td></tr>';
                return;
            }

            tbody.innerHTML = currentRankData.map((item, idx) => \`
                <tr onclick="openModal('\${item.id}', '\${item.title.replace(/'/g, "")}', '\${item.thumbnail}', \${item.current_subs}, \${item.current_views}, '\${item.country}')" class="hover:bg-slate-50 cursor-pointer">
                    <td class="p-6 text-center text-2xl font-black text-slate-300">\${idx + 1}</td>
                    <td class="p-6 flex items-center gap-4">
                        <img src="\${item.thumbnail}" class="w-12 h-12 rounded-xl shadow-sm border">
                        <div class="font-black text-slate-900">\${item.title}</div>
                    </td>
                    <td class="p-6 text-right font-mono font-bold">\${formatNum(item.current_subs)}</td>
                    <td class="p-6 text-right font-mono text-slate-400">\${formatNum(item.current_views)}</td>
                    <td class="p-6 text-right text-emerald-600 font-black text-lg">+\${formatNum(item.growth)}</td>
                </tr>\`).join('');
        }

        // 검색 기능 구현
        function debounceSearch() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(loadRanking, 300);
        }

        // 정렬 기능 구현
        function changeSort(s) {
            currentSort = s;
            document.getElementById('tab-growth').className = 'px-6 py-2.5 rounded-xl text-xs font-black transition-all ' + (s === 'growth' ? 'tab-active' : 'bg-transparent text-slate-500');
            document.getElementById('tab-views').className = 'px-6 py-2.5 rounded-xl text-xs font-black transition-all ' + (s === 'views' ? 'tab-active' : 'bg-transparent text-slate-500');
            loadRanking();
        }

        // CSV 다운로드 기능 구현
        function downloadCSV() {
            let csv = "\uFEFFRank,Channel,Country,Subs,Views,Growth\\n";
            currentRankData.forEach((d, i) => {
                csv += \`\${i+1},"\${d.title.replace(/"/g, '""')}",\${d.country},\${d.current_subs},\${d.current_views},\${d.growth}\\n\`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.setAttribute("download", "TubeTrend_Export.csv");
            link.click();
        }

        async function openModal(id, title, thumb, subs, views, country) {
            document.getElementById('modal').classList.remove('hidden');
            document.getElementById('mTitle').innerText = title;
            document.getElementById('mThumb').src = thumb;
            document.getElementById('mSubsCount').innerText = formatNum(subs);
            document.getElementById('mViewsCount').innerText = formatNum(views);
            document.getElementById('mCountry').innerText = country;
            document.getElementById('mChannelLink').href = 'https://www.youtube.com/channel/' + id;
            
            const hRes = await fetch('/api/channel-history?id=' + id);
            const historyData = await hRes.json();
            
            const ctx = document.getElementById('hChart').getContext('2d');
            if (chart) chart.destroy();
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: historyData.map(d => d.rank_date.slice(5)),
                    datasets: [{ data: historyData.map(d => d.subs), borderColor: '#dc2626', borderWidth: 4, tension: 0.4 }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });
        }

        async function updateSystem() {
            const reg = document.getElementById('regionSelect').value;
            const btn = document.getElementById('syncBtn');
            btn.disabled = true; btn.innerText = "Syncing...";
            await fetch('/mass-discover?region=' + reg);
            await loadRanking();
            btn.disabled = false; btn.innerText = "Sync Data";
        }

        function changeCategory(c) {
            currentCategory = c;
            document.querySelectorAll('#cat-list button').forEach(b => b.className = "px-6 py-2.5 rounded-xl text-xs font-black bg-white text-slate-400 border-2 border-slate-100 whitespace-nowrap transition-all flex-shrink-0");
            document.getElementById('cat-' + (c === 'all' ? 'all' : c)).className = "px-6 py-2.5 rounded-xl text-xs font-black bg-slate-950 text-white flex-shrink-0 tab-active";
            loadRanking();
        }

        function closeModal() { document.getElementById('modal').classList.add('hidden'); }

        const list = document.getElementById('cat-list');
        Object.keys(categoryMap).forEach(id => {
            const b = document.createElement('button'); b.id = 'cat-' + id; b.innerText = categoryMap[id].toUpperCase();
            b.className = "px-6 py-2.5 rounded-xl text-xs font-black bg-white text-slate-400 border-2 border-slate-100 whitespace-nowrap transition-all flex-shrink-0";
            b.onclick = () => changeCategory(id); list.appendChild(b);
        });
        loadRanking();
    </script>
</body>
</html>
`;