-- Deep Context Validation Queries
-- Run these in TablePlus or sqlite3 to inspect and validate the data
--
-- Usage: sqlite3 data/deep_context/deep_context.db < data/deep_context/validation_queries.sql
-- Or copy individual queries into TablePlus

-- ============================================================
-- OVERVIEW QUERIES
-- ============================================================

-- 1. Summary by source
SELECT
    source,
    COUNT(DISTINCT thread_id) as threads,
    COUNT(*) as messages,
    SUM(is_from_me) as my_messages
FROM messages
GROUP BY source
ORDER BY messages DESC;

-- 2. People with most interactions
SELECT
    display_name,
    thread_count,
    message_count,
    my_message_count,
    relationship_type,
    substr(last_seen, 1, 10) as last_seen
FROM people
WHERE display_name != 'YOUR_DISPLAY_NAME'
ORDER BY thread_count DESC
LIMIT 20;

-- 3. Date range by source
SELECT
    source,
    MIN(substr(timestamp, 1, 10)) as earliest,
    MAX(substr(timestamp, 1, 10)) as latest,
    COUNT(*) as messages
FROM messages
GROUP BY source;


-- ============================================================
-- TWITTER THREAD STRUCTURE (post-migration)
-- Self-reply chains are pre-grouped into threads.
-- No recursive CTEs needed — use thread_id + position_in_thread.
-- ============================================================

-- 4. View a specific Twitter thread in order
SELECT position_in_thread, is_from_me, content_type,
       substr(content, 1, 80) as content_preview
FROM messages
WHERE thread_id = 'twitter:2011625830003142723'
ORDER BY position_in_thread;

-- 5. Find largest multi-tweet threads
SELECT t.id, t.message_count, t.started_at, t.last_activity_at,
       substr(m.content, 1, 60) as first_tweet
FROM threads t
JOIN messages m ON m.thread_id = t.id AND m.position_in_thread = 1
WHERE t.source = 'twitter' AND t.thread_type = 'thread'
ORDER BY t.message_count DESC
LIMIT 20;

-- 6. Find threads with parent tweet stubs (replies to others with context)
SELECT t.id, t.message_count,
       stub.content as stub_content,
       substr(reply.content, 1, 60) as reply_preview
FROM threads t
JOIN messages stub ON stub.thread_id = t.id AND stub.is_from_me = 0
JOIN messages reply ON reply.thread_id = t.id AND reply.is_from_me = 1
WHERE t.source = 'twitter'
ORDER BY reply.timestamp DESC
LIMIT 20;

-- 7. Thread structure integrity check
SELECT
    SUM(CASE WHEN t.thread_type = 'standalone' THEN 1 ELSE 0 END) as standalone_threads,
    SUM(CASE WHEN t.thread_type = 'thread' THEN 1 ELSE 0 END) as multi_tweet_threads,
    SUM(CASE WHEN m_stubs.cnt > 0 THEN 1 ELSE 0 END) as threads_with_stubs
FROM threads t
LEFT JOIN (
    SELECT thread_id, COUNT(*) as cnt FROM messages
    WHERE source = 'twitter' AND is_from_me = 0 AND content_type != 'dm'
    GROUP BY thread_id
) m_stubs ON m_stubs.thread_id = t.id
WHERE t.source = 'twitter';


-- ============================================================
-- TWITTER DM RECONSTRUCTION
-- ============================================================

-- 7. Find DM conversations with substantial back-and-forth
SELECT
    t.id,
    t.message_count,
    t.my_message_count,
    t.message_count - t.my_message_count as other_messages,
    substr(t.started_at, 1, 10) as started,
    substr(t.last_activity_at, 1, 10) as last_activity
FROM threads t
WHERE t.source = 'twitter-dm'
  AND t.message_count >= 10
  AND t.my_message_count >= 3
  AND (t.message_count - t.my_message_count) >= 3
ORDER BY t.message_count DESC
LIMIT 20;

-- 8. Reconstruct a DM conversation
-- Replace thread_id with one from query above
SELECT
    m.position_in_thread as pos,
    substr(m.timestamp, 1, 16) as time,
    CASE WHEN m.is_from_me THEN 'Owner' ELSE 'Other' END as sender,
    substr(m.content, 1, 100) as message
