import { z } from 'zod';

export const taskSchema = z.object({
  title: z.string().trim().min(1, 'عنوان تسک را وارد کنید.').max(200),
  description: z.string().trim().max(5000).default(''),
  reminderAt: z.iso.datetime({ offset: true }),
}).strict();

export function serializeTask(row, maxAttempts = 10) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    recipient: row.reminder_sent_at ? row.recipient : (row.reminder_email || row.recipient),
    reminderAt: row.reminder_at,
    completedAt: row.completed_at,
    reminderSentAt: row.reminder_sent_at,
    reminderAttempts: row.reminder_attempts,
    reminderFailed: !row.reminder_sent_at && row.reminder_attempts >= maxAttempts,
    retrying: !row.reminder_sent_at && row.reminder_attempts > 0 && row.reminder_attempts < maxAttempts,
    createdAt: row.created_at,
  };
}
