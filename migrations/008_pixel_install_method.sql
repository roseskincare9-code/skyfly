-- How the owner installed each pixel: by typing its ID, or by pasting the platform's
-- base code (Skyfly keeps only the Pixel ID taken from it; the pasted code is never stored or run).
ALTER TABLE pixel_settings
  ADD COLUMN install_method TEXT NOT NULL DEFAULT 'id' CHECK (install_method IN ('id', 'code'));
