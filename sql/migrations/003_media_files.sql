-- Extends media_assets. Does not add a second media table and does not store file bytes.

ALTER TABLE media_assets
  ADD COLUMN original_filename text NOT NULL DEFAULT '',
  ADD COLUMN visibility text NOT NULL DEFAULT 'private',
  ADD COLUMN variant text NOT NULL DEFAULT 'original',
  ADD COLUMN derivative_of_id uuid;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_visibility_known CHECK (visibility IN ('private', 'public')),
  ADD CONSTRAINT media_assets_variant_known CHECK (variant IN ('original', 'thumbnail')),
  ADD CONSTRAINT media_assets_filename_safe CHECK (
    original_filename !~ '[\\/]' AND original_filename !~ '\.\.'
  ),
  ADD CONSTRAINT media_assets_storage_key_safe CHECK (
    storage_key !~ '\.\.'
    AND storage_key !~ '^[\\/]'
    AND storage_key !~ '[\\]'
  ),
  ADD CONSTRAINT media_assets_derivative_shape CHECK (
    (variant = 'original' AND derivative_of_id IS NULL)
    OR (variant = 'thumbnail' AND derivative_of_id IS NOT NULL)
  );

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_derivative_of_fk
  FOREIGN KEY (derivative_of_id) REFERENCES media_assets (id) ON DELETE CASCADE;

CREATE INDEX media_assets_derivative_idx ON media_assets (derivative_of_id);
