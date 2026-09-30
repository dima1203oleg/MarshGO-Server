import type { Pool, PoolClient } from 'pg';

export type ExpiredProposal = {
  id: string;
  demand_id: string;
  driver_id: string;
  passenger_id: string;
};

/** Atomically expires due negotiations and queues one event for both participants. */
export async function expireDueProposals(
  pool: Pool,
  enqueue: (client: PoolClient, proposal: ExpiredProposal) => Promise<void>,
  batchSize = 100,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ExpiredProposal>(
      `WITH due AS (
         SELECT p.id
           FROM proposals p
           JOIN passenger_demands d ON d.id=p.demand_id
          WHERE p.status='pending' AND p.expires_at<=now() AND d.status='open'
          ORDER BY p.expires_at,p.id
          FOR UPDATE OF p SKIP LOCKED
          LIMIT $1
       )
       UPDATE proposals p SET status='expired'
         FROM due,passenger_demands d
        WHERE p.id=due.id AND d.id=p.demand_id
       RETURNING p.id,p.demand_id,p.driver_id,d.passenger_id`,
      [Math.max(1, Math.min(500, Math.trunc(batchSize)))],
    );
    for (const proposal of rows) await enqueue(client, proposal);
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
