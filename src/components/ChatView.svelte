<script lang="ts">
  import { disclosure } from '../lib/disclosure';
  import Resonance from './Resonance.svelte';
  import {
    ArrowUp,
    Square,
    Paperclip,
    BookOpen,
    ChevronDown,
    Quote,
    CircleAlert,
  } from 'lucide-svelte';
  import type { ChatMessage, Evidence, Provider, Source, StudyEvent } from '../lib/types';
  let {
    messages,
    sources,
    events,
    providers,
    provider,
    model,
    onprovider,
    onmodel,
    subject = $bindable(),
    sourceId = $bindable(),
    busy,
    draft = $bindable(''),
    progress,
    streaming,
    onsend,
    oncancel,
    onimport,
    onevidence,
    onconnections,
    oncalendar,
  }: {
    messages: ChatMessage[];
    sources: Source[];
    events: StudyEvent[];
    providers: Provider[];
    provider: string;
    model: string;
    onprovider: (value: string) => void;
    onmodel: (value: string) => void;
    subject: string;
    sourceId: string;
    busy: boolean;
    draft: string;
    progress: string;
    streaming: string;
    onsend: () => void;
    oncancel: () => void;
    onimport: () => void;
    onevidence: (e: Evidence) => void;
    onconnections: () => void;
    oncalendar: () => void;
  } = $props();
  let viewport: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  $effect(() => {
    draft;
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(160, Math.max(44, textarea.scrollHeight))}px`;
    });
  });
  const suggestions = [
    { label: 'Preparar un parcial', prompt: '¿Qué temas entran en el parcial?' },
    { label: 'Revisar entregas', prompt: '¿Qué entregas tengo pendientes?' },
  ];
  const today = new Date().toLocaleDateString('en-CA');
  const upcoming = $derived(
    events
      .filter((e) => e.status === 'confirmed' && e.date >= today)
      .sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`))
      .slice(0, 2),
  );
  let subjects = $derived([...new Set(sources.map((s) => s.subject))]);
  let current = $derived(providers.find((p) => p.id === provider));
  const hasModel = $derived(!!current?.connected && !!model && current.models.includes(model));
  let scopeLabel = $derived(
    sourceId
      ? sources
          .find((s) => s.id === sourceId)
          ?.title.split('/')
          .at(-1) || 'Un documento'
      : subject || 'Todo el material',
  );
  $effect(() => {
    messages.length;
    streaming;
    queueMicrotask(() => {
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  });
  function parts(text: string) {
    return text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g);
  }
</script>

<section class="chat-view">
  <header class="chat-topbar">
    <h1>Chat</h1>
    <details class="scope-menu" use:disclosure>
      <summary title={scopeLabel}><span>{scopeLabel}</span><ChevronDown size={14} /></summary>
      <div class="scope-controls">
        <label
          >Materia<select
            aria-label="Materia de la consulta"
            bind:value={subject}
            disabled={busy}
            onchange={() => (sourceId = '')}
          >
            <option value="">Todas las materias</option>
            {#each subjects as item}<option>{item}</option>{/each}
          </select></label
        >
        <label
          >Documento<select
            aria-label="Documento de la consulta"
            bind:value={sourceId}
            disabled={busy}
          >
            <option value="">Todos los documentos</option>
            {#each sources.filter((s) => !subject || s.subject === subject) as item}
              <option value={item.id}>{item.title.split('/').at(-1)}</option>
            {/each}
          </select></label
        >
      </div>
    </details>
  </header>
  <div class="chat-body" class:empty={!messages.length && !busy}>
    {#if !messages.length && !busy}<Resonance />{/if}
    <div
      class="conversation-scroll"
      bind:this={viewport}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {#if !messages.length && !busy}
        <div class="chat-welcome">
          <h2>¿Qué estás preparando?</h2>
          <p>Buscá en tus apuntes o revisá lo que viene.</p>
          {#if sources.length}
            <div class="suggestions">
              {#each suggestions as suggestion}
                <button onclick={() => (draft = suggestion.prompt)}>{suggestion.label}</button>
              {/each}
            </div>
          {:else}
            <button class="button secondary" onclick={onimport}
              ><BookOpen size={16} />Agregar material</button
            >
          {/if}
        </div>
      {:else}
        <div class="messages">
          {#each messages as message}<article
              class="chat-message"
              class:user={message.role === 'user'}
              class:error-message={message.role === 'error'}
            >
              <div class="message-byline">
                {#if message.role === 'user'}Vos{:else if message.role === 'error'}<CircleAlert
                    size={15}
                  />No se completó la consulta{:else}Lupino<span class="provider-label"
                    >{message.provider === 'chatgpt'
                      ? 'ChatGPT'
                      : message.provider === 'claude'
                        ? 'Claude'
                        : 'Cursor'}</span
                  >{/if}
              </div>
              <div class="message-content">
                {#each parts(message.content) as part}{#if /^\[\d+\]$/.test(part) && message.evidence[Number(part.slice(1, -1)) - 1]}<button
                      class="citation"
                      onclick={() => onevidence(message.evidence[Number(part.slice(1, -1)) - 1])}
                      title="Ver fuente">{part.slice(1, -1)}</button
                    >{:else if part.startsWith('**') && part.endsWith('**')}<strong
                      >{part.slice(2, -2)}</strong
                    >{:else}{part}{/if}{/each}
              </div>
              {#if message.evidence.length}<div class="message-sources">
                  {#each message.evidence as evidence, index}{#if message.content.includes(`[${index + 1}]`)}<button
                        onclick={() => onevidence(evidence)}
                        ><Quote size={12} />{index + 1}. {evidence.title.slice(0, 45)}<span
                          >{evidence.locator}</span
                        ></button
                      >{/if}{/each}
                </div>{/if}
            </article>{/each}
          {#if busy}<article class="chat-message">
              <div class="message-byline">
                Lupino<span class="provider-label">{provider}</span>
              </div>
              {#if streaming}<div class="message-content streaming">{streaming}</div>{:else}<p
                  class="thinking"
                >
                  <span class="thinking-dot"></span>{progress || 'Buscando en tu material…'}
                </p>{/if}
            </article>{/if}
        </div>
      {/if}
    </div>
    <div class="composer-wrap">
      <form
        class="composer"
        onsubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !busy) onsend();
        }}
      >
        <textarea
          bind:this={textarea}
          aria-label="Tu pregunta"
          placeholder={sources.length
            ? 'Preguntá sobre tus materias…'
            : '¿Qué querés saber de tus apuntes?'}
          bind:value={draft}
          rows="1"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (draft.trim() && !busy) onsend();
            }
          }}
        ></textarea>
        <div class="composer-bottom">
          <div class="composer-options">
            <button
              class="icon-button"
              type="button"
              aria-label="Importar material"
              onclick={onimport}><Paperclip size={18} /></button
            >
            <span class="composer-select">
              <select
                class="provider-select"
                aria-label="Proveedor de IA"
                value={provider}
                disabled={busy}
                onchange={(event) => onprovider(event.currentTarget.value)}
              >
                <option value="chatgpt">ChatGPT</option><option value="claude">Claude</option
                ><option value="cursor">Cursor</option>
              </select><ChevronDown size={12} aria-hidden="true" />
            </span>
            <span class="composer-select">
              <select
                class="model-select"
                aria-label="Modelo de IA"
                title={model || 'Elegí un modelo antes de enviar'}
                value={hasModel ? model : ''}
                disabled={busy || !current?.connected || !current.models.length}
                onchange={(event) => onmodel(event.currentTarget.value)}
              >
                <option value="" disabled
                  >{!current
                    ? 'Cargando modelos…'
                    : !current.connected
                      ? 'Conectá tu cuenta'
                      : current.models.length
                        ? 'Elegí modelo'
                        : 'Sin modelos disponibles'}</option
                >
                {#each [...new Set(current?.models ?? [])].sort( (a, b) => a.localeCompare(b) ) as item}<option
                    value={item}
                    >{item}{['auto', 'default'].includes(item.toLowerCase())
                      ? ' · elige el proveedor'
                      : ''}</option
                  >{/each}
              </select><ChevronDown size={12} aria-hidden="true" />
            </span>
            {#if current && !current.connected}<button
                type="button"
                class="connect-hint"
                onclick={onconnections}>Conectar</button
              >{/if}
          </div>
          {#if busy}<button
              type="button"
              class="send-button stop"
              onclick={oncancel}
              aria-label="Detener respuesta"><Square size={15} fill="currentColor" /></button
            >{:else}<button
              class="send-button"
              disabled={!draft.trim() || !hasModel}
              aria-label="Enviar pregunta"><ArrowUp size={20} /></button
            >{/if}
        </div>
      </form>
    </div>
    {#if !messages.length && !busy && upcoming.length}
      <section class="chat-upcoming" aria-label="Próximas fechas">
        <div class="upcoming-heading">
          <h3>Lo próximo</h3>
          <button class="text-button" onclick={oncalendar}>Ver calendario</button>
        </div>
        {#each upcoming as event}<button class="upcoming-row" onclick={oncalendar}
            ><span class="upcoming-date"
              >{new Date(`${event.date}T12:00:00`).toLocaleDateString('es-AR', {
                day: '2-digit',
                month: 'short',
              })}</span
            ><span><strong>{event.title}</strong><small>{event.subject}</small></span></button
          >{/each}
      </section>
    {/if}
  </div>
</section>
