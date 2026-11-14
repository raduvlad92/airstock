-- Member invitations (plan M4) and the first transactional email (plan M7, E9).
--
-- The emailed link names the invitation, not a secret: accepting requires signing in with the
-- invited address, which Google, Microsoft, or an emailed code has already verified. Nothing
-- in the email can be replayed by someone who intercepts it.

create table member_invitations (
  shop_id uuid not null references shops (id),
  id uuid not null,
  email text not null check (length(email) between 3 and 320),
  -- Lower case and trimmed; compared with the signed-in user's verified email.
  email_normalized text not null,
  role text not null check (role in ('manager', 'catalog_editor', 'inventory_operator', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by_membership_id uuid not null,
  expires_at timestamptz not null,
  email_sent_at timestamptz,
  email_message_id text,
  accepted_by_user_id uuid references users (id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, invited_by_membership_id) references memberships (shop_id, id)
);

create unique index member_invitations_pending_email_idx
  on member_invitations (shop_id, email_normalized) where status = 'pending';

alter table member_invitations enable row level security;
create policy tenant_isolation on member_invitations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on member_invitations to airstock_app;

-- Someone opening an invitation link is not a member yet, so this resolves the invitation's
-- shop by its ID. Acceptance then runs inside that shop, where it checks the email.
create function invitation_shop(p_id uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select i.shop_id from member_invitations i where i.id = p_id
$$;

revoke execute on function invitation_shop(uuid) from public;
grant execute on function invitation_shop(uuid) to airstock_app;
