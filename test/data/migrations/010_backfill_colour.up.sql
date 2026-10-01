-- Deliberately has no .down.sql: a backfill cannot be undone, and the loader
-- has to carry that through so a rollback refuses rather than silently
-- skipping it. The version also jumps, which is what checks that ordering is
-- numeric rather than lexical -- 010 must sort after 002, not between 001
-- and 002.

UPDATE widgets SET colour = 'unspecified' WHERE colour = '';
