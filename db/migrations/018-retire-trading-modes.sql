                                                                           
                                                                
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
DELETE FROM settings WHERE id IN ('marketplace.kill_switch','marketplace.dry_run','sales.dryRun','marketplace.live_requested');
UPDATE rollout_control SET stage='LIVE',killed=0,reason=NULL;
