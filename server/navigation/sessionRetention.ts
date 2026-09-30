import type { Pool } from 'pg';

export type NavigationRetentionResult = { clearedLocations: number; endedSessions: number };

/**
 * Expire precise position independently from navigation lifecycle. Losing GPS
 * or connectivity must not delete an active route that the client can resume.
 * End abandoned sessions after one day of server-side activity silence.
 */
export async function retainNavigationSessions(pool: Pick<Pool, 'query'>): Promise<NavigationRetentionResult> {
  const locations = await pool.query(
    `UPDATE navigation_sessions
        SET current_location=NULL,current_location_accuracy_m=NULL,current_location_at=NULL
      WHERE state IN ('active','paused')
        AND current_location_at<now()-interval '2 minutes'`,
  );
  const ended = await pool.query(
    `WITH expired AS (
       UPDATE navigation_sessions
          SET state='ended',opt_in=false,ended_at=now(),destination_name=NULL,destination=NULL,route=NULL,
              current_location=NULL,current_location_accuracy_m=NULL,current_location_at=NULL
        WHERE state IN ('active','paused') AND last_activity_at<now()-interval '24 hours'
        RETURNING driver_id,id
     )
     INSERT INTO audit_events(actor_id,action,entity_type,entity_id)
       SELECT driver_id,'navigation.expired','navigation_session',id FROM expired`,
  );
  return { clearedLocations: locations.rowCount ?? 0, endedSessions: ended.rowCount ?? 0 };
}
