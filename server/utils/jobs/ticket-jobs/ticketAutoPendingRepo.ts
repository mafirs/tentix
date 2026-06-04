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
    WITH ticket_message_state AS (
      SELECT
        t.id AS ticket_id,
        MAX(cm.created_at) FILTER (
          WHERE cm.sender_id = t.customer_id
        ) AS last_customer_message_at,
        MAX(cm.created_at) FILTER (
          WHERE cm.sender_id = t.agent_id
            OR EXISTS (
              SELECT 1
              FROM tentix.technicians_to_tickets tt
              WHERE tt.ticket_id = t.id
                AND tt.user_id = cm.sender_id
            )
        ) AS last_member_reply_at
      FROM tentix.tickets t
      LEFT JOIN tentix.chat_messages cm ON (
        cm.ticket_id = t.id
        AND cm.is_internal = false
        AND cm.withdrawn = false
      )
      WHERE t.status = 'in_progress'
      GROUP BY t.id, t.customer_id, t.agent_id
    ),
    eligible_tickets AS (
      SELECT t.id
      FROM tentix.tickets t
      JOIN ticket_message_state tms ON t.id = tms.ticket_id
      WHERE t.status = 'in_progress'
        AND tms.last_customer_message_at IS NOT NULL
        AND tms.last_customer_message_at <= NOW() - (${safeTimeoutMinutes} * INTERVAL '1 minute')
        AND (
          tms.last_member_reply_at IS NULL
          OR tms.last_member_reply_at < tms.last_customer_message_at
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tentix.ticket_history th
          WHERE th.ticket_id = t.id
            AND (
              th.type IN ('close', 'resolve')
              OR (
                th.type = 'update'
                AND th.description IN ('关闭工单', 'Close ticket', 'Close Ticket')
              )
            )
        )
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
