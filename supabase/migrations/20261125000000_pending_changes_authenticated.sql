-- 見積もりを Google ログインにすると、画面からの読み書きが authenticated の立場になるため、同じ権限を足す（anon はそのまま）
create policy pending_changes_authenticated_all on public.pending_changes for all to authenticated using (true) with check (true);
