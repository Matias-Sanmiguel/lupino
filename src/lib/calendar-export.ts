import type { StudyEvent } from './types';

function day(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
function stamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
function boundaries(event: StudyEvent) {
  const date = new Date(`${event.date}T${event.time || '12:00'}:00`);
  if (!Number.isFinite(date.getTime())) throw new Error('La fecha no es válida.');
  if (!event.time) {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    return { start: day(date), end: day(next), allDay: true };
  }
  return { start: stamp(date), end: stamp(new Date(date.getTime() + 3600000)), allDay: false };
}
function description(event: StudyEvent) {
  return [
    event.subject,
    event.note,
    event.evidence && `Fuente: ${event.evidence}`,
    event.time && 'Duración sugerida: 1 hora. Revisala al guardar.',
    'Exportado desde Lupino. Los cambios posteriores no se sincronizan.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
export function googleCalendarUrl(event: StudyEvent) {
  if (event.status !== 'confirmed')
    throw new Error('Confirmá la fecha antes de agregarla a Google Calendar.');
  const { start, end } = boundaries(event);
  const query = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${event.title} · ${event.subject}`,
    dates: `${start}/${end}`,
    details: description(event),
  });
  return `https://calendar.google.com/calendar/render?${query}`;
}
function escape(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}
function fold(line: string) {
  const encoder = new TextEncoder();
  let result = '',
    current = '',
    bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      result += current + '\r\n';
      current = ' ';
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  return result + current;
}
export function calendarIcs(events: StudyEvent[], now = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lupino//Calendario de estudio//ES',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Lupino',
  ];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.status !== 'confirmed' || seen.has(event.id)) continue;
    seen.add(event.id);
    const { start, end, allDay } = boundaries(event);
    const type = allDay ? ';VALUE=DATE' : '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:lupino-${encodeURIComponent(event.id)}@lupino.local`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART${type}:${start}`,
      `DTEND${type}:${end}`,
      `SUMMARY:${escape(`${event.title} · ${event.subject}`)}`,
      `DESCRIPTION:${escape(description(event))}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }
  return lines.map(fold).join('\r\n') + '\r\n';
}
