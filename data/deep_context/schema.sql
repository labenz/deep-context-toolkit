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

    -- AI-generated thread-level enrichment
    enriched_topic TEXT,         -- Main topic/summary of the thread
    enriched_type TEXT,          -- question, discussion, coordination, broadcast, support, sales, interview, other
    enriched_relationship TEXT,  -- peer, mentor, mentee, customer, provider, collaborator, stranger, family, friend
    enriched_at DATETIME
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
-- AI-GENERATED METADATA (ONLY for the owner's messages)
-- Consolidated schema: 10 core fields using scores instead of booleans
-- ============================================================

CREATE TABLE IF NOT EXISTS message_metadata (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),

    -- Core quality scores (1-7 scales for granularity)
    quality_score REAL,        -- Overall quality: voice, insight, craft (1=filler, 4=solid, 7=exceptional)
    authorship_score REAL,     -- Confidence the owner wrote this vs quoted/LLM/forwarded (0-1)
    originality_score REAL,    -- Intellectual uniqueness (1=common wisdom, 4=thoughtful, 7=unique insight)

    -- Classification
    topics TEXT,               -- JSON array of topic tags
    domain TEXT,               -- ai, business, personal, podcast, health, technical, other

    -- Engagement metrics (1-7 scales)
    sentiment REAL,            -- Tone from negative to positive (-1 to 1)
    engagement REAL,           -- Energy/emotion level (1=low-key, 4=engaged, 7=highly passionate)
    actionability REAL,        -- Contains decisions/commitments/action items (1=pure info, 7=highly actionable)

    -- Entity extraction
    entities TEXT,             -- JSON array: people, companies, products mentioned

    -- Style
    style_tags TEXT,           -- JSON array: formal, casual, technical, humor, emphatic, etc.

    -- Thread context
    thread_role TEXT,          -- initiator, responder
    relationship_dynamic TEXT, -- peer, mentor, mentee, customer, provider, collaborator, stranger, family, friend

    -- Processing info
    processed_at DATETIME,
    processor_model TEXT       -- e.g., 'gemini-3-flash'
);

-- ============================================================
-- HIGH-LEVEL SYNTHESES
-- ============================================================

CREATE TABLE IF NOT EXISTS syntheses (
    id TEXT PRIMARY KEY,
    synthesis_type TEXT NOT NULL,  -- timeline, relationship, project, preferences, thinking
    reference_id TEXT,  -- For relationship: person_id; For project: project_id
    time_range_start DATETIME,
    time_range_end DATETIME,
    content TEXT,  -- The actual summary content (markdown)
    source_message_ids TEXT,  -- JSON array of message IDs used
    created_at DATETIME,
    updated_at DATETIME,
    version INTEGER DEFAULT 1
);

-- Projects extracted from communications
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT,  -- active, completed, abandoned, on_hold
    start_date DATETIME,
    end_date DATETIME,
    collaborator_ids TEXT,  -- JSON array of person IDs
    related_organizations TEXT,
    project_summary TEXT,
    summary_updated_at DATETIME
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

-- ============================================================
-- CONTACT UNIFICATION TABLES
-- ============================================================

-- Canonical unified contacts (one per real person)
CREATE TABLE IF NOT EXISTS unified_contacts (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    canonical_email TEXT,
    canonical_phone TEXT,
    canonical_twitter TEXT,
    organization TEXT,
    title TEXT,
    relationship_type TEXT,
    relationship_summary TEXT,
    notes TEXT,

    -- Aggregated from linked people
    total_thread_count INTEGER DEFAULT 0,
    total_message_count INTEGER DEFAULT 0,
    first_seen DATETIME,
    last_seen DATETIME,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Links people records to unified contacts
CREATE TABLE IF NOT EXISTS contact_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unified_contact_id TEXT NOT NULL REFERENCES unified_contacts(id),
    person_id TEXT NOT NULL REFERENCES people(id),
    confidence REAL DEFAULT 1.0,
    link_type TEXT DEFAULT 'confirmed',  -- 'confirmed', 'suggested', 'auto'
    match_reason TEXT,                    -- JSON: signals that suggested match
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(person_id)
);

-- Rejected matches ("definitely not the same person")
CREATE TABLE IF NOT EXISTS contact_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id_1 TEXT NOT NULL,
    person_id_2 TEXT NOT NULL,
    rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason TEXT,
    UNIQUE(person_id_1, person_id_2)
);

-- Suggested matches awaiting review
CREATE TABLE IF NOT EXISTS contact_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id_1 TEXT NOT NULL,
    person_id_2 TEXT NOT NULL,
    confidence REAL NOT NULL,
    match_signals TEXT,                   -- JSON: heuristic signals
    llm_reasoning TEXT,                   -- LLM explanation if used
    status TEXT DEFAULT 'pending',        -- 'pending', 'accepted', 'rejected'
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(person_id_1, person_id_2)
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
CREATE INDEX IF NOT EXISTS idx_metadata_domain ON message_metadata(domain);
CREATE INDEX IF NOT EXISTS idx_metadata_processed ON message_metadata(processed_at);

CREATE INDEX IF NOT EXISTS idx_syntheses_type ON syntheses(synthesis_type);
CREATE INDEX IF NOT EXISTS idx_syntheses_reference ON syntheses(reference_id);

CREATE INDEX IF NOT EXISTS idx_extraction_source ON extraction_log(source);
CREATE INDEX IF NOT EXISTS idx_extraction_status ON extraction_log(status);

CREATE INDEX IF NOT EXISTS idx_contact_links_unified ON contact_links(unified_contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_links_person ON contact_links(person_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON contact_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_confidence ON contact_suggestions(confidence DESC);

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

-- Unified people view (combines unified_contacts with unlinked people)
CREATE VIEW IF NOT EXISTS v_unified_people AS
SELECT
    uc.id as unified_id,
    uc.canonical_name as name,
    uc.canonical_email as email,
    uc.canonical_phone as phone,
    uc.canonical_twitter as twitter,
    uc.organization,
    uc.title,
    uc.relationship_type,
    uc.total_thread_count,
    uc.total_message_count,
    uc.first_seen,
    uc.last_seen,
    GROUP_CONCAT(cl.person_id) as linked_person_ids,
    COUNT(cl.person_id) as source_count
FROM unified_contacts uc
LEFT JOIN contact_links cl ON uc.id = cl.unified_contact_id
GROUP BY uc.id

UNION ALL

-- Include unlinked people (not yet unified)
SELECT
    p.id as unified_id,
    p.display_name as name,
    JSON_EXTRACT(p.identifiers, '$[0]') as email,
    NULL as phone,
    NULL as twitter,
    p.organization,
    p.title,
    p.relationship_type,
    p.thread_count as total_thread_count,
    p.message_count as total_message_count,
    p.first_seen,
    p.last_seen,
    p.id as linked_person_ids,
    1 as source_count
FROM people p
WHERE p.id NOT IN (SELECT person_id FROM contact_links);

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
