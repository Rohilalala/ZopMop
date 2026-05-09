-- demand_snapshots was superseded by Redis sorted-set heatmaps (TrackDemand/GetHeatmap).
-- No Go code writes to this table; drop it to reduce schema noise.
DROP TABLE IF EXISTS demand_snapshots;
