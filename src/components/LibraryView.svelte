<script lang="ts">
  import { Search, Upload, FileText, MessageSquare, Plus, BookOpen } from 'lucide-svelte';
  import type { Source, Evidence } from '../lib/types';
  import { command, dateLabel } from '../lib/api';
  let {
    sources,
    importErrors = [],
    onimport,
    ontext,
    onsource,
    onevidence,
    onerror,
  }: {
    sources: Source[];
    importErrors?: string[];
    onimport: () => void;
    ontext: () => void;
    onsource: (id: string) => void;
    onevidence: (e: Evidence) => void;
    onerror: (e: unknown) => void;
  } = $props();
  let query = $state('');
  let subject = $state('');
  let hits = $state<Evidence[] | null>(null);
  let searching = $state(false);
  let subjects = $derived([...new Set(sources.map((s) => s.subject))]);
  let filtered = $derived(sources.filter((s) => !subject || s.subject === subject));
  async function search() {
    if (!query.trim()) {
      hits = null;
      return;
    }
    searching = true;
    try {
      hits = await command<Evidence[]>('search', { query, subject: subject || null });
    } catch (e) {
      onerror(e);
    } finally {
      searching = false;
    }
  }
</script>

<section class="page library-page">
  <header class="page-heading">
    <div>
      <h1>Biblioteca</h1>
    </div>
    <div class="actions">
      <button class="text-button" onclick={ontext}>Agregar texto</button><button
        class="button primary"
        onclick={onimport}><Plus size={16} />Importar archivos</button
      >
    </div>
  </header>
  {#if importErrors.length}<details class="import-errors">
      <summary>{importErrors.length} archivos no se pudieron leer</summary>
      <p>
        Los demás documentos están disponibles. Revisá estos archivos o importá una copia con texto.
      </p>
      <ul>
        {#each importErrors as error}<li>{error}</li>{/each}
      </ul>
    </details>{/if}
  <form
    class="filter-bar"
    onsubmit={(e) => {
      e.preventDefault();
      search();
    }}
  >
    <label class="search-box"
      ><Search size={17} /><input
        aria-label="Buscar en el material"
        placeholder="Buscar en tus documentos…"
        bind:value={query}
      /></label
    ><select
      aria-label="Filtrar por materia"
      bind:value={subject}
      onchange={() => {
        if (query) search();
      }}
      ><option value="">Todas las materias</option>{#each subjects as s}<option>{s}</option
        >{/each}</select
    ><button class="button secondary" disabled={searching}
      >{searching ? 'Buscando…' : 'Buscar'}</button
    >
  </form>
  {#if hits !== null}
    <div class="section-line">
      <h2>Resultados</h2>
      <button
        class="text-button"
        onclick={() => {
          hits = null;
          query = '';
        }}>Ver biblioteca</button
      >
    </div>
    {#if !hits.length}<p class="empty-inline">
        No encontré ese texto en el material guardado. Probá con otras palabras o importá la fuente.
      </p>{/if}
    <div class="search-results">
      {#each hits as hit}<button class="search-result" onclick={() => onevidence(hit)}
          ><span class="small muted">{hit.subject} / {hit.locator}</span>
          <h3>{hit.title}</h3>
          <p>{hit.text.slice(0, 280)}{hit.text.length > 280 ? '…' : ''}</p></button
        >{/each}
    </div>
  {:else if !sources.length}
    <div class="empty-state">
      <BookOpen size={24} strokeWidth={1.5} />
      <h2>Agregá tu primer documento</h2>
      <p>Importá un apunte o guardá material con la extensión de Teams.</p>
      <button class="button primary" onclick={onimport}><Upload size={16} />Elegir archivos</button>
      <p class="small muted">PDF con texto, DOCX, PPTX, TXT y Markdown</p>
    </div>
  {:else}
    <div class="section-line">
      <span class="muted small">{filtered.length} documentos y mensajes</span>
    </div>
    <div class="source-table">
      <div class="table-head">
        <span>Documento</span><span>Materia</span>
      </div>
      {#each filtered as source}<button class="source-row" onclick={() => onsource(source.id)}
          ><span class="source-name"
            ><span class:message-icon={source.kind === 'teams'} class="file-icon"
              >{#if source.kind === 'teams'}<MessageSquare size={19} />{:else}<FileText
                  size={19}
                />{/if}</span
            ><span
              ><strong title={source.title}>{source.title.split('/').at(-1)}</strong><small
                >{source.status === 'needs_ocr'
                  ? 'Necesita OCR'
                  : source.kind === 'teams'
                    ? 'Teams · captura parcial'
                    : source.kind.toUpperCase()} · {dateLabel(source.updatedAt)}</small
              ></span
            ></span
          ><span class="subject-tag">{source.subject}</span></button
        >{/each}
    </div>
  {/if}
</section>
