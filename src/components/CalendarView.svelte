<script lang="ts">
  import { modalFocus } from '../lib/modal';
  import { disclosure } from '../lib/disclosure';
  import { calendarIcs, googleCalendarUrl } from '../lib/calendar-export';
  import {
    ChevronLeft,
    ChevronRight,
    Plus,
    CalendarDays,
    Check,
    Quote,
    Pencil,
    Download,
    ExternalLink,
  } from 'lucide-svelte';
  import type { StudyEvent } from '../lib/types';
  import { command, openExternal } from '../lib/api';
  let {
    events,
    onrefresh,
    onsource,
    onerror,
  }: {
    events: StudyEvent[];
    onrefresh: () => Promise<void>;
    onsource: (id: string) => void;
    onerror: (e: unknown) => void;
  } = $props();
  let month = $state(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  let selected = $state<StudyEvent | null>(null);
  let editing = $state(false);
  let saving = $state(false);
  let layout = $state<'agenda' | 'month'>('agenda');
  let onlyUpcoming = $state(true);
  let exporting = $state(false);
  let exportNotice = $state('');
  const exportEvents = $derived(
    events.filter((e) => e.status === 'confirmed' && (!onlyUpcoming || e.date >= today)),
  );
  async function exportAll() {
    exporting = true;
    exportNotice = '';
    try {
      const path = await command<string | null>('export_calendar', {
        contents: calendarIcs(exportEvents),
      });
      if (path)
        exportNotice = `Guardadas ${exportEvents.length} fechas. Importá el archivo en Google Calendar → Configuración → Importar y exportar.`;
    } catch (e) {
      onerror(e);
    } finally {
      exporting = false;
    }
  }
  let monthKey = $derived(
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
  );
  let monthEvents = $derived(
    events
      .filter((e) => e.status !== 'dismissed' && e.date.startsWith(monthKey))
      .sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`)),
  );
  function selectEvent(event: StudyEvent) {
    selected = { ...event };
    editing = false;
  }
  let days = $derived.by(() => {
    const start = new Date(month);
    start.setDate(1 - ((month.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        number: d.getDate(),
        current: d.getMonth() === month.getMonth(),
      };
    });
  });
  const today = new Date().toLocaleDateString('en-CA');
  function move(n: number) {
    month = new Date(month.getFullYear(), month.getMonth() + n, 1);
  }
  function create(date = today) {
    selected = {
      id: '',
      title: '',
      subject: '',
      kind: 'entrega',
      date,
      time: null,
      allDay: true,
      status: 'confirmed',
      evidence: '',
      chunkId: null,
      sourceId: null,
      manuallyEdited: true,
      note: '',
    };
    editing = true;
  }
  async function save(status?: string) {
    if (!selected) return;
    saving = true;
    try {
      await command('save_event', {
        event: {
          ...selected,
          status: status ?? selected.status,
          manuallyEdited: true,
          allDay: !selected.time,
        },
      });
      await onrefresh();
      selected = null;
      editing = false;
    } catch (e) {
      onerror(e);
    } finally {
      saving = false;
    }
  }
</script>

<section class="page calendar-page">
  <header class="page-heading">
    <div>
      <h1>Calendario</h1>
    </div>
    <div class="actions calendar-actions">
      <details class="calendar-export" use:disclosure>
        <summary class="button secondary"><Download size={15} />Google Calendar</summary>
        <div class="export-controls">
          <h2>Exportar fechas</h2>
          <label class="check-label"
            ><input type="checkbox" bind:checked={onlyUpcoming} />Solo próximas</label
          >
          <p class="muted small">
            {exportEvents.length} fechas confirmadas. Las propuestas por revisar quedan fuera.
          </p>
          <button
            class="button primary"
            disabled={exporting || !exportEvents.length}
            onclick={exportAll}>{exporting ? 'Exportando…' : 'Guardar archivo .ics'}</button
          >
          <p class="muted small">
            Importalo en Google Calendar → Configuración → Importar y exportar. Las fechas con hora
            usan una duración sugerida de una hora. Los cambios posteriores no se sincronizan.
          </p>
          {#if exportNotice}<p role="status" class="notice success">{exportNotice}</p>{/if}
        </div>
      </details>
      <button class="button primary" onclick={() => create()}
        ><Plus size={16} />Agregar fecha</button
      >
    </div>
  </header>
  <div class="calendar-toolbar">
    <div class="month-title">
      <h2>{month.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}</h2>
      <button class="icon-button" onclick={() => move(-1)} aria-label="Mes anterior"
        ><ChevronLeft size={19} /></button
      ><button class="icon-button" onclick={() => move(1)} aria-label="Mes siguiente"
        ><ChevronRight size={19} /></button
      ><button
        class="text-button"
        onclick={() => (month = new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >Hoy</button
      >
    </div>
    <div class="segmented" role="group" aria-label="Vista del calendario">
      <button aria-pressed={layout === 'agenda'} onclick={() => (layout = 'agenda')}>Agenda</button>
      <button aria-pressed={layout === 'month'} onclick={() => (layout = 'month')}>Mes</button>
    </div>
  </div>
  {#if layout === 'agenda'}
    <div class="agenda-list">
      {#each monthEvents as event (event.id)}
        <button
          class="agenda-row"
          class:done={event.status === 'done'}
          onclick={() => selectEvent(event)}
        >
          <span class="agenda-date">
            <strong>{Number(event.date.slice(-2))}</strong>
            <span
              >{new Date(`${event.date}T12:00:00`).toLocaleDateString('es-AR', {
                weekday: 'short',
              })}</span
            >
          </span>
          <span class="agenda-description"
            ><strong>{event.title}</strong><span>{event.subject}</span></span
          >
          <span class="agenda-meta">
            {#if event.status === 'pending'}<span class="review-label">Por revisar</span>
            {:else if event.status === 'done'}<span>Realizada</span>{/if}
            <span>{event.time || 'Sin horario'}</span>
          </span>
          <ChevronRight size={16} />
        </button>
      {:else}
        <div class="empty-state">
          <CalendarDays size={24} strokeWidth={1.5} />
          <h2>No hay fechas este mes</h2>
          <p>Agregá una fecha o revisá otro mes.</p>
        </div>
      {/each}
    </div>
  {:else}
    <div class="calendar-grid">
      {#each ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as day}<div class="weekday">
          {day}
        </div>{/each}{#each days as day}<div class:outside={!day.current} class="calendar-day">
          <button
            class:today={day.date === today}
            class="day-number"
            onclick={() => create(day.date)}
            aria-label={`Agregar fecha el ${day.date}`}>{day.number}</button
          >{#each events.filter((e) => e.date === day.date && e.status !== 'dismissed') as event}<button
              class="calendar-event"
              class:pending={event.status === 'pending'}
              class:exam={event.kind !== 'entrega'}
              class:done={event.status === 'done'}
              title={`${event.title} · ${event.subject}${event.status === 'pending' ? ' · Por revisar' : ''}`}
              aria-label={`${event.time ? `${event.time} · ` : ''}${event.title} · ${event.subject}${event.status === 'pending' ? ' · Por revisar' : ''}`}
              onclick={() => selectEvent(event)}
              ><span>{event.time || ''} {event.title}</span><small>{event.subject}</small>
              {#if event.status === 'pending'}<small class="review-label">Por revisar</small
                >{/if}</button
            >{/each}
        </div>{/each}
    </div>
  {/if}
  <p class="calendar-foot">
    Los avisos funcionan con Lupino abierto. Las fechas por revisar necesitan confirmación.
  </p>
</section>
{#if selected}<div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) selected = null;
    }}
  >
    <div
      class="modal"
      use:modalFocus={() => (selected = null)}
      role="dialog"
      aria-modal="true"
      aria-label="Detalle de fecha"
      tabindex="-1"
    >
      <div class="section-line">
        <h2>{editing ? 'Editar fecha' : selected.title}</h2>
        <button class="text-button" onclick={() => (selected = null)}>Cerrar</button>
      </div>
      {#if editing}<form
          onsubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label
            >Título<input
              required
              bind:value={selected.title}
              placeholder="Entrega del trabajo práctico"
            /></label
          >
          <div class="form-row">
            <label>Materia<input required bind:value={selected.subject} /></label><label
              >Tipo<select bind:value={selected.kind}
                ><option value="entrega">Entrega</option><option value="parcial">Parcial</option
                ><option value="final">Final</option></select
              ></label
            >
          </div>
          <div class="form-row">
            <label>Fecha<input type="date" required bind:value={selected.date} /></label><label
              >Hora (opcional)<input
                type="time"
                value={selected.time ?? ''}
                oninput={(e) => {
                  if (selected) selected.time = e.currentTarget.value || null;
                }}
              /></label
            >
          </div>
          <label>Notas<textarea bind:value={selected.note} rows="3"></textarea></label><button
            class="button primary"
            disabled={saving}>Guardar fecha</button
          >
        </form>{:else}<p class="muted">
          {selected.subject} · {selected.date}
          {selected.time ?? '· Todo el día'}
        </p>
        <span class="tag"
          >{selected.status === 'pending'
            ? 'Pendiente de revisión'
            : selected.status === 'done'
              ? 'Realizada'
              : 'Confirmada'}</span
        >{#if selected.evidence}<div class="event-evidence">
            <Quote size={18} />
            <p>{selected.evidence}</p>
            {#if selected.sourceId}<button
                class="text-button"
                onclick={() => {
                  if (selected?.sourceId) onsource(selected.sourceId);
                  selected = null;
                }}>Ver fuente</button
              >{/if}
          </div>{/if}{#if selected.note}<p>{selected.note}</p>{/if}
        <div class="actions wrap">
          <button
            class="button secondary"
            disabled={selected.status !== 'confirmed'}
            title={selected.status !== 'confirmed'
              ? 'Confirmá la fecha antes de agregarla'
              : 'Abrir y revisar antes de guardar en Google Calendar'}
            onclick={() => {
              try {
                if (selected) openExternal(googleCalendarUrl(selected)).catch(onerror);
              } catch (e) {
                onerror(e);
              }
            }}><ExternalLink size={15} />Google Calendar</button
          >
          <button class="button secondary" onclick={() => (editing = true)}
            ><Pencil size={15} />Corregir</button
          >{#if selected.status === 'pending'}<button
              class="button primary"
              onclick={() => save('confirmed')}
              disabled={saving}><Check size={16} />Confirmar</button
            >{:else}<button class="button primary" onclick={() => save('done')} disabled={saving}
              >Marcar realizada</button
            >{/if}<button class="text-button danger" onclick={() => save('dismissed')}
            >Descartar</button
          >
        </div>{/if}
    </div>
  </div>{/if}
