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

-- Anyone may look at a cover. There is nothing private in one, and the event
-- page must render for a visitor with no session.
create policy "event covers are publicly readable"
  on storage.objects for select
  using (bucket_id = 'event-covers');

-- Writes are confined to a folder named after the caller's own uid.
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
