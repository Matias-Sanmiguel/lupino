import { describe, it, expect } from 'vitest';
import { calendarIcs, googleCalendarUrl } from '../src/lib/calendar-export';
import type { StudyEvent } from '../src/lib/types';
const exam: StudyEvent = {
  id: 'exam-1',
  title: 'Parcial',
  subject: 'Álgebra',
  date: '2026-12-31',
  time: null,
  allDay: true,
  status: 'confirmed',
  evidence: 'El parcial es el 31/12.',
  chunkId: null,
  sourceId: null,
  manuallyEdited: true,
  note: '',
};
describe('calendar handoff', () => {
  it('uses an exclusive next-day boundary across years for all-day events', () => {
    const url = new URL(googleCalendarUrl(exam));
    expect(url.origin).toBe('https://calendar.google.com');
    expect(url.searchParams.get('dates')).toBe('20261231/20270101');
    const ics = calendarIcs([exam]);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101');
  });
  it('preserves the local start instant and handles a timed event crossing midnight', () => {
    const event = { ...exam, time: '23:30', allDay: false };
    const start = new Date('2026-12-31T23:30:00');
    const dates = new URL(googleCalendarUrl(event)).searchParams.get('dates')!.split('/');
    const parse = (value: string) =>
      new Date(
        value.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'),
      ).getTime();
    expect(parse(dates[0])).toBe(start.getTime());
    expect(parse(dates[1]) - parse(dates[0])).toBe(3600000);
    expect(calendarIcs([event]).replace(/\r\n /g, '')).toContain('Duración sugerida: 1 hora.');
  });
  it('excludes unreviewed/dismissed/completed dates and deduplicates stable IDs', () => {
    const ics = calendarIcs([
      exam,
      exam,
      ...['pending', 'dismissed', 'done'].map((status) => ({ ...exam, id: status, status })),
    ]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('UID:lupino-exam-1@lupino.local');
    expect(() => googleCalendarUrl({ ...exam, status: 'pending' })).toThrow('Confirmá');
  });
  it('escapes embedded newlines and punctuation and folds UTF-8 without splitting characters', () => {
    const event = {
      ...exam,
      title: 'Álgebra, análisis; '.repeat(20),
      note: 'Texto\\nota\r\nBEGIN:VEVENT',
    };
    const ics = calendarIcs([event]);
    for (const line of ics.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).not.toContain('\r\nBEGIN:VEVENT\r\nBEGIN:VEVENT');
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DESCRIPTION:Álgebra\\n\\nTexto\\\\nota\\nBEGIN:VEVENT');
    expect(unfolded).toContain('SUMMARY:Álgebra\\, análisis\\;');
    expect(ics.match(/BEGIN:VEVENT\r\n/g)).toHaveLength(1);
    expect(new URL(googleCalendarUrl(event)).searchParams.get('text')).toBe(
      `${event.title} · ${event.subject}`,
    );
  });
});
