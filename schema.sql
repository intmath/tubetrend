DROP TABLE IF EXISTS ChannelStats;
DROP TABLE IF EXISTS Channels;
-- 1. 채널 기본 정보 테이블
CREATE TABLE IF NOT EXISTS Channels (
    id TEXT PRIMARY KEY,
    title TEXT,
    country TEXT,
    category TEXT,
    thumbnail TEXT
);

-- 2. 채널별 일일 통계 테이블
CREATE TABLE IF NOT EXISTS ChannelStats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT,
    subs INTEGER,
    views INTEGER,
    rank_date TEXT,
    FOREIGN KEY(channel_id) REFERENCES Channels(id)
);

-- 3. 실시간 라이브 순위 테이블 (이번에 추가된 것)
CREATE TABLE IF NOT EXISTS LiveRankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_name TEXT,
    video_title TEXT,
    viewers INTEGER,
    thumbnail TEXT,
    video_id TEXT,
    region TEXT
);

-- 4. 실시간 방송 채널 누적 테이블 (Accumulate)
CREATE TABLE IF NOT EXISTS LiveStreamers (
    channel_id TEXT PRIMARY KEY,
    title TEXT,
    thumbnail TEXT,
    last_live_date TEXT,
    region TEXT
);