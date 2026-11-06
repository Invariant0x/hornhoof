import { describe, expect, it } from 'vitest';
import { NotificationSchema } from '../src/notifications.js';

describe('internal question notification sources', () => {
  it.each(['question', 'resolved'])('keeps the actual %s cause through the wire', source => {
    const value = { source, tasks: [{ id: '00000000-0000-4000-8000-000000000001', number: 7 }] };
    expect(NotificationSchema.parse(value)).toEqual(value);
  });
  it.each(['answered', 'explain', 'reported'])('preserves the existing %s source', source => {
    const value = { source, tasks: [] };
    expect(NotificationSchema.parse(value)).toEqual(value);
  });
  it.each(['resolved_internal', 'QUESTION', 'unknown'])('refuses an unsupported source %s', source => {
    expect(NotificationSchema.safeParse({ source, tasks: [] }).success).toBe(false);
  });
});
