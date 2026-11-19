/**
 * Omnipresent 3-Stage Persona Switcher & Companion Whitelist UI.
 * variant 'rail'   → compact pill between brand and nav in #rail
 * variant 'inline' → inline pill in live console summary bar
 * Cross-surface sync via tina:persona-sync CustomEvent.
 */

import { get, invokePanel } from '../core/api.ts';
import { panelRoute } from '../../shared/webui-protocol.ts';
import type { WebUi } from '../../shared/client-panel.ts';
import { h } from './dom.ts';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface PersonaProfile {
  memoryRead: boolean;
  memoryWrite: boolean;
  webSearch: boolean;
  allowedWorlds: string[];
  stripCliClutter: boolean;
}

export type PersonaMode = 'companion' | 'auto' | 'work' | 'rp';

interface EngineStatusLite {
  mode?: PersonaMode;
  personaProfile?: PersonaProfile;
  worlds?: Array<{ id: string; visible: boolean; whitelisted?: boolean; toolCount: number; hasEnvPrompt: boolean }>;
  execution?: { presentation?: { wireSchemaCount?: number; wireSchemaBytes?: number } };
  systemSummary?: { sectionCount: number; totalChars: number; overriddenCount: number; frozen: boolean };
}

export interface PersonaSwitchOptions {
  variant: 'rail' | 'inline';
  doc: Document;
  ui: WebUi;
  signal: AbortSignal;
  onError?: (err: unknown) => void;
}

export interface PersonaSwitch {
  el: HTMLElement;
  /** Enable (and load) or forcibly hide the switcher. */
  setEnabled(enabled: boolean): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGINE_PAGE = 'world:native-engine';
const ENGINE_PANEL = 'engine';
export const PERSONA_SYNC_EVENT = 'tina:persona-sync';

const MODES: Array<{ value: PersonaMode; label: string }> = [
  { value: 'companion', label: '陪伴' },
  { value: 'auto', label: '自动' },
  { value: 'work', label: '工作' },
];

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPersonaSwitch(opts: PersonaSwitchOptions): PersonaSwitch {
  const { doc, ui, signal, variant } = opts;
  const onError = opts.onError ?? ((): void => {});

  // Hidden until a successful status load confirms native-engine is present.
  const el = h(doc, 'div', `persona-switch persona-switch-${variant}`);
  el.hidden = true;

  let status: EngineStatusLite | null = null;
  let switching = false;

  // ── Rail meta row (rail only) ────────────────────────────────────────────
  const metaRow = h(doc, 'div', 'persona-rail-meta');
  const companionBadge = h(doc, 'span', 'persona-companion-badge');
  companionBadge.hidden = true;
  metaRow.append(h(doc, 'span', 'persona-meta-label', 'Persona'), companionBadge);

  // ── 3-segment pill ───────────────────────────────────────────────────────
  const pillEl = h(doc, 'div', 'persona-pill');
  const segBtns: Array<{ value: PersonaMode; btn: HTMLButtonElement }> = [];
  for (const m of MODES) {
    const btn = h(doc, 'button', `persona-seg${m.value === 'companion' ? ' companion' : ''}`);
    btn.type = 'button';
    btn.textContent = m.label;
    btn.setAttribute('aria-label', m.label + ' 模式');
    btn.addEventListener('click', () => { void switchMode(m.value); }, { signal });
    segBtns.push({ value: m.value, btn });
    pillEl.appendChild(btn);
  }

  // RP indicator badge – shown when backend mode === 'rp'
  const rpBadge = h(doc, 'span', 'persona-rp-badge', 'RP');
  rpBadge.hidden = true;

  // Gear / sliders button opens the whitelist popover
  const gearBtn = h(doc, 'button', 'persona-gear');
  gearBtn.type = 'button';
  gearBtn.setAttribute('aria-label', '陪伴档白名单设置');
  gearBtn.title = '陪伴档白名单设置';
  gearBtn.textContent = '⚙';
  gearBtn.setAttribute('aria-expanded', 'false');
  gearBtn.setAttribute('aria-haspopup', 'dialog');

  const pillRow = h(doc, 'div', 'persona-pill-row');
  pillRow.append(pillEl, rpBadge, gearBtn);

  if (variant === 'rail') {
    el.append(metaRow, pillRow);
  } else {
    el.append(pillRow);
  }

  // ── Floating whitelist popover ───────────────────────────────────────────
  let popover: HTMLElement | null = null;
  let slimnessEl: HTMLElement | null = null;

  const formatSlimness = (): string => {
    const pres = status?.execution?.presentation;
    const ss = status?.systemSummary;
    if (pres?.wireSchemaBytes === undefined) return '';
    const kb = (pres.wireSchemaBytes / 1024).toFixed(1);
    let txt = `当前装载 ${pres.wireSchemaCount ?? '?'} 工具 (${kb} KB)`;
    if (ss) txt += ` · System ${ss.sectionCount} 段`;
    return txt;
  };

  const closePopover = (): void => {
    if (!popover) return;
    popover.remove();
    popover = null;
    slimnessEl = null;
    gearBtn.setAttribute('aria-expanded', 'false');
  };

  const positionPopover = (pop: HTMLElement): void => {
    const rect = gearBtn.getBoundingClientRect();
    const vw = doc.defaultView?.innerWidth ?? 800;
    const vh = doc.defaultView?.innerHeight ?? 600;
    const popW = 312;
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= 280 || spaceBelow >= spaceAbove) {
      pop.style.top = `${rect.bottom + 6}px`;
      pop.style.bottom = '';
    } else {
      pop.style.bottom = `${vh - rect.top + 6}px`;
      pop.style.top = '';
    }
    pop.style.left = `${Math.max(8, Math.min(rect.left, vw - popW - 8))}px`;
  };

