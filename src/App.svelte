<script lang="ts">
  import { modalFocus } from './lib/modal';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { open } from '@tauri-apps/plugin-dialog';
  import {
    MessageCircle,
    Library,
    CalendarDays,
    Settings2,
    Plus,
    Check,
    X,
    Inbox,
  } from 'lucide-svelte';
  import ChatView from './components/ChatView.svelte';
  import LibraryView from './components/LibraryView.svelte';
  import CalendarView from './components/CalendarView.svelte';
  import ConnectionsView from './components/ConnectionsView.svelte';
  import SourcePanel from './components/SourcePanel.svelte';
  import { command, isDesktop, errorText } from './lib/api';
  import type {
    Snapshot,
    Provider,
    ChatMessage,
    AgentEvent,
    Evidence,
    SourceDetail,
  } from './lib/types';
  type View = 'chat' | 'library' | 'calendar' | 'connections';
  let view = $state<View>('chat');
  function storedTheme(): 'light' | 'dark' | 'system' {
    try {
      const saved = localStorage.getItem('lupino-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {}
    return 'system';
  }
  let theme = $state(storedTheme());
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('lupino-theme', theme);
    } catch {}
  });
  let data = $state<Snapshot>({ sources: [], events: [], conversations: [], inboxErrors: [] });
  let providers = $state<Provider[]>([]);
  let messages = $state<ChatMessage[]>([]);
  let conversationId = $state<string | null>(null);
  let activeRun = $state<string | null>(null);
  let streaming = $state('');
  let progress = $state('');
  let draft = $state('');
  let provider = $state('chatgpt');
  let model = $state('');
  let subject = $state('');
  let sourceId = $state('');
  let toast = $state('');
  let toastError = $state(false);
  let toastTimer: ReturnType<typeof setTimeout>;
  let source = $state<SourceDetail | null>(null);
  let evidence = $state<Evidence | null>(null);
  let importModal = $state<'files' | 'text' | null>(null);
  let importSubject = $state('');
  let importTitle = $state('');
  let importText = $state('');
  let importing = $state(false);
  let pendingFiles = $state<string[]>([]);
  const nav = [
    { id: 'chat' as View, label: 'Chat', icon: MessageCircle },
    { id: 'library' as View, label: 'Biblioteca', icon: Library },
    { id: 'calendar' as View, label: 'Calendario', icon: CalendarDays },
  ];
  function notify(message: string, error = false) {
    toast = message;
    toastError = error;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), error ? 12000 : 6000);
  }
  function onerror(e: unknown) {
    notify(errorText(e), true);
  }
  async function refresh() {
    try {
      data = await command<Snapshot>('snapshot');
    } catch (e) {
      onerror(e);
    }
  }
  async function refreshProviders() {
    try {
      providers = await command<Provider[]>('providers_status');
    } catch (e) {
      onerror(e);
    }
  }
  function newChat() {
    if (activeRun) {
      notify('Detené la respuesta actual antes de abrir otra conversación.', true);
      return;
    }
    conversationId = null;
    messages = [];
    draft = '';
    source = null;
    evidence = null;
    view = 'chat';
  }
  async function load(id: string) {
    if (activeRun) return;
    try {
      messages = await command<ChatMessage[]>('load_conversation', { id });
      conversationId = id;
      view = 'chat';
    } catch (e) {
      onerror(e);
    }
  }
  async function showSource(id: string) {
    try {
      source = await command<SourceDetail>('read_source', { id });
      evidence = null;
    } catch (e) {
      onerror(e);
    }
  }
  function showEvidence(item: Evidence) {
    evidence = item;
    source = null;
  }
  async function send() {
    if (activeRun || !draft.trim()) return;
    const prompt = draft;
    draft = '';
    streaming = '';
    progress = 'Buscando en tu biblioteca…';
    const run = crypto.randomUUID();
    activeRun = run;
    messages = [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        provider,
        createdAt: new Date().toISOString(),
        evidence: [],
      },
    ];
    try {
      const response = await command<{ conversationId: string }>('chat_start', {
        runId: run,
        conversationId,
        prompt,
        provider,
        model: model || null,
        subject: subject || null,
        sourceId: sourceId || null,
      });
      conversationId = response.conversationId;
      await refresh();
    } catch (e) {
      activeRun = null;
      messages = [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: 'error',
          content: errorText(e),
          provider,
          createdAt: new Date().toISOString(),
          evidence: [],
        },
      ];
    }
  }
  async function cancel() {
    if (activeRun) {
      try {
        await command('chat_cancel', { runId: activeRun });
      } catch (e) {
        onerror(e);
      }
      activeRun = null;
      streaming = '';
      notify('Respuesta detenida.');
    }
  }
  async function pickFiles() {
    if (!isDesktop) {
      onerror('La importación funciona en la app de escritorio.');
      return;
    }
    const paths = await open({
      multiple: true,
      filters: [
        {
          name: 'Material de estudio',
          extensions: ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown'],
        },
      ],
    });
    if (paths) {
      pendingFiles = Array.isArray(paths) ? paths : [paths];
      importSubject = subject;
      importModal = 'files';
    }
  }
  async function doImport() {
    importing = true;
    try {
      if (importModal === 'files') {
        const result = await command<{ ids: string[]; errors: string[] }>('import_files', {
          paths: pendingFiles,
          subject: importSubject,
        });
        notify(
          result.errors.length
            ? `${result.ids.length} archivos importados. ${result.errors.join(' ')}`
            : `${result.ids.length} archivos importados.`,
          !!result.errors.length,
        );
      } else {
        await command('import_text', {
          title: importTitle,
          text: importText,
          subject: importSubject,
        });
        notify('Texto guardado en tu biblioteca.');
      }
      importModal = null;
      importText = '';
      importTitle = '';
      await refresh();
      view = 'library';
    } catch (e) {
      onerror(e);
    } finally {
      importing = false;
    }
  }
  onMount(() => {
    const cleanups: (() => void)[] = [];
    let disposed = false;
    refresh();
    if (isDesktop) {
      listen<AgentEvent>('agent-event', ({ payload: e }) => {
        if (e.runId !== activeRun) return;
        if (e.conversationId) conversationId = e.conversationId;
        if (e.type === 'delta') streaming += e.delta || '';
        if (e.type === 'status') progress = e.message || '';
        if (e.type === 'result') {
          messages = [
            ...messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: e.text || streaming,
              provider,
              createdAt: new Date().toISOString(),
              evidence: e.evidence || [],
            },
          ];
          activeRun = null;
          streaming = '';
          refresh();
        }
        if (e.type === 'error') {
          messages = [
            ...messages,
            {
              id: crypto.randomUUID(),
              role: 'error',
              content: e.message || 'No se pudo completar la respuesta.',
              provider,
              createdAt: new Date().toISOString(),
              evidence: [],
            },
          ];
          activeRun = null;
          streaming = '';
        }
      }).then((fn) => (disposed ? fn() : cleanups.push(fn)));
      listen('library-changed', () => refresh()).then((fn) =>
        disposed ? fn() : cleanups.push(fn),
      );
      getCurrentWebviewWindow()
        .onDragDropEvent(({ payload }) => {
          if (payload.type === 'drop') {
            pendingFiles = payload.paths;
            importSubject = subject;
            importModal = 'files';
          }
        })
        .then((fn) => (disposed ? fn() : cleanups.push(fn)));
      refreshProviders();
    }
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      clearTimeout(toastTimer);
    };
  });
