<script lang="ts">
  import { modalFocus } from '../lib/modal';
  import { onMount } from 'svelte';
  import {
    Puzzle,
    ExternalLink,
    Check,
    ArrowUpRight,
    RefreshCw,
    Sun,
    Moon,
    Monitor,
  } from 'lucide-svelte';
  import type { Provider } from '../lib/types';
  import { command, openExternal } from '../lib/api';
  let {
    providers,
    theme = $bindable('system'),
    onrefresh,
    onerror,
  }: {
    providers: Provider[];
    theme: 'light' | 'dark' | 'system';
    onrefresh: () => Promise<void>;
    onerror: (e: unknown) => void;
  } = $props();
  let busy = $state('');
  let keyProvider = $state('');
  let key = $state('');
  let notice = $state('');
  let reminders = $state({ enabled: true, beforeDay: true, beforeHour: true, allDayTime: '09:00' });
  onMount(async () => {
    try {
      reminders = await command<typeof reminders>('reminder_settings');
    } catch {}
  });
  async function saveReminders() {
    try {
      await command('save_reminder_settings', { settings: reminders });
      notice = 'Preferencias de avisos guardadas.';
    } catch (e) {
      onerror(e);
    }
  }
  const names: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', cursor: 'Cursor' };
  async function connect(provider: string, action: string) {
    busy = provider;
    notice = '';
    try {
      const result = await command<{ detail: string; note?: string }>('provider_action', {
        provider,
        action,
        apiKey: action === 'save_key' ? key : null,
      });
      notice = result.note || result.detail;
      key = '';
      keyProvider = '';
      await onrefresh();
    } catch (e) {
      onerror(e);
    } finally {
      busy = '';
    }
  }
  async function register() {
    busy = 'extension';
    try {
      notice = await command<string>('register_extension');
    } catch (e) {
      onerror(e);
    } finally {
      busy = '';
    }
  }
</script>

<section class="page connections-page">
  <header class="page-heading"><h1>Ajustes</h1></header>
  {#if notice}<p class="notice success" role="status"><Check size={16} />{notice}</p>{/if}
  <section class="connection-section appearance-section">
    <h2>Apariencia</h2>
    <div class="segmented" role="group" aria-label="Tema de la aplicación">
      <button aria-pressed={theme === 'light'} onclick={() => (theme = 'light')}
        ><Sun size={16} />Claro</button
      >
      <button aria-pressed={theme === 'dark'} onclick={() => (theme = 'dark')}
        ><Moon size={16} />Oscuro</button
      >
      <button aria-pressed={theme === 'system'} onclick={() => (theme = 'system')}
        ><Monitor size={16} />Sistema</button
      >
    </div>
  </section>
  <section class="connection-section">
    <div class="section-line">
      <h2>Cuentas de IA</h2>
      <button class="text-button" disabled={!!busy} onclick={onrefresh}
        ><RefreshCw size={14} />Verificar cuentas</button
      >
    </div>
    <div class="provider-list">
      {#each ['chatgpt', 'claude', 'cursor'] as id}
        {@const account = providers.find((p) => p.id === id)}
        <div class="provider-row">
          <div class="provider-description">
            <h3>
              {names[id]}{#if account?.connected}<span class="connection-status"
                  ><Check size={12} />Conectado</span
                >{/if}
            </h3>
            <p>
              {id === 'claude'
                ? 'Clave de Anthropic. El consumo de API se factura por separado.'
                : `Usá tu cuenta de ${names[id]}.`}
            </p>
            {#if account?.detail}
              <details class="account-detail">
                <summary>Estado de la conexión</summary>
                <p>{account.detail}</p>
              </details>
            {/if}
          </div>
          <div class="provider-actions">
            {#if account?.connected}<button
                class="button secondary"
                disabled={!!busy}
                onclick={() => connect(id, 'logout')}>Desconectar</button
              >
            {:else if id === 'claude'}<button
                class="button secondary"
                disabled={!!busy}
                onclick={() => (keyProvider = id)}>Agregar API key</button
              >
            {:else}<button
                class="button secondary"
                disabled={!!busy}
                onclick={() => connect(id, 'login')}
              >
                {busy === id ? 'Esperando acceso…' : 'Iniciar sesión'}<ArrowUpRight
                  size={14}
                /></button
              >{/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
  <section class="connection-section">
    <h2>Teams</h2>
    <p class="muted">
      La extensión mantiene tus carpetas actualizadas cada 15 minutos, con el navegador abierto.
    </p>
    <details class="setup-details">
      <summary>Configurar la extensión</summary>
      <ol class="setup-steps">
        <li>
          Abrí la carpeta de la extensión y cargala en Brave o Chrome desde <code
            >chrome://extensions</code
          >, con el modo desarrollador activado.
        </li>
        <li>Vinculá el navegador con Lupino.</li>
        <li>
          En Teams, abrí Materiales de clase → Abrir en SharePoint. Elegí la materia en la extensión
          y pulsá «Sincronizar esta carpeta».
        </li>
        <li>
          Para mensajes, elegí «Guardar mensajes cargados» en la extensión. La captura es parcial.
        </li>
      </ol>
      <div class="actions wrap">
        <button
          class="button secondary"
          onclick={async () => {
            try {
              notice = await command<string>('open_extension_folder');
            } catch (e) {
              onerror(e);
            }
          }}>Abrir carpeta de extensión</button
        >
        <button class="button secondary" disabled={busy === 'extension'} onclick={register}>
          <Puzzle size={15} />{busy === 'extension' ? 'Vinculando…' : 'Vincular navegador'}</button
        >
      </div>
    </details>
  </section>
  <section class="connection-section">
    <h2>Recordatorios</h2>
    <p class="muted">Necesitan la computadora encendida y Lupino abierto, también en la bandeja.</p>
    <form
      class="reminder-form"
      onsubmit={(e) => {
        e.preventDefault();
        saveReminders();
      }}
    >
      <label class="check-label"
        ><input type="checkbox" bind:checked={reminders.enabled} />Activar avisos</label
      >
      <div class="actions wrap">
        <label class="check-label"
          ><input type="checkbox" bind:checked={reminders.beforeDay} />Un día antes</label
        >
        <label class="check-label"
          ><input type="checkbox" bind:checked={reminders.beforeHour} />Una hora antes</label
        >
      </div>
      <label class="time-setting"
        >Para fechas sin horario<input
          type="time"
          required
          bind:value={reminders.allDayTime}
        /></label
      >
      <button class="button secondary">Guardar avisos</button>
    </form>
  </section>
  <p class="local-info">
    Tus documentos y conversaciones se guardan en este equipo. Al preguntar, se envían a la IA
    elegida tu consulta y los fragmentos necesarios.
  </p>
</section>
{#if keyProvider}<div class="modal-backdrop">
    <div
      class="modal"
      use:modalFocus={() => {
        keyProvider = '';
        key = '';
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Conectar API key"
      tabindex="-1"
    >
      <div class="section-line">
        <h2>Conectar {names[keyProvider]}</h2>
        <button
          class="text-button"
          onclick={() => {
            keyProvider = '';
            key = '';
          }}>Cerrar</button
        >
      </div>
      <p class="muted">
        La clave se guarda en el almacén seguro del sistema, nunca en tus conversaciones.
      </p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          connect(keyProvider, 'save_key');
        }}
      >
        <label
          >API key<input
            type="password"
            autocomplete="off"
            required
            bind:value={key}
            placeholder="sk-ant-…"
          /></label
        >
        <div class="actions">
          <button class="button primary" disabled={!!busy}
            >{busy ? 'Verificando…' : 'Guardar y verificar'}</button
          ><button
            type="button"
            class="text-button"
            onclick={() => openExternal('https://platform.claude.com/settings/keys').catch(onerror)}
            >Obtener una clave <ExternalLink size={14} /></button
          >
        </div>
      </form>
    </div>
  </div>{/if}
