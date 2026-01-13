DROP TABLE IF EXISTS ChannelStats;
DROP TABLE IF EXISTS Channels;

CREATE TABLE Channels (
    id TEXT PRIMARY KEY,
    title TEXT,
    country TEXT,
    category TEXT,
    thumbnail TEXT
);

CREATE TABLE ChannelStats (
    channel_id TEXT,
    subs INTEGER,
    views INTEGER,
    rank_date DATE,
    PRIMARY KEY(channel_id, rank_date)
);