</script>

<div class="app-shell" class:reading={!!(source || evidence)}>
  <aside class="sidebar">
    <button
      class="brand"
      onclick={newChat}
      aria-label="Lupino, nuevo chat"
      title="Lupino — nuevo chat"
      ><svg width="44" height="44" viewBox="32 24 192 192" fill="currentColor" aria-hidden="true"
        ><path d="M48 40H104V128L80 152H208V208H48Z" /></svg
      ></button
    ><button class="new-chat" onclick={newChat}><Plus size={16} />Nuevo chat</button>
    <nav aria-label="Navegación principal">
      {#each nav as item}<button
          class:active={view === item.id}
          aria-current={view === item.id ? 'page' : undefined}
          aria-label={item.label}
          onclick={() => {
            view = item.id;
            source = null;
            evidence = null;
          }}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span></button
        >{/each}
    </nav>
    <div class="sidebar-history">
      {#if data.conversations.length}<p>Recientes</p>
        {#each data.conversations.slice(0, 12) as c}<button
            class:selected={conversationId === c.id && view === 'chat'}
            onclick={() => load(c.id)}
            title={c.title}>{c.title}</button
          >{/each}{/if}
    </div>
    <div class="sidebar-bottom">
      <button
        class:active={view === 'connections'}
        aria-label="Ajustes"
        aria-current={view === 'connections' ? 'page' : undefined}
        onclick={() => {
          view = 'connections';
          source = null;
          evidence = null;
        }}><Settings2 size={18} strokeWidth={1.7} />Ajustes</button
      >
    </div>
  </aside>
  <main class="main-content">
    {#if !isDesktop}<div class="preview-banner">
        Vista previa de la interfaz. Abrí la app de escritorio para usar tus datos.
      </div>{/if}
    {#if view === 'chat'}<ChatView
        {messages}
        sources={data.sources}
        {providers}
        bind:provider
        bind:model
        bind:subject
        bind:sourceId
        bind:draft
        busy={!!activeRun}
        {progress}
        {streaming}
        onsend={send}
        oncancel={cancel}
        onimport={() => pickFiles().catch(onerror)}
        onevidence={showEvidence}
        onconnections={() => (view = 'connections')}
      />
    {:else if view === 'library'}<LibraryView
        sources={data.sources}
        importErrors={data.inboxErrors}
        onimport={() => pickFiles().catch(onerror)}
        ontext={() => {
          importSubject = subject;
          importModal = 'text';
        }}
        onsource={showSource}
        onevidence={showEvidence}
        {onerror}
      />
    {:else if view === 'calendar'}<CalendarView
        events={data.events}
        onrefresh={refresh}
        onsource={showSource}
        {onerror}
      />
    {:else}<ConnectionsView {providers} bind:theme onrefresh={refreshProviders} {onerror} />{/if}
  </main>
  {#if source || evidence}<SourcePanel
      detail={source}
      {evidence}
      onclose={() => {
        source = null;
        evidence = null;
      }}
      {onerror}
    />
  {/if}
</div>
{#if toast}<div class:error={toastError} class="toast" role="status">
    {#if !toastError}<Check size={17} />{/if}<span>{toast}</span><button
      class="icon-button"
      aria-label="Cerrar aviso"
      onclick={() => (toast = '')}><X size={16} /></button
    >
  </div>{/if}
{#if importModal}<div class="modal-backdrop">
    <div
      class="modal"
      use:modalFocus={() => {
        if (!importing) importModal = null;
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Importar material"
      tabindex="-1"
    >
      <div class="section-line">
        <h2>{importModal === 'files' ? 'Importar material' : 'Guardar un texto'}</h2>
        <button class="text-button" disabled={importing} onclick={() => (importModal = null)}
          >Cerrar</button
        >
      </div>
      <p class="muted">Elegí una materia para encontrarlo después con más facilidad.</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          doImport();
        }}
      >
        <label
          >Materia<input
            bind:value={importSubject}
            placeholder="Ej. Álgebra"
            maxlength="256"
            list="subjects"
          /></label
        ><datalist id="subjects"
          >{#each [...new Set(data.sources.map((s) => s.subject))] as s}<option value={s}
            ></option>{/each}</datalist
        >{#if importModal === 'text'}<label
            >Título<input
              bind:value={importTitle}
              placeholder="Mensaje sobre el parcial"
              maxlength="500"
            /></label
          ><label
            >Texto<textarea
              bind:value={importText}
              rows="7"
              required
              placeholder="Pegá la consigna, el mensaje o tus notas…"
            ></textarea></label
          >{:else}<div class="import-file-list">
            {#each pendingFiles as path}<p>
                <Inbox size={15} />{path.split(/[\\/]/).at(-1)}
              </p>{/each}
          </div>{/if}<button class="button primary" disabled={importing}
          >{importing ? 'Importando e indexando…' : 'Guardar en biblioteca'}</button
        >
      </form>
    </div>
  </div>{/if}
