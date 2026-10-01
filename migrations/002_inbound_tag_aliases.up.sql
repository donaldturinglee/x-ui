-- Old names remain reserved even after an inbound is deleted: an offline node
-- can still retry traffic measured under them, so assigning one to another
-- listener would mix their accounting. The stable id resolves repeated renames.
CREATE TABLE inbound_tag_aliases (
    tag        varchar(64) PRIMARY KEY,
    inbound_id bigint NOT NULL
);
CREATE INDEX idx_inbound_tag_aliases_inbound_id ON inbound_tag_aliases (inbound_id);
INSERT INTO inbound_tag_aliases (tag, inbound_id) SELECT tag, id FROM inbounds;
