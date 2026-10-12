-- Deep Context System Schema
-- Personal knowledge base for LLM digital assistant
-- Created: 2026-01-31

-- ============================================================
-- CORE TABLES
-- ============================================================

-- Conversation containers (email threads, chat conversations, tweet threads, episodes, calls)
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,  -- Composite: source:thread_id
    source TEXT NOT NULL,  -- gmail, slack, beeper, twitter, calls, podcast
    source_thread_id TEXT NOT NULL,  -- Original thread ID from source
    source_url TEXT,  -- URL to thread/conversation

    -- Thread metadata
    subject TEXT,  -- For email threads
    title TEXT,  -- For calls, podcast episodes
    started_at DATETIME,
    last_activity_at DATETIME,

    -- Counts
    message_count INTEGER DEFAULT 0,
    my_message_count INTEGER DEFAULT 0,  -- How many messages the owner sent/spoke

    -- Participants
    participant_ids TEXT,  -- JSON array of person IDs
    thread_type TEXT,  -- 1:1, group, broadcast, standalone, thread (multi-tweet chains)

    -- Source-specific metadata
    raw_json TEXT,
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    network TEXT  -- messaging network label (imessage, whatsapp, ...) where known
    -- (Pre-2026-10 DBs may also have enriched_topic/enriched_type/enriched_relationship/
    --  enriched_at here. They are no longer written or read; leaving them is harmless.)
);

-- Individual messages within threads (ALL messages, not just the owner's)
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,  -- Composite: source:message_id
    thread_id TEXT NOT NULL REFERENCES threads(id),
    source TEXT NOT NULL,
    source_message_id TEXT NOT NULL,

    -- Timing & ordering
    timestamp DATETIME NOT NULL,
    position_in_thread INTEGER,  -- 1, 2, 3...

    -- Who sent it
    sender_id TEXT REFERENCES people(id),
    is_from_me BOOLEAN NOT NULL,  -- Sent from one of the owner's own accounts

    -- Who actually composed the words. is_from_me answers "whose account",
    -- authored_by answers "whose voice" -- an AI agent sending from the owner's
    -- account is is_from_me=1, authored_by='<agent-id>'. NULL = not judged.
    authored_by TEXT,
    authorship_evidence TEXT,  -- how we know; free text

    -- Content
    content TEXT NOT NULL,
    content_type TEXT,  -- email, dm, tweet, reply, quote_tweet, speaker_turn,
                        -- questions, intro, editorial_commentary

    -- For replies/quotes (source-dependent)
    reply_to_message_id TEXT,  -- If replying to specific message
    quoted_content TEXT,  -- For quote tweets, inline the quoted text

    -- Email-specific (recipients can differ per message in thread)
    recipients TEXT,  -- JSON: {to: [], cc: [], bcc: []}

    -- Basic metadata
    has_attachments BOOLEAN DEFAULT FALSE,
    word_count INTEGER,

    -- Raw data
    raw_json TEXT,
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- People I interact with
CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,  -- Normalized identifier (slugified name or email)
    display_name TEXT NOT NULL,
    identifiers TEXT,  -- JSON array of emails, handles, phone numbers

    -- Activity tracking
    first_seen DATETIME,
    last_seen DATETIME,
    thread_count INTEGER DEFAULT 0,  -- Threads they appear in
    message_count INTEGER DEFAULT 0,  -- Messages from them
    my_message_count INTEGER DEFAULT 0,  -- My messages to them

    -- Relationship info
    relationship_type TEXT,  -- family, friend, colleague, client, vendor, investor, podcast_guest, public
    organization TEXT,
    title TEXT,
    notes TEXT,

    -- Generated content
    relationship_summary TEXT,
    summary_updated_at DATETIME
);

