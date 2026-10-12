// calendar_events — Google Calendar events imported from Takeout .ics files (import-takeout.ts).
// Shared by deep-context.ts (additive migration in getDb) and import-takeout.ts. Mirrored in schema.sql.

export const CALENDAR_SCHEMA = `
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
`
