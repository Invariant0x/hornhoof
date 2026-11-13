-- The bends each person put on the lines of their company map, kept with where they put its blocks.
ALTER TABLE "map_layouts" ADD COLUMN "anchors" jsonb DEFAULT '{}'::jsonb NOT NULL;