  const openPopover = (): void => {
    if (popover) { closePopover(); return; }
    popover = buildPopover();
    doc.body.appendChild(popover);
    gearBtn.setAttribute('aria-expanded', 'true');
    positionPopover(popover);
  };

  gearBtn.addEventListener('click', openPopover, { signal });

  doc.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (popover && !popover.contains(ev.target as Node) && !gearBtn.contains(ev.target as Node)) {
      closePopover();
    }
  }, { signal });

  doc.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && popover) closePopover();
  }, { signal });

  // Close on any scroll (capture phase catches nested scrollables too)
  doc.addEventListener('scroll', () => { if (popover) closePopover(); }, { signal, capture: true });

  function buildPopover(): HTMLElement {
    const pop = h(doc, 'div', 'persona-popover');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '陪伴档轻聊白名单');

    // Header
    pop.append(
      h(doc, 'div', 'persona-pop-title', '陪伴档 · 轻聊白名单'),
      h(doc, 'div', 'persona-pop-sub',
        '切换「陪伴」档卸载复杂工具与 system 段，大幅降低聊天延迟。'),
    );

    // Live slimness readout
    slimnessEl = h(doc, 'div', 'persona-pop-slimness', formatSlimness());
    slimnessEl.hidden = !slimnessEl.textContent;
    pop.append(slimnessEl);

    const prof = status?.personaProfile;

    // Boolean whitelist checkboxes
    const checksDiv = h(doc, 'div', 'persona-pop-checks');
    const checkDefs: Array<{ key: 'memoryRead' | 'memoryWrite' | 'webSearch'; label: string; sub: string }> = [
      { key: 'memoryRead',  label: '记忆检索', sub: '保留 mem_search / mem_read 回忆原话' },
      { key: 'memoryWrite', label: '记忆写入', sub: '允许顺手记入画布与备忘' },
      { key: 'webSearch',   label: '联网搜索', sub: '保留 web_search / web_fetch 查证新信息' },
    ];
    for (const def of checkDefs) {
      const row = h(doc, 'label', 'persona-pop-check-row');
      const box = h(doc, 'input');
      box.type = 'checkbox';
      box.checked = prof ? prof[def.key] : false;
      const textDiv = h(doc, 'div', 'persona-pop-check-text');
      textDiv.append(
        h(doc, 'span', 'persona-pop-check-label', def.label),
        h(doc, 'span', 'persona-pop-check-sub', def.sub),
      );
      row.append(box, textDiv);
      const key = def.key;
      box.addEventListener('change', () => { void saveProfile({ [key]: box.checked }); }, { signal });
      checksDiv.appendChild(row);
    }
    pop.append(checksDiv);

    // World whitelist chips
    pop.append(h(doc, 'div', 'persona-pop-section-label', '白名单 World（陪伴档保留通信/能力）'));
    const worldsDiv = h(doc, 'div', 'persona-pop-worlds');
    const mountedSet = new Set((status?.worlds ?? []).filter(w => w.id !== 'native-engine').map(w => w.id));
    const allowedWorlds = new Set<string>(prof?.allowedWorlds ?? []);
    const allWorldIds = [...new Set([...mountedSet, ...allowedWorlds])];

    for (const worldId of allWorldIds) {
      const isMounted = mountedSet.has(worldId);
      const chipEl = h(doc, 'button', `persona-world-chip${allowedWorlds.has(worldId) ? ' active' : ''}`);
      chipEl.type = 'button';
      chipEl.textContent = isMounted ? `${worldId} ●` : worldId;
      chipEl.title = isMounted ? `${worldId}（当前已挂载）` : `${worldId}（未挂载，预先加入白名单）`;
      chipEl.setAttribute('aria-pressed', String(allowedWorlds.has(worldId)));
      chipEl.addEventListener('click', () => {
        if (allowedWorlds.has(worldId)) allowedWorlds.delete(worldId);
        else allowedWorlds.add(worldId);
        chipEl.classList.toggle('active', allowedWorlds.has(worldId));
        chipEl.setAttribute('aria-pressed', String(allowedWorlds.has(worldId)));
        void saveProfile({ allowedWorlds: [...allowedWorlds] });
      }, { signal });
      worldsDiv.appendChild(chipEl);
    }
    pop.append(worldsDiv);

    // Footer: RP quick-enter + workbench link
    const footer = h(doc, 'div', 'persona-pop-footer');
    const rpBtn = ui.button('纯场景 RP', {
      size: 'sm',
      onClick: () => { void switchMode('rp'); closePopover(); },
    });
    rpBtn.classList.add('persona-pop-rp-btn');
    const link = h(doc, 'a', 'persona-pop-workbench-link', '完整调优台 →');
    link.href = '#/provider/world%3Anative-engine/engine';
    link.addEventListener('click', () => closePopover(), { signal });
    footer.append(rpBtn, link);
    pop.append(footer);

    return pop;
  }

  // ── State & networking ───────────────────────────────────────────────────
  let loadSeq = 0;

  const loadStatus = async (): Promise<void> => {
    const seq = ++loadSeq;
    try {
      const s = await get<EngineStatusLite>(
        panelRoute(ENGINE_PAGE, ENGINE_PANEL, 'status'),
        { signal },
      );
      if (seq !== loadSeq || signal.aborted) return;
      status = s;
      el.hidden = false;
      render();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      if (seq !== loadSeq) return;
      // 404 = native-engine not present; stay hidden without noise
      if ((err as { status?: number } | null)?.status !== 404) onError(err);
    }
  };

  const render = (): void => {
    const mode = status?.mode ?? 'auto';
    for (const { value, btn } of segBtns) {
      btn.classList.toggle('active', value === mode);
      btn.setAttribute('aria-current', value === mode ? 'true' : 'false');
    }
    rpBadge.hidden = mode !== 'rp';
    if (variant === 'rail') {
      companionBadge.textContent = mode === 'companion' ? '陪伴减负中' : '';
      companionBadge.hidden = mode !== 'companion';
    }
    if (slimnessEl) {
      slimnessEl.textContent = formatSlimness();
      slimnessEl.hidden = !slimnessEl.textContent;
    }
  };

  const dispatchSync = (): void => {
    doc.defaultView?.dispatchEvent(new CustomEvent(PERSONA_SYNC_EVENT));
  };

  const switchMode = async (mode: PersonaMode): Promise<void> => {
    if (switching || signal.aborted) return;
    switching = true;
    try {
      await invokePanel(ENGINE_PAGE, ENGINE_PANEL, 'mode', [{ mode }], { signal });
      if (signal.aborted) return;
      if (status) status.mode = mode;
      render();
      dispatchSync();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      onError(err);
    } finally {
      switching = false;
    }
  };

  const saveProfile = async (patch: Partial<PersonaProfile>): Promise<void> => {
    if (signal.aborted) return;
    try {
      await invokePanel(ENGINE_PAGE, ENGINE_PANEL, 'personaProfile', [patch], { signal });
      if (signal.aborted) return;
      if (status) {
        const existing: PersonaProfile = status.personaProfile ?? {
          memoryRead: true, memoryWrite: false, webSearch: true, allowedWorlds: [], stripCliClutter: false,
        };
        status.personaProfile = { ...existing, ...patch };
      }
      dispatchSync();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      onError(err);
    }
  };

  // Re-sync whenever another surface updates mode or profile
  doc.defaultView?.addEventListener(PERSONA_SYNC_EVENT, () => { void loadStatus(); }, { signal });

  return {
    el,
    setEnabled(enabled: boolean): void {
      if (!enabled) {
        el.hidden = true;
        return;
      }
      void loadStatus();
    },
  };
}