FROM messages m
WHERE m.thread_id = 'twitter-dm:EXAMPLE_ID'  -- Change this
ORDER BY m.position_in_thread
LIMIT 50;

-- 9. Find recent DM activity
SELECT
    t.id,
    t.message_count,
    substr(t.last_activity_at, 1, 10) as last_activity,
    (SELECT substr(content, 1, 60)
     FROM messages
     WHERE thread_id = t.id
     ORDER BY position_in_thread DESC LIMIT 1) as last_message
FROM threads t
WHERE t.source = 'twitter-dm'
ORDER BY t.last_activity_at DESC
LIMIT 20;


-- ============================================================
-- CALL TRANSCRIPT RECONSTRUCTION
-- ============================================================

-- 10. Find calls with transcripts
SELECT
    t.id,
    t.title,
    t.message_count as speaker_turns,
    t.my_message_count as owner_turns,
    substr(t.started_at, 1, 10) as date
FROM threads t
WHERE t.source = 'calls'
  AND t.message_count > 10
ORDER BY t.started_at DESC
LIMIT 20;

-- 11. Reconstruct a call transcript
-- Replace thread_id with one from query above
SELECT
    m.position_in_thread as pos,
    p.display_name as speaker,
    CASE WHEN m.is_from_me THEN '→' ELSE '' END as me,
    substr(m.content, 1, 100) as speech
FROM messages m
LEFT JOIN people p ON m.sender_id = p.id
WHERE m.thread_id = 'calls:01KFVCXF4ZBZGV7GXD7RQN6HHC'  -- Change this
ORDER BY m.position_in_thread
LIMIT 50;

-- 12. Find calls by participant name
SELECT
    t.id,
    t.title,
    t.message_count,
    substr(t.started_at, 1, 10) as date
FROM threads t
WHERE t.source = 'calls'
  AND t.title LIKE '%EXAMPLE_CONTACT%'  -- Change search term
ORDER BY t.started_at DESC;


-- ============================================================
-- DATA INTEGRITY CHECKS
-- ============================================================

-- 13. Orphaned messages (should be 0)
SELECT 'Orphaned messages (no thread)' as check_name,
       COUNT(*) as count
FROM messages m
WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = m.thread_id);

-- 14. Thread message counts match (should be 0)
SELECT 'Threads with wrong message_count' as check_name,
       COUNT(*) as count
FROM threads t
WHERE t.message_count != (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id);

-- 15. Messages without sender (acceptable for some sources)
SELECT source, COUNT(*) as no_sender
FROM messages
WHERE sender_id IS NULL OR sender_id = ''
GROUP BY source;

-- 16. Empty content messages
SELECT source, COUNT(*) as empty_content
FROM messages
WHERE content IS NULL OR content = '' OR length(content) < 2
GROUP BY source;


-- ============================================================
-- USEFUL ANALYSIS QUERIES
-- ============================================================

-- 17. Message volume by month
SELECT
    substr(timestamp, 1, 7) as month,
    source,
    COUNT(*) as messages,
    SUM(is_from_me) as my_messages
FROM messages
WHERE timestamp >= '2024-01-01'
GROUP BY month, source
ORDER BY month DESC, messages DESC;

-- 18. Word count distribution for my messages
SELECT
    source,
    MIN(word_count) as min_words,
    AVG(word_count) as avg_words,
    MAX(word_count) as max_words,
    COUNT(*) as messages
FROM messages
WHERE is_from_me = 1 AND word_count > 0
GROUP BY source;

-- 19. Longest messages (potential high-quality writing samples)
SELECT
    source,
    substr(timestamp, 1, 10) as date,
    word_count,
    substr(content, 1, 100) as preview
FROM messages
WHERE is_from_me = 1
ORDER BY word_count DESC
LIMIT 20;

-- 20. Find messages by content search
SELECT
    source,
    substr(timestamp, 1, 10) as date,
    substr(content, 1, 100) as preview
FROM messages
WHERE is_from_me = 1
  AND content LIKE '%AI safety%'  -- Change search term
ORDER BY timestamp DESC
LIMIT 20;
