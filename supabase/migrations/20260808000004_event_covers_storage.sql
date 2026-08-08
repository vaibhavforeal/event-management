-- Cover images for events.
--
-- The path is keyed by the uploader's uid, NOT by event id:
--   event-covers/{auth.uid()}/{random}.jpg
-- That is what lets a host attach an image before the event row exists, which
-- keeps event creation to a single save. The cost is that abandoned drafts
-- leave orphaned objects; at pilot volume that is cheaper to tolerate than to
-- reap, and it is a known limitation rather than an oversight.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-covers',
  'event-covers',
  true,                                                  -- the event page is public, so the cover must be
  5242880,                                               -- 5 MiB; phone photos arrive large
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Reads are scoped to the caller's own folder, and this is NOT what makes covers
-- visible on an event page. `public = true` above is; storage-api serves
-- /object/v1/public/... straight off that flag without consulting RLS at all.
--
-- What this policy defends is the enumeration route. Left as
-- `using (bucket_id = 'event-covers')`, an anonymous caller could `.list('')`
-- and get back every host's uid folder, then `.list('<uid>')` and get every
-- filename inside it. That leaks the covers of DRAFT events — which
-- events_select_published deliberately hides at the row level — so a host's
-- unpublished artwork, and the fact that they are planning anything at all,
-- would be discoverable by a stranger. Scoping the folder the same way the
-- write policies do closes listing without touching the public URL.
--
-- Be clear about the size of this: it removes discovery, not access. Anyone
-- holding the exact object path can still fetch it through the public route,
-- by design. Draft covers are unguessable, not confidential — so do not put
-- anything genuinely secret in this bucket.
--
-- Deliberately NOT `to authenticated`: the policy must still apply to anon so
-- that the folder comparison is what denies them (auth.uid() is NULL, so the
-- equality is NULL, so no row matches). Restricting the role instead would
-- deny anon a step earlier and leave the folder clause below untested.
create policy "hosts read and list their own covers"
  on storage.objects for select
  using (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Writes are confined to a folder named after the caller's own uid.
--
-- `to authenticated` here is redundant defence-in-depth, not the control doing
-- the work: an anon caller has a NULL auth.uid(), so the folder comparison is
-- already NULL and already denies them. Widening these three to
-- `to anon, authenticated` changes no observable behaviour. Keep the role
-- clause — it states the intent — but do not mistake it for the guard.
create policy "hosts upload into their own cover folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "hosts replace their own covers"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "hosts delete their own covers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