-- ============================================================
-- AI-GENERATED METADATA (optional `enrich`; ONLY for the owner's messages)
-- Slimmed 2026-10 to the fields something actually reads. Older DBs may also carry
-- domain, sentiment, engagement, actionability, style_tags, thread_role and
-- relationship_dynamic: no longer written or read, left in place (never dropped).
-- ============================================================

CREATE TABLE IF NOT EXISTS message_metadata (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    quality_score REAL,        -- 1-7: voice, insight, craft (1=filler, 4=solid, 7=exceptional)
    authorship_score REAL,     -- 0-1: confidence the owner wrote this (vs quoted/LLM/forwarded)
    originality_score REAL,    -- 1-7: 1=common wisdom, 4=thoughtful, 7=unique insight
    topics TEXT,               -- JSON array of 1-3 lowercase topic tags
    entities TEXT,             -- JSON array: people, companies, products named in the message
    processed_at DATETIME,
    processor_model TEXT       -- re-enrich happens automatically when the model changes
);

-- ============================================================
-- EXTRACTION TRACKING (for incremental updates)
-- ============================================================

CREATE TABLE IF NOT EXISTS extraction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    extraction_type TEXT,  -- full, incremental
    started_at DATETIME,
    completed_at DATETIME,
    items_extracted INTEGER,
    newest_item_timestamp DATETIME,
    oldest_item_timestamp DATETIME,
    parameters TEXT,  -- JSON of extraction parameters
    status TEXT,  -- running, completed, failed
    error_message TEXT
);

-- Slack user cache for email enrichment
CREATE TABLE IF NOT EXISTS slack_user_cache (
    workspace TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    real_name TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace, user_id)
);

-- ============================================================
-- INDEXES for common queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_threads_source ON threads(source);
CREATE INDEX IF NOT EXISTS idx_threads_last_activity ON threads(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_started ON threads(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages(is_from_me) WHERE is_from_me = 1;
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);

CREATE INDEX IF NOT EXISTS idx_people_last_seen ON people(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_people_relationship ON people(relationship_type);

CREATE INDEX IF NOT EXISTS idx_metadata_quality ON message_metadata(quality_score);
CREATE INDEX IF NOT EXISTS idx_metadata_processed ON message_metadata(processed_at);

CREATE INDEX IF NOT EXISTS idx_extraction_source ON extraction_log(source);
CREATE INDEX IF NOT EXISTS idx_extraction_status ON extraction_log(status);

CREATE INDEX IF NOT EXISTS idx_slack_user_cache_email ON slack_user_cache(email);

-- ============================================================
-- USEFUL VIEWS
-- ============================================================

-- the owner's messages with thread context counts
CREATE VIEW IF NOT EXISTS v_my_messages AS
SELECT
    m.*,
    t.subject,
    t.title,
    t.source as thread_source,
    t.message_count as thread_message_count,
    t.started_at as thread_started_at,
    (SELECT COUNT(*) FROM messages m2
     WHERE m2.thread_id = m.thread_id AND m2.timestamp < m.timestamp) as prior_messages_in_thread
FROM messages m
JOIN threads t ON m.thread_id = t.id
WHERE m.is_from_me = 1;

-- People ranked by interaction volume
CREATE VIEW IF NOT EXISTS v_people_ranked AS
SELECT
    p.*,
    (p.thread_count + p.message_count + p.my_message_count) as total_interactions,
    julianday('now') - julianday(p.last_seen) as days_since_last_seen
FROM people p
ORDER BY total_interactions DESC;

-- Extraction status by source
CREATE VIEW IF NOT EXISTS v_extraction_status AS
SELECT
    source,
    MAX(completed_at) as last_extraction,
    MAX(newest_item_timestamp) as newest_item,
    SUM(items_extracted) as total_items_extracted
FROM extraction_log
WHERE status = 'completed'
GROUP BY source;

-- ============================================================
-- CALENDAR (import-takeout.ts; same DDL as tools/_lib/calendar-schema.ts)
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,           -- calendar:<UID>[:<RECURRENCE-ID>]
    source TEXT NOT NULL DEFAULT 'calendar',
    calendar_name TEXT,            -- e.g. the .ics file name from Takeout
    uid TEXT NOT NULL,
    recurrence_id TEXT,            -- set for a modified instance of a recurring event
    summary TEXT,
    description TEXT,
    location TEXT,
    start_at TEXT,                 -- ISO UTC for timed events; YYYY-MM-DD for all-day
    end_at TEXT,
    all_day INTEGER DEFAULT 0,
    timezone TEXT,                 -- TZID from the source, if any
    rrule TEXT,                    -- recurrence rule (not expanded)
    status TEXT,                   -- CONFIRMED, TENTATIVE, CANCELLED
    organizer TEXT,                -- organizer email
    is_organizer INTEGER DEFAULT 0,
    attendees TEXT,                -- JSON [{email, name, partstat, role}]
    my_response TEXT,              -- owner's PARTSTAT (ACCEPTED/DECLINED/NEEDS-ACTION/...)
    conference_url TEXT,
    created_at TEXT,
    updated_at TEXT,
    raw_json TEXT,
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_at);
