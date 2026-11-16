-- Phase 2 groundwork (plan I0): the largest media original per shop (D19), and the connection
-- that replaced a revoked one (D20). Both are small, so they share this migration.

-- The longest side, in pixels, of an image original the shop keeps. The dashboard shrinks larger
-- pictures before uploading them, and the upload refuses a larger original from any client. Null
-- keeps originals at full size. Existing shops get the default, as new ones do.
alter table shops add column media_original_max_side integer default 2048
  check (media_original_max_side in (1024, 2048, 4096));

-- A new consent from the same person, for the same OAuth client and shop, revokes the earlier
-- connections when its first token binds it (D20). Each revoked grant names its replacement, so
-- the dashboard can say why it stopped.
alter table connection_grants add column replaced_by uuid;
alter table connection_grants add constraint connection_grants_replaced_by_fkey
  foreign key (shop_id, replaced_by) references connection_grants (shop_id, id);

-- Binding looks up the same person's other connections from the same client.
create index connection_grants_member_client_idx on connection_grants (membership_id, client_id)
  where status = 'active';
