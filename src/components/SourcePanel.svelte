<script lang="ts">
  import { onMount } from 'svelte';
  import { X, ExternalLink, FileText, Quote } from 'lucide-svelte';
  import type { Evidence, SourceDetail } from '../lib/types';
  import { openExternal } from '../lib/api';
  let {
    detail,
    evidence,
    onclose,
    onerror,
  }: {
    detail: SourceDetail | null;
    evidence: Evidence | null;
    onclose: () => void;
    onerror: (e: unknown) => void;
  } = $props();
  const origin = $derived(evidence?.originUrl ?? detail?.source.originUrl);
  let closeButton: HTMLButtonElement;
  let panel: HTMLElement;
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      const restoreFocus =
        panel.contains(document.activeElement) || document.activeElement === document.body;
      if (restoreFocus)
        queueMicrotask(() => {
          if (
            previous?.isConnected &&
            previous !== document.body &&
            previous.getClientRects().length
          )
            previous.focus();
          else
            document
              .querySelector<HTMLButtonElement>('.sidebar button[aria-current="page"]')
              ?.focus();
        });
    };
  });
</script>

<aside class="source-panel" aria-label="Fuente de la respuesta" bind:this={panel}>
  <div class="panel-heading">
    <span><Quote size={16} /> Fuente original</span><button
      class="icon-button"
      bind:this={closeButton}
      onclick={onclose}
      aria-label="Cerrar fuente"><X size={18} /></button
    >
  </div>
  <h2>{(evidence?.title ?? detail?.source.title)?.split('/').at(-1)}</h2>
  <p class="muted">{evidence?.subject ?? detail?.source.subject}</p>
  {#if evidence}<span class="tag">{evidence.locator}</span>
    <p class="source-text highlighted">{evidence.text}</p>{/if}
  {#if detail}
    {#if detail.source.status === 'needs_ocr'}<p class="notice">
        Este PDF no tiene texto extraíble. Necesita OCR antes de poder consultarlo.
      </p>{/if}
    {#each detail.chunks as chunk}<section class="source-section">
        <h3><FileText size={14} />{chunk.locator}</h3>
        <p class="source-text">{chunk.text}</p>
      </section>{/each}
    {#if detail.source.attachments.length}<h3>Archivos enlazados</h3>
      <p class="muted small">Importá el archivo para que Lupino pueda leerlo.</p>
      {#each detail.source.attachments as file}<button
          class="attachment"
          onclick={() => openExternal(file.url).catch(onerror)}
          ><FileText size={15} />{file.name}<ExternalLink size={13} /></button
        >{/each}{/if}
  {/if}
  {#if origin}<button class="button secondary" onclick={() => openExternal(origin).catch(onerror)}
      ><ExternalLink size={15} />Abrir origen</button
    >{/if}
</aside>
