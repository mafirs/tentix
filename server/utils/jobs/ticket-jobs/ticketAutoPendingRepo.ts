import { sql } from "drizzle-orm";
import { connectDB } from "@/utils/tools";

export type DB = ReturnType<typeof connectDB>;

export async function findAndMarkCustomerReplyPendingTickets(
  db: DB,
  timeoutMinutes = 10,
): Promise<string[]> {
  const safeTimeoutMinutes =
    Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? Math.floor(timeoutMinutes)
      : 10;

  const res = await db.execute(sql`
    WITH latest_messages AS (
      SELECT DISTINCT ON (ticket_id)
        ticket_id,
        sender_id,
        created_at,
        id
      FROM tentix.chat_messages
      ORDER BY ticket_id, created_at DESC, id DESC
    ),
    eligible_tickets AS (
      SELECT t.id
      FROM tentix.tickets t
      JOIN latest_messages lm ON t.id = lm.ticket_id
      WHERE t.status = 'in_progress'
        AND lm.sender_id = t.customer_id
        AND lm.created_at <= NOW() - (${safeTimeoutMinutes} * INTERVAL '1 minute')
      FOR UPDATE OF t SKIP LOCKED
    )
    UPDATE tentix.tickets
    SET status = 'pending',
        updated_at = NOW()
    FROM eligible_tickets
    WHERE tentix.tickets.id = eligible_tickets.id
    RETURNING tentix.tickets.id;
  `);

  const updated: Array<{ id: string }> = Array.isArray(res)
    ? (res as unknown as Array<{ id: string }>)
    : ((res as unknown as { rows?: Array<{ id: string }> }).rows ?? []);

  return updated.map((r) => r.id).filter(Boolean);
}
