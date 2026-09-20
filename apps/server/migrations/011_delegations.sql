-- Delegation stages reuse the existing runner registry: an executor advertises its own additive
-- inventory (`delegation:stages:v1`) next to the chat inventory it already publishes.
alter table runners add column delegation_capabilities jsonb;
alter table runners add column delegation_seen_at timestamptz;
