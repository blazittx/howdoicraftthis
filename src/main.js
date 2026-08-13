import { parseItem, sortExplicitModsForTooltip } from './lib/itemParser.js';
import { generateCraftSteps } from './lib/craftPlanner.js';
import { replanFromProgress, modStableKey } from './lib/deterministicPlanner.js';
import { loadKnowledgeBase } from './lib/knowledgeLoader.js';
import { formatCostCookie } from './lib/prices.js';
import { currencyIconUrl } from './lib/currencyIcons.js';
import {
  listCraftableBases,
  searchBases,
  eligibleModsByCategory,
  filterCategoryMods,
  collectTags,
  buildSyntheticItem,
  cannotRollNotice,
  modDisplayText,
  modRangeLabel,
  textWithTierRange,
  hydrateBuilderFromItem,
  groupModsByFamily,
  pickRandomBuild,
  INFLUENCE_NAMES,
} from './lib/itemBuilder.js';

const app = document.querySelector('.app');
const emptyState = document.getElementById('empty-state');
const dropZone = document.getElementById('drop-zone');
const pasteMod = document.getElementById('paste-mod');
const statusEl = document.getElementById('status');
const clearBtn = document.getElementById('clear-btn');
const results = document.getElementById('results');
const errorEl = document.getElementById('error');
const itemSummary = document.getElementById('item-summary');
const costPanel = document.getElementById('cost-panel');
const alternativesPanel = document.getElementById('alternatives-panel');
const stepsContainer = document.getElementById('steps-container');
const tipsContainer = document.getElementById('tips-container');
const exportBtn = document.getElementById('export-btn');
const exportStatus = document.getElementById('export-status');

const tabPaste = document.getElementById('tab-paste');
const tabBuild = document.getElementById('tab-build');
const panelPaste = document.getElementById('panel-paste');
const panelBuild = document.getElementById('panel-build');
const baseSearch = document.getElementById('builder-base-search');
const baseList = document.getElementById('builder-base-list');
const ilvlInput = document.getElementById('builder-ilvl');
const selectedBaseEl = document.getElementById('builder-selected-base');
const cannotRollEl = document.getElementById('builder-cannot-roll');
const selectedModsEl = document.getElementById('builder-selected-mods');
const selectedEmptyEl = document.getElementById('builder-selected-empty');
const builderCats = document.getElementById('builder-cats');
const builderGen = document.getElementById('builder-gen');
const modSearch = document.getElementById('builder-mod-search');
const builderTags = document.getElementById('builder-tags');
const modListEl = document.getElementById('builder-mod-list');
const planBtn = document.getElementById('builder-plan-btn');
const resetBuildBtn = document.getElementById('builder-reset-btn');
const editInBuildBtn = document.getElementById('edit-in-build-btn');

/** Latest analyze result — used by "Copy plan for feedback". */
let lastExport = null;
/** User-marked hit affixes (stable mod keys). */
let hitKeys = new Set();
/** Prefer fractured base when plan offers preferFracture (default on). */
let preferFractureEnabled = true;
let analyzing = false;

/** Builder state */
let inputMode = 'paste';
let kbCache = null;
let allBases = [];
let selectedBase = null;
let selectedMods = [];
/** Conqueror influences from paste / hydrate (also inferred from influence mods). */
let selectedInfluences = [];
let categories = null;
let activeCat = 'natural';
let activeTag = '';
let baseHighlight = 0;
/** Expanded affix-family keys in the mod browser. */
let expandedFamilies = new Set();
/** Last mod-search string used to seed auto-expand. */
let lastModSearch = '';
/** True after the user edits Build; cleared on hydrate / reset / successful plan-from-build. */
let builderDirty = false;

if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)) {
  pasteMod.textContent = '⌘';
}

const RARITY_COLORS = {
  Normal: '#c8c8c8',
  Magic: '#8888ff',
  Rare: '#ffff77',
  Unique: '#af6025',
};

/** PoE affix color class — fractured wins over crafted (in-game priority). */
function modColorClass(m) {
  if (!m) return '';
  if (m.fractured || m.source === 'fractured') return 'mod-fractured fractured';
  if (m.crafted || m.source === 'crafted' || m.method === 'bench') return 'mod-crafted crafted';
  if (m.veiled || m.source === 'veiled') return 'mod-veiled veiled';
  if (m.source === 'unveiled') return 'mod-unveiled';
  /* Essence lines are normal white in-game; Essence badge stays cyan via sourceBadges */
  if (m.ofEssence || m.source === 'essence' || m.essence) return 'mod-normal';
  if (m.enchant || m.type === 'enchant') return 'mod-enchant enchant';
  if (m.implicit || m.type === 'implicit') return 'mod-implicit implicit';
  return 'mod-normal';
}

function targetModClass(text) {
  const t = String(text);
  if (/\(fractured\)/i.test(t) || /\bfractured\b/i.test(t)) return 'mod-fractured fractured';
  if (/\(crafted\)/i.test(t) || /\bcrafted\b/i.test(t) || /\bbench\b/i.test(t)) return 'mod-crafted crafted';
  if (/\(veiled\)/i.test(t) || /\bveiled\b/i.test(t)) return 'mod-veiled veiled';
  if (/\bunveiled\b/i.test(t)) return 'mod-unveiled';
  if (/\(enchant\)/i.test(t) || /\benchant\b/i.test(t)) return 'mod-enchant enchant';
  return 'mod-normal';
}

function setHasItem(active) {
  app?.classList.toggle('has-item', active);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  results.classList.add('hidden');
  emptyState.classList.remove('hidden');
  setHasItem(false);
}

function hideError() {
  errorEl.classList.add('hidden');
}

function setLoading(loading, progressText) {
  analyzing = loading;
  if (dropZone) dropZone.disabled = loading;
  if (planBtn) planBtn.disabled = loading || !selectedBase || selectedMods.length === 0;
  statusEl.textContent = loading ? progressText || 'Searching crafts…' : '';
  emptyState.classList.toggle('is-loading', loading);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sourceBadges(analysis) {
  if (!analysis) return '';
  const tags = [];
  if (analysis.fractured || analysis.source === 'fractured') tags.push(['frac', 'Fractured']);
  if (analysis.crafted || analysis.source === 'crafted' || analysis.method === 'bench') tags.push(['craft', 'Bench']);
  if (analysis.ofEssence || analysis.source === 'essence' || analysis.method === 'essence' || analysis.essence)
    tags.push(['ess', 'Essence']);
  if (analysis.source === 'unveiled' || analysis.method === 'unveil') tags.push(['unveil', 'Unveiled']);
  else if (analysis.veiled || analysis.source === 'veiled') tags.push(['veil', 'Veiled']);
  if (analysis.enchant || analysis.type === 'enchant') tags.push(['ench', 'Enchant']);
  if (analysis.method === 'harvest' || analysis.source === 'harvest') tags.push(['harv', 'Harvest']);
  if (analysis.method === 'natural') tags.push(['', 'Natural']);
  if (analysis.chanceLabel) tags.push(['', analysis.chanceLabel]);
  else if (analysis.chance != null) tags.push(['', `${(analysis.chance * 100).toFixed(1)}%`]);
  if (analysis.type && analysis.type !== 'enchant' && analysis.type !== 'implicit') tags.push(['', analysis.type]);
  if (analysis.tier && typeof analysis.tier === 'number') tags.push(['', `T${analysis.tier}`]);
  return tags.map(([cls, label]) => `<span class="mod-tag ${cls}">${escapeHtml(label)}</span>`).join('');
}

/** Title-case RePoE snake_case tags (or keep paste labels). */
function formatAffixTag(tag) {
  const s = String(tag).trim();
  if (!s) return '';
  if (/[A-Z]/.test(s) || /\s/.test(s)) return s;
  return s.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** KB tags when matched; paste advanced-desc tags otherwise. Never invent. */
function resolveAffixTags(analysis, mod) {
  if (analysis?.matched && analysis.tags?.length) return analysis.tags;
  if ((!analysis || !analysis.matched) && mod?.tags?.length) return mod.tags;
  return [];
}

function affixTagsHtml(analysis, mod) {
  const tags = resolveAffixTags(analysis, mod).map(formatAffixTag).filter(Boolean);
  if (!tags.length) return '';
  return `<span class="mod-affix-tags">— ${escapeHtml(tags.join(', '))}</span>`;
}

/** PoE tooltip sections: enchant → implicit → (fractured + explicit + crafted). */
function modsForTooltipDisplay(item) {
  const rows = [];
  const enchants = item.enchants ?? [];
  const implicits = item.implicits ?? [];
  const explicits = sortExplicitModsForTooltip(item.explicitMods ?? []);

  if (enchants.length) {
    for (const m of enchants) rows.push({ ...m, enchant: true, cls: modColorClass({ ...m, enchant: true }) });
    if (implicits.length || explicits.length) rows.push({ sep: true });
  }
  if (implicits.length) {
    for (const m of implicits) rows.push({ ...m, implicit: true, cls: modColorClass({ ...m, implicit: true }) });
    if (explicits.length) rows.push({ sep: true });
  }
  for (const m of explicits) rows.push({ ...m, cls: modColorClass(m) });
  return rows;
}

function renderSummary(item, plan) {
  const displayName = item.itemName ?? item.baseName;
  const rarityColor = RARITY_COLORS[item.rarity] ?? '#c8c8c8';

  const meta = [
    item.itemClass,
    item.itemLevel ? `ilvl ${item.itemLevel}` : null,
    item.quality ? `${item.quality}% qual` : null,
    item.fracturedItem ? 'Fractured' : null,
    item.influenced?.length ? item.influenced.join(' ') : null,
    item.corrupted ? 'Corrupted' : null,
    plan.methodName ?? plan.method,
  ].filter(Boolean);

  const modAnalysis = plan.modAnalysis ?? [];
  const findAnalysis = (text) =>
    modAnalysis.find((m) => m.text === text || m.text?.split('\n')[0] === text.split('\n')[0]);

  const allMods = modsForTooltipDisplay(item);

  const flagKeys = Object.keys(plan.artFlags ?? {});
  const glow = {
    warlord: '#f0c14a',
    crusader: '#e85a5a',
    hunter: '#6bcf6b',
    redeemer: '#7ec8f0',
    shaper: '#8a9cff',
    elder: '#b07acc',
    searing: '#e07a3d',
    tangled: '#3db8a8',
  };
  const filterStyle = plan.artGlow
      ? `style="filter:${flagKeys
          .map((k) => {
            const c = glow[k] ?? '#ccc';
            return `drop-shadow(0 0 2px ${c}) drop-shadow(0 0 5px ${c}cc)`;
          })
          .join(' ')}"`
      : '';
  const badges = flagKeys
    .map((k) => {
      const icon = { searing: 'exarch', tangled: 'eater' }[k] ?? k;
      return `<img class="inf-badge" src="/icons/influence/${icon}.png" alt="${escapeHtml(k)}" title="${escapeHtml(k)}" width="18" height="18" loading="lazy" decoding="async" />`;
    })
    .join('');
  const fbAttr = plan.artFallbackUrl ? `data-fallback="${escapeHtml(plan.artFallbackUrl)}"` : '';
  const onerr =
    "this.onerror=null;const fb=this.dataset.fallback;if(fb){this.src=fb;return;}const s=this.closest('.item-summary');this.closest('.item-art-wrap')?.remove();s?.classList.remove('has-art')";
  const art = plan.artUrl
    ? `<div class="item-art-wrap">${badges ? `<div class="inf-badges">${badges}</div>` : ''}<img class="item-art" src="${escapeHtml(plan.artUrl)}" alt="" width="64" height="64" loading="lazy" decoding="async" ${filterStyle} ${fbAttr} onerror="${onerr}" /></div>`
    : '';

  itemSummary.innerHTML = `
    ${art}
    <div class="item-summary-body">
      <h2 style="color: ${rarityColor}">${escapeHtml(displayName)}</h2>
      <div class="base">${escapeHtml(item.baseName)}</div>
      <div class="meta-grid">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
      <ul class="mods-list">
        ${allMods
          .map((m) => {
            if (m.sep) return `<li class="mod-sep" aria-hidden="true"></li>`;
            const a = findAnalysis(m.text);
            const ranged = textWithTierRange(
              m.text,
              a?.matched
                ? { text: a.kbText || m.text, min: a.min, max: a.max }
                : null
            );
            const display = escapeHtml(ranged).replace(/\n/g, '<br>');
            const cls = a ? modColorClass({ ...m, ...a }) : m.cls;
            return `<li class="${cls}">${display}${affixTagsHtml(a, m)} ${sourceBadges(a || m)}</li>`;
          })
          .join('')}
      </ul>
      <p class="plan-summary">${escapeHtml(plan.summary)}</p>
    </div>
  `;
  itemSummary.classList.toggle('has-art', !!art);
}

function currencyImg(key, cls = 'currency-icon') {
  const url = currencyIconUrl(key);
  if (!url) return '';
  return `<img class="${cls}" src="${escapeHtml(url)}" alt="" width="18" height="18" loading="lazy" decoding="async" onerror="this.remove()" />`;
}

function renderCostPanel(plan) {
  const unknown = plan.totalCost == null;
  if (!plan.costBreakdown?.length && !unknown && !plan.priceStatus?.missing) {
    costPanel.classList.add('hidden');
    return;
  }
  costPanel.classList.remove('hidden');
  const prices = kbCache?.prices ?? plan.prices ?? null;
  const cookie = formatCostCookie(unknown ? null : plan.totalCost, prices);
  const tipHtml =
    cookie.tipLines.length > 0
      ? `<span class="cost-cookie-tip" role="tooltip">${cookie.tipLines
          .map((line) => `<span>${escapeHtml(line)}</span>`)
          .join('')}</span>`
      : '';
  const tip =
    plan.priceStatus?.missing || unknown
      ? `<p class="cost-tip">${escapeHtml(plan.pricesTip || 'Run npm run fetch-prices')}</p>`
      : plan.priceStatus?.stale
        ? `<p class="cost-tip">${escapeHtml(plan.priceStatus.message || plan.pricesTip || '')}</p>`
        : '';
  costPanel.innerHTML = `
    <div class="cost-header">
      <h3>Estimated cost</h3>
      <span class="cost-total cost-cookie" tabindex="0">${escapeHtml(cookie.primary)}${tipHtml}</span>
    </div>
    ${tip}
    <div class="cost-grid">
      ${(plan.costBreakdown ?? [])
        .map(
          (c) => `
        <div class="cost-item">
          <span class="cost-count">${c.count}×</span>
          <span class="cost-label">${currencyImg(c.key)}${escapeHtml(c.label)}</span>
          <span class="cost-chaos">${c.unknown || c.chaos == null ? '?' : `${c.chaos}c`}</span>
        </div>`
        )
        .join('')}
    </div>
  `;
}

function renderAlternatives(plan) {
  if (!plan.alternatives?.length) {
    alternativesPanel.classList.add('hidden');
    return;
  }
  alternativesPanel.classList.remove('hidden');
  alternativesPanel.innerHTML = `
    <h4>Other methods considered</h4>
    <div class="alt-list">
      ${plan.alternatives
        .map(
          (a) => `
        <div class="alt-item">
          <div class="alt-name">${escapeHtml(a.name)}</div>
          <div class="alt-desc">${escapeHtml(a.description)}</div>
          <div class="alt-cost">${a.totalCost == null ? 'cost ?' : `~${a.totalCost}c`}</div>
        </div>`
        )
        .join('')}
    </div>
  `;
}

function formatStepCost(cost) {
  const labels = {
    divine: 'Divine',
    veiled: 'Veiled Exalt',
    'veiled-chaos': 'Veiled Chaos',
    harvest: 'Harvest',
    'wild-lifeforce': 'Wild LF',
    'vivid-lifeforce': 'Vivid LF',
    'primal-lifeforce': 'Primal LF',
    'sacred-lifeforce': 'Sacred LF',
    exalt: 'Exalt',
    alteration: 'Alt',
    regal: 'Regal',
    bench: 'Bench',
    essence: 'Essence',
    'essence-deafening': 'Deafening Ess.',
    'essence-screaming': 'Screaming Ess.',
    'essence-shrieking': 'Shrieking Ess.',
    'essence-wailing': 'Wailing Ess.',
    'eldritch-chaos': 'Eldritch Chaos',
    'eldritch-annul': 'Eldritch Annul',
    'eldritch-ichor': 'Ichor',
    'eldritch-ember': 'Ember',
  };
  return Object.entries(cost ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const label = labels[k] ?? k;
      return `<span class="step-cost-part">${currencyImg(k, 'currency-icon currency-icon--sm')}${Math.ceil(n)}× ${escapeHtml(label)}</span>`;
    })
    .join('<span class="step-cost-sep"> · </span>');
}

function renderPreferFractureToggle(s) {
  if (s.operator !== 'preferFracture') return '';
  const on = preferFractureEnabled;
  return `<label class="prefer-frac-toggle" title="Toggle fractured base — updates all steps and pricing">
    <input type="checkbox" data-prefer-fracture ${on ? 'checked' : ''} />
    <span class="prefer-frac-switch" aria-hidden="true"></span>
    <span class="prefer-frac-label">${on ? 'Prefer fractured' : 'Normal base'}</span>
  </label>`;
}

function renderSteps(steps) {
  stepsContainer.innerHTML = steps
    .map(
      (s) => `
    <article class="step-card${s.fallback ? ' step-fallback' : ''}${s.progressDone ? ' step-done' : ''}${s.operator === 'preferFracture' ? ' step-prefer-frac' : ''}">
      <div class="step-num">${s.step}</div>
      <div class="step-body">
        <span class="step-currency"${s.progressDone ? '' : ` style="color: ${s.currency.color}"`}>${currencyImg(s.currency.key || s.currency.short)}${escapeHtml(s.currency.short)}</span>
        ${s.chanceLabel ? `<span class="step-chance">${escapeHtml(s.chanceLabel)}</span>` : ''}
        ${renderPreferFractureToggle(s)}
        <h3>${escapeHtml(s.action)}</h3>
        <p class="step-detail">${escapeHtml(s.detail)}</p>
        ${
          s.weightLine
            ? `<p class="step-weights"><span class="step-weights-label">Weights</span> ${escapeHtml(s.weightLine)}</p>`
            : ''
        }
        ${renderTargetList(s)}
        ${formatStepCost(s.cost) ? `<div class="step-cost">${formatStepCost(s.cost)}</div>` : ''}
      </div>
    </article>
  `
    )
    .join('');
}

function renderTargetList(s) {
  const meta = s.targetMeta?.length
    ? s.targetMeta
    : (s.targetMods ?? []).map((text, i) => ({
        text,
        key: modStableKey(text),
        hit: hitKeys.has(modStableKey(text)),
        // Fallback if plan wasn't annotated yet: first essenceFish target is the guarantee
        guaranteed: s.operator === 'essenceFish' && i === 0,
      }));
  if (!meta.length) return '';
  return `<ul class="step-targets">${meta
    .map((t) => {
      const fixed = !!t.guaranteed;
      const hit = fixed || !!t.hit;
      const cls = [
        modColorClass(t.mod) || targetModClass(t.text),
        hit ? 'is-hit' : 'is-missing',
        t.softHit ? 'is-soft' : '',
        fixed ? 'is-guaranteed' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const mark = hit ? '✓' : '○';
      if (fixed) {
        return `<li class="${cls}" title="Guaranteed by essence">${mark} ${escapeHtml(t.text)} <span class="mod-tag ess">Guaranteed</span></li>`;
      }
      return `<li class="${cls}" data-mod-key="${escapeHtml(t.key).replace(/"/g, '&quot;')}" role="button" tabindex="0" title="Click if you hit this affix">${mark} ${escapeHtml(t.text)}</li>`;
    })
    .join('')}</ul>`;
}

async function applyProgressView() {
  if (!lastExport?.plan) return;
  const canPrefer =
    !!lastExport.plan.preferFractureAvailable ||
    (lastExport.plan.steps ?? []).some((s) => s.operator === 'preferFracture');

  let plan = lastExport.plan;
  let view;
  if (canPrefer) {
    const prev = lastExport.plan;
    plan = await generateCraftSteps(lastExport.item, null, { preferFracture: preferFractureEnabled });
    // Keep art / display fields from the prior analyze
    plan.artUrl = prev.artUrl;
    plan.artFallbackUrl = prev.artFallbackUrl;
    plan.artFlags = prev.artFlags;
    plan.artGlow = prev.artGlow;
    view = await replanFromProgress(lastExport.item, plan, hitKeys);
    lastExport.plan = plan;
  } else {
    view = await replanFromProgress(lastExport.item, plan, hitKeys);
  }
  lastExport.view = view;
  renderSummary(lastExport.item, plan);
  renderCostPanel(plan);
  renderAlternatives(plan);
  renderSteps(view.steps);
  renderTips(plan.tips);
}

function toggleHitKey(key) {
  if (!key || !lastExport) return;
  if (hitKeys.has(key)) hitKeys.delete(key);
  else hitKeys.add(key);
  applyProgressView();
}

stepsContainer.addEventListener('click', (e) => {
  if (e.target.closest('.prefer-frac-toggle')) return;
  const li = e.target.closest('.step-targets li[data-mod-key]');
  if (!li || li.classList.contains('is-guaranteed')) return;
  e.preventDefault();
  toggleHitKey(li.getAttribute('data-mod-key'));
});

stepsContainer.addEventListener('change', (e) => {
  const input = e.target.closest?.('input[data-prefer-fracture]');
  if (!input) return;
  preferFractureEnabled = !!input.checked;
  applyProgressView();
});

stepsContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const li = e.target.closest?.('.step-targets li[data-mod-key]');
  if (!li || li.classList.contains('is-guaranteed')) return;
  e.preventDefault();
  toggleHitKey(li.getAttribute('data-mod-key'));
});

function renderTips(tips) {
  if (!tips?.length) {
    tipsContainer.classList.add('hidden');
    return;
  }
  tipsContainer.classList.remove('hidden');
  tipsContainer.innerHTML = `
    <h4>Tips</h4>
    <ul>${tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  `;
}

function formatCostLine(cost) {
  return Object.entries(cost ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${Math.ceil(n)}x ${k}`)
    .join(', ');
}

/** Structured text for pasting into chat / agent feedback. */
export function buildFeedbackExport(item, plan, rawItemText) {
  const lines = [];
  lines.push('```craft-plan');
  lines.push('HOWDOICRAFTTHIS_PLAN v1');
  lines.push('');
  lines.push('## Item');
  lines.push(`name: ${item.itemName ?? '(none)'}`);
  lines.push(`base: ${item.baseName}`);
  lines.push(`class: ${item.itemClass}`);
  lines.push(`rarity: ${item.rarity}`);
  lines.push(`ilvl: ${item.itemLevel ?? '?'}`);
  lines.push(`fracturedItem: ${!!item.fracturedItem}`);
  lines.push(`advancedFormat: ${!!item.advancedFormat}`);
  if (item.implicits?.length) {
    lines.push('implicits:');
    for (const m of item.implicits) lines.push(`  - ${m.text}`);
  }
  lines.push('mods:');
  for (const m of item.explicitMods) {
    const flags = [
      m.gen || m.type,
      m.fractured && 'fractured',
      m.crafted && 'crafted',
      m.ofEssence && 'essence',
      m.veiled && 'veiled',
      m.tier != null && `T${m.tier}`,
      m.tags?.length && `tags=${m.tags.join('/')}`,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  - [${flags}] ${m.text.replace(/\n/g, ' | ')}`);
  }
  lines.push('');
  lines.push('## Method');
  lines.push(`method: ${plan.methodName ?? plan.method}`);
  lines.push(`summary: ${plan.summary}`);
  lines.push(`minIlvl: ${plan.minIlvl ?? '?'}`);
  if (plan.ilvlDrivers?.length) {
    lines.push('ilvlDrivers:');
    for (const d of plan.ilvlDrivers) lines.push(`  - ilvl ${d.req}: ${d.text}`);
  }
  lines.push(`totalCostChaos: ${plan.totalCost}`);
  if (plan.preferFractureAvailable || plan.steps?.some((s) => s.operator === 'preferFracture')) {
    lines.push(`preferFracture: ${plan.preferFractureEnabled !== false}`);
  }
  if (plan.costBreakdown?.length) {
    lines.push('costBreakdown:');
    for (const c of plan.costBreakdown) {
      lines.push(`  - ${c.count}x ${c.label} (${c.chaos}c)`);
    }
  }
  lines.push('');
  if (plan.modAnalysis?.length) {
    lines.push('## Mod methods');
    for (const m of plan.modAnalysis) {
      lines.push(
        `  - [${m.method ?? m.source ?? '?'}|${m.chanceLabel ?? ''}] ${m.text?.replace(/\n/g, ' | ')}`
      );
    }
    lines.push('');
  }
  lines.push('## Steps');
  for (const s of plan.steps) {
    lines.push(`### Step ${s.step}`);
    lines.push(`operator: ${s.operator ?? '?'}`);
    lines.push(`currency: ${s.currency?.short ?? s.currency?.name ?? '?'}`);
    lines.push(`action: ${s.action}`);
    lines.push(`detail: ${s.detail}`);
    if (s.chanceLabel) lines.push(`chance: ${s.chanceLabel}`);
    if (s.weightLine) lines.push(`weights: ${s.weightLine}`);
    if (s.fallback) lines.push('fallback: true');
    if (s.targetMods?.length) {
      lines.push('targets:');
      for (const t of s.targetMods) lines.push(`  - ${t}`);
    }
    const cost = formatCostLine(s.cost);
    if (cost) lines.push(`cost: ${cost}`);
    lines.push('');
  }
  if (plan.alternatives?.length) {
    lines.push('## AlternativesConsidered');
    for (const a of plan.alternatives) {
      lines.push(`  - ${a.name}: ~${a.totalCost}c — ${a.description ?? ''}`);
    }
    lines.push('');
  }
  if (plan.modAnalysis?.length) {
    lines.push('## ModAnalysis');
    for (const m of plan.modAnalysis) {
      lines.push(
        `  - source=${m.source ?? '?'} type=${m.type ?? '?'} matched=${!!m.matched} :: ${String(m.text).replace(/\n/g, ' | ')}`
      );
    }
    lines.push('');
  }
  lines.push('## RawItem');
  lines.push(rawItemText.trim());
  lines.push('```');
  lines.push('');
  lines.push('(Paste this block and tell me what should change.)');
  return lines.join('\n');
}

async function copyPlanFeedback() {
  if (!lastExport) {
    exportStatus.textContent = 'Analyze an item first.';
    return;
  }
  // Prefer progress view (keeps final bench craft) so export matches the UI steps list
  const planForExport = lastExport.view
    ? {
        ...lastExport.plan,
        steps: lastExport.view.steps,
        preferFractureEnabled,
      }
    : { ...lastExport.plan, preferFractureEnabled };
  const text = buildFeedbackExport(lastExport.item, planForExport, lastExport.raw);
  try {
    await navigator.clipboard.writeText(text);
    exportStatus.textContent = 'Copied — paste into chat.';
  } catch {
    // Fallback: select in a temp textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    exportStatus.textContent = 'Copied — paste into chat.';
  }
  setTimeout(() => {
    if (exportStatus.textContent.startsWith('Copied')) exportStatus.textContent = '';
  }, 2500);
}

async function showPlan(item, raw) {
  const plan = await generateCraftSteps(item, (p) => {
    if (p.phase === 'loading-data' || p.phase === 'loading-knowledge') setLoading(true, 'Loading craft data…');
    else if (p.phase === 'matching-mods') setLoading(true, 'Matching mods…');
    else if (p.phase === 'searching' || p.phase === 'planning') {
      setLoading(true, p.total ? `Searching methods ${p.current}/${p.total}…` : 'Planning craft…');
    } else if (p.phase === 'done') setLoading(true, 'Picking cheapest…');
  });
  hitKeys = new Set();
  preferFractureEnabled = true;
  const view = await replanFromProgress(item, plan, hitKeys);
  lastExport = { item, plan, view, raw };
  renderSummary(item, plan);
  renderCostPanel(plan);
  renderAlternatives(plan);
  renderSteps(view.steps);
  renderTips(plan.tips);
  // Keep Paste/Build tabs available for mid-process edits
  emptyState.classList.remove('hidden');
  results.classList.remove('hidden');
  setHasItem(true);
  await syncBuilderFromItem(item, plan, { force: true });
}

async function analyze(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    showError('Clipboard is empty. Copy an item in-game with Ctrl+C, then paste here.');
    return;
  }
  if (analyzing) return;

  hideError();
  setLoading(true, 'Loading craft data…');
  exportStatus.textContent = '';
  emptyState.classList.remove('hidden');
  results.classList.add('hidden');
  setHasItem(false);
  try {
    const item = parseItem(text);
    await showPlan(item, text);
  } catch (e) {
    console.error(e);
    lastExport = null;
    showError(e.message ?? 'Not a valid item. Copy from in-game with Ctrl+C, then paste here.');
  } finally {
    setLoading(false);
  }
}

async function analyzeBuiltItem(item) {
  if (analyzing) return;
  hideError();
  setLoading(true, 'Loading craft data…');
  exportStatus.textContent = '';
  emptyState.classList.remove('hidden');
  results.classList.add('hidden');
  setHasItem(false);
  try {
    const raw = `[Built] ${item.baseName} ilvl ${item.itemLevel}\n${(item.explicitMods ?? [])
      .map((m) => m.text)
      .join('\n')}`;
    await showPlan(item, raw);
  } catch (e) {
    console.error(e);
    lastExport = null;
    showError(e.message ?? 'Could not plan this built item.');
  } finally {
    setLoading(false);
  }
}

/* ─── Build tab ─── */

const CAT_DEFS = [
  { id: 'natural', label: 'Natural' },
  { id: 'influence', label: 'Influence' },
  { id: 'unveiled', label: 'Unveiled' },
  { id: 'crafted', label: 'Bench' },
  { id: 'essence', label: 'Essence' },
  { id: 'eldritch', label: 'Eldritch' },
  { id: 'enchant', label: 'Enchant' },
];

async function ensureKb() {
  if (kbCache) return kbCache;
  statusEl.textContent = 'Loading craft data…';
  kbCache = await loadKnowledgeBase();
  allBases = listCraftableBases(kbCache);
  statusEl.textContent = '';
  return kbCache;
}

function currentInfluences() {
  const s = new Set(selectedInfluences.filter((i) => INFLUENCE_NAMES.includes(i)));
  for (const m of selectedMods) {
    if (m._category !== 'influence') continue;
    for (const i of m.influences ?? []) {
      if (INFLUENCE_NAMES.includes(i)) s.add(i);
    }
    if (m._influence && INFLUENCE_NAMES.includes(m._influence)) s.add(m._influence);
  }
  return [...s];
}

function markBuilderDirty() {
  builderDirty = true;
}

function applyHydratedBuilder(hydrated) {
  const { base, mods, itemLevel, influences } = hydrated;
  if (ilvlInput) ilvlInput.value = String(itemLevel || 86);
  selectedInfluences = [...(influences ?? [])].filter((i) => INFLUENCE_NAMES.includes(i));

  if (!base) {
    selectedBase = null;
    selectedMods = [];
    categories = null;
    if (baseSearch) baseSearch.value = '';
    if (selectedBaseEl) {
      selectedBaseEl.textContent = 'No base selected';
      selectedBaseEl.classList.add('muted');
    }
    renderBuilderCats();
    renderSelectedMods();
    renderCannotRoll();
    renderModBrowser();
    updatePlanBtn();
    return;
  }

  selectedBase = base;
  selectedMods = mods ?? [];
  activeTag = '';
  if (baseSearch) baseSearch.value = base.name;
  baseList?.classList.add('hidden');
  if (selectedBaseEl) {
    const infLabel = selectedInfluences.length ? ` · ${selectedInfluences.join(' + ')}` : '';
    selectedBaseEl.innerHTML = `<strong>${escapeHtml(base.name)}</strong> · ${escapeHtml(base.item_class)}${escapeHtml(infLabel)}`;
    selectedBaseEl.classList.remove('muted');
  }

  categories = eligibleModsByCategory(kbCache, base, {
    itemLevel: Number(ilvlInput?.value) || itemLevel || 86,
    influenced: currentInfluences(),
  });
  const first = CAT_DEFS.find((c) => {
    if (c.id === 'influence') return Object.keys(categories.influence ?? {}).length;
    return (categories[c.id] ?? []).length;
  });
  activeCat = first?.id ?? 'natural';
  builderDirty = false;
  renderBuilderCats();
  renderSelectedMods();
  renderCannotRoll();
  renderModBrowser();
  updatePlanBtn();
}

/** Sync Build from last planned / pasted item. force=true overwrites user edits. */
async function syncBuilderFromItem(item, plan, { force = false } = {}) {
  if (!item) return;
  if (!force && builderDirty && selectedBase) return;
  const kb = await ensureKb();
  applyHydratedBuilder(hydrateBuilderFromItem(kb, item, plan));
}

async function syncBuilderFromLastExport({ force = false } = {}) {
  if (!lastExport?.item) return;
  await syncBuilderFromItem(lastExport.item, lastExport.plan, { force });
}

function setInputMode(mode) {
  inputMode = mode;
  const isPaste = mode === 'paste';
  tabPaste?.classList.toggle('is-active', isPaste);
  tabBuild?.classList.toggle('is-active', !isPaste);
  tabPaste?.setAttribute('aria-selected', String(isPaste));
  tabBuild?.setAttribute('aria-selected', String(!isPaste));
  panelPaste?.classList.toggle('hidden', !isPaste);
  panelBuild?.classList.toggle('hidden', isPaste);
  if (panelPaste) panelPaste.hidden = !isPaste;
  if (panelBuild) panelBuild.hidden = isPaste;
  if (!isPaste) {
    ensureKb().then(async () => {
      // Hydrate when empty, or refresh from current item if user hasn't edited Build
      if (lastExport?.item && (!selectedBase || !builderDirty)) {
        await syncBuilderFromLastExport({ force: !selectedBase });
      }
      renderBuilderCats();
      renderSelectedMods();
      renderModBrowser();
    });
  }
}

async function openBuildFromResults() {
  // Switch tab without auto-hydrate; force sync from the active plan item
  inputMode = 'build';
  tabPaste?.classList.toggle('is-active', false);
  tabBuild?.classList.toggle('is-active', true);
  tabPaste?.setAttribute('aria-selected', 'false');
  tabBuild?.setAttribute('aria-selected', 'true');
  panelPaste?.classList.toggle('hidden', true);
  panelBuild?.classList.toggle('hidden', false);
  if (panelPaste) panelPaste.hidden = true;
  if (panelBuild) panelBuild.hidden = false;
  await syncBuilderFromLastExport({ force: true });
  emptyState?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderBaseDropdown(bases) {
  if (!baseList) return;
  if (!bases.length) {
    baseList.innerHTML = `<li class="muted">No bases match</li>`;
    baseList.classList.remove('hidden');
    return;
  }
  baseList.innerHTML = bases
    .map(
      (b, i) =>
        `<li role="option" data-idx="${i}" class="${i === baseHighlight ? 'is-active' : ''}"><span>${escapeHtml(b.name)}</span><span class="cls">${escapeHtml(b.item_class)}</span></li>`
    )
    .join('');
  baseList.classList.remove('hidden');
  baseList._bases = bases;
}

function pickBase(base) {
  selectedBase = base;
  selectedMods = [];
  selectedInfluences = [];
  activeTag = '';
  expandedFamilies = new Set();
  lastModSearch = '';
  markBuilderDirty();
  if (baseSearch) baseSearch.value = base.name;
  baseList?.classList.add('hidden');
  if (selectedBaseEl) {
    selectedBaseEl.innerHTML = `<strong>${escapeHtml(base.name)}</strong> · ${escapeHtml(base.item_class)}`;
    selectedBaseEl.classList.remove('muted');
  }
  const kb = kbCache;
  categories = eligibleModsByCategory(kb, base, {
    itemLevel: Number(ilvlInput?.value) || 86,
  });
  // Prefer a category that has mods
  const first = CAT_DEFS.find((c) => {
    if (c.id === 'influence') return Object.keys(categories.influence ?? {}).length;
    return (categories[c.id] ?? []).length;
  });
  activeCat = first?.id ?? 'natural';
  renderBuilderCats();
  renderSelectedMods();
  renderCannotRoll();
  renderModBrowser();
  updatePlanBtn();
}

function renderBuilderCats() {
  if (!builderCats) return;
  builderCats.innerHTML = CAT_DEFS.map((c) => {
    let n = 0;
    if (categories) {
      if (c.id === 'influence') n = Object.values(categories.influence ?? {}).reduce((s, a) => s + a.length, 0);
      else n = (categories[c.id] ?? []).length;
    }
    const disabled = !categories || n === 0;
    return `<button type="button" class="builder-cat${activeCat === c.id ? ' is-active' : ''}" data-cat="${c.id}" ${disabled ? 'disabled' : ''}>${c.label}${n ? ` · ${n}` : ''}</button>`;
  }).join('');
}

function renderCannotRoll() {
  if (!cannotRollEl || !kbCache) return;
  const notice = cannotRollNotice(kbCache, selectedBase, selectedMods);
  if (!notice) {
    cannotRollEl.classList.add('hidden');
    cannotRollEl.textContent = '';
    return;
  }
  const bits = notice.labels.join(' · ');
  const extra = notice.blockedTags?.length ? ` (blocks: ${notice.blockedTags.join(', ')})` : '';
  cannotRollEl.textContent = `${bits}${extra}`;
  cannotRollEl.classList.remove('hidden');
}

function chipClass(mod) {
  const c = mod._category || mod.source;
  if (c === 'crafted') return 'is-crafted';
  if (c === 'unveiled') return 'is-unveil';
  if (c === 'essence') return 'is-ess';
  if (c === 'influence') return 'is-inf';
  return '';
}

function renderSelectedMods() {
  if (!selectedModsEl) return;
  selectedEmptyEl?.classList.toggle('hidden', selectedMods.length > 0);
  selectedModsEl.innerHTML = selectedMods
    .map((m, i) => {
      const gen = m.generation === 'prefix' || m.generation === 'suffix' ? m.generation : m._gen || '';
      const full = modDisplayText(m);
      const label = full.split('\n')[0];
      return `<li class="builder-chip ${chipClass(m)}"><span class="chip-gen">${escapeHtml(gen ? gen.slice(0, 1).toUpperCase() : '·')}</span><span class="chip-text" title="${escapeHtml(full)}">${escapeHtml(label)}</span><button type="button" data-rm="${i}" aria-label="Remove">×</button></li>`;
    })
    .join('');
  updatePlanBtn();
  renderCannotRoll();
}

function updatePlanBtn() {
  if (planBtn) planBtn.disabled = !selectedBase || selectedMods.length === 0 || analyzing;
}

function renderModBrowser() {
  if (!modListEl) return;
  if (!selectedBase || !categories) {
    modListEl.innerHTML = `<div class="builder-mod-empty">Select a base to browse mods.</div>`;
    if (builderTags) {
      builderTags.hidden = true;
      builderTags.innerHTML = '';
    }
    return;
  }
  const filters = {
    gen: builderGen?.value || '',
    search: modSearch?.value || '',
    tag: activeTag,
  };
  const mods = filterCategoryMods(categories, activeCat, filters);
  const tags = collectTags(
    activeCat === 'influence'
      ? Object.values(categories.influence ?? {}).flat()
      : categories[activeCat] ?? []
  );
  if (builderTags) {
    if (tags.length) {
      builderTags.hidden = false;
      builderTags.innerHTML = [
        `<button type="button" class="builder-tag${!activeTag ? ' is-active' : ''}" data-tag="">All tags</button>`,
        ...tags.map(
          (t) =>
            `<button type="button" class="builder-tag${activeTag === t ? ' is-active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t.replace(/_/g, ' '))}</button>`
        ),
      ].join('');
    } else {
      builderTags.hidden = true;
      builderTags.innerHTML = '';
    }
  }

  if (!mods.length) {
    modListEl.innerHTML = `<div class="builder-mod-empty">No mods match these filters.</div>`;
    modListEl._mods = [];
    return;
  }

  const families = groupModsByFamily(mods);
  const q = String(filters.search).trim();
  if (q !== lastModSearch) {
    lastModSearch = q;
    if (q && families.length <= 10) {
      for (const f of families) expandedFamilies.add(f.key);
    }
  }

  const selectedIds = new Set(selectedMods.map((m) => m.id));
  let html = '';
  let lastSection = null;
  for (const fam of families) {
    if (fam.section && fam.section !== lastSection) {
      lastSection = fam.section;
      html += `<div class="builder-mod-section">${escapeHtml(fam.section)}</div>`;
    }
    const open = expandedFamilies.has(fam.key);
    const nAdded = fam.tiers.filter((t) => selectedIds.has(t.id)).length;
    const selected = nAdded > 0;
    const nTiers = fam.tiers.length;
    const bestRange = modRangeLabel(fam.tiers[0]);
    const meta = [
      fam.generation,
      nTiers > 1 ? `T1–T${nTiers}` : null,
      bestRange,
      nAdded ? `${nAdded} added` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    html += `<div class="builder-family${open ? ' is-open' : ''}${selected ? ' is-selected' : ''}">
      <button type="button" class="builder-family-head" data-family-key="${escapeHtml(fam.key).replace(/"/g, '&quot;')}" aria-expanded="${open}">
        <span class="builder-family-chevron" aria-hidden="true"></span>
        <span class="builder-family-label">${escapeHtml(fam.label)}</span>
        <span class="builder-family-meta">${escapeHtml(meta)}</span>
      </button>`;
    if (open) {
      html += `<div class="builder-family-tiers">`;
      for (const mod of fam.tiers) {
        const added = selectedIds.has(mod.id);
        const range = modRangeLabel(mod);
        const line = modDisplayText(mod);
        const tierMeta = [
          mod.name || null,
          range && !/\(\d/.test(line) ? range : null,
          mod.required_level != null ? `ilvl ${mod.required_level}` : null,
          mod._weight != null && mod._weight !== 100 ? `w ${Math.round(mod._weight)}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        html += `<button type="button" class="builder-mod${added ? ' is-added' : ''}" data-mod-id="${escapeHtml(mod.id)}" ${added ? 'disabled' : ''}>
          <span>${escapeHtml(line).replace(/\n/g, ' · ')}</span>
          <span class="mod-add">${added ? 'Added' : '+ Add'}</span>
          <span class="mod-meta">${escapeHtml(tierMeta)}</span>
        </button>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  modListEl.innerHTML = html;
  modListEl._mods = mods;
}

function addModById(id) {
  const pool = modListEl?._mods ?? [];
  const mod = pool.find((m) => m.id === id);
  if (!mod || selectedMods.some((m) => m.id === id)) return;
  selectedMods = [...selectedMods, mod];
  markBuilderDirty();
  // Influence mods: refresh categories with influence tags so natural+influence weights stay honest for cannot-roll
  if (mod._category === 'influence' && selectedBase && kbCache) {
    categories = eligibleModsByCategory(kbCache, selectedBase, {
      itemLevel: Number(ilvlInput?.value) || 86,
      influenced: currentInfluences(),
    });
    renderBuilderCats();
  }
  renderSelectedMods();
  renderModBrowser();
}

function removeModAt(idx) {
  selectedMods = selectedMods.filter((_, i) => i !== idx);
  markBuilderDirty();
  if (selectedBase && kbCache) {
    categories = eligibleModsByCategory(kbCache, selectedBase, {
      itemLevel: Number(ilvlInput?.value) || 86,
      influenced: currentInfluences(),
    });
    renderBuilderCats();
  }
  renderSelectedMods();
  renderModBrowser();
}

function resetBuilder() {
  selectedBase = null;
  selectedMods = [];
  selectedInfluences = [];
  categories = null;
  activeCat = 'natural';
  activeTag = '';
  expandedFamilies = new Set();
  lastModSearch = '';
  builderDirty = false;
  if (baseSearch) baseSearch.value = '';
  if (ilvlInput) ilvlInput.value = '86';
  if (modSearch) modSearch.value = '';
  if (builderGen) builderGen.value = '';
  baseList?.classList.add('hidden');
  if (selectedBaseEl) {
    selectedBaseEl.textContent = 'No base selected';
    selectedBaseEl.classList.add('muted');
  }
  renderBuilderCats();
  renderSelectedMods();
  renderCannotRoll();
  renderModBrowser();
  updatePlanBtn();
}

async function planBuilt() {
  try {
    const item = buildSyntheticItem({
      base: selectedBase,
      mods: selectedMods,
      itemLevel: Number(ilvlInput?.value) || 86,
      influences: currentInfluences(),
    });
    builderDirty = false;
    await analyzeBuiltItem(item);
  } catch (e) {
    showError(e.message ?? 'Could not build item.');
  }
}

/** Hotkey: random 4 natural + 1 bench craft → Build tab + plan. */
async function randomAndPlan() {
  if (analyzing) return;
  try {
    const kb = await ensureKb();
    const picked = pickRandomBuild(kb);
    const item = buildSyntheticItem({
      base: picked.base,
      mods: picked.mods,
      itemLevel: picked.itemLevel,
      influences: picked.influences ?? [],
    });
    // Plan first (showPlan hydrates Build); then switch tab so lastExport matches.
    await analyzeBuiltItem(item);
    setInputMode('build');
  } catch (e) {
    showError(e.message ?? 'Could not generate a random item.');
  }
}

const pasteCatcher = document.getElementById('paste-catcher');
/** Set on Ctrl/Cmd+V; cleared when paste event handles clipboardData. */
let awaitingPasteEvent = false;

function isEditableTarget(el) {
  if (!el || el === pasteCatcher) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onGlobalHotkey(e) {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isEditableTarget(e.target)) return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    randomAndPlan();
  }
}

function pasteFromEvent(e) {
  if (isEditableTarget(e.target)) return;
  const text = e.clipboardData?.getData('text/plain') ?? e.clipboardData?.getData('text') ?? '';
  if (!text.trim()) return;
  e.preventDefault();
  awaitingPasteEvent = false;
  if (pasteCatcher) pasteCatcher.value = '';
  analyze(text);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    await analyze(text);
  } catch {
    showError('Could not read clipboard. Press Ctrl+V to paste instead.');
  }
}

/** Chromium only fires paste into an editable; arm catcher before the paste event. */
function armPasteCatcher(e) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
  if (e.altKey || e.repeat) return;
  if (isEditableTarget(e.target)) return;
  awaitingPasteEvent = true;
  pasteCatcher?.focus({ preventScroll: true });
  // Fallback if Electron/browser never emits paste (no editable / menu race).
  setTimeout(() => {
    if (!awaitingPasteEvent) return;
    awaitingPasteEvent = false;
    pasteFromClipboard();
  }, 50);
}

function clearResults() {
  lastExport = null;
  hitKeys = new Set();
  preferFractureEnabled = true;
  exportStatus.textContent = '';
  results.classList.add('hidden');
  emptyState.classList.remove('hidden');
  setHasItem(false);
  hideError();
  statusEl.textContent = '';
  resetBuilder();
}

document.getElementById('random-plan-btn')?.addEventListener('click', () => {
  randomAndPlan();
});

window.addEventListener('keydown', armPasteCatcher, true);
window.addEventListener('keydown', onGlobalHotkey);
window.addEventListener('paste', pasteFromEvent);
dropZone?.addEventListener('click', pasteFromClipboard);
exportBtn.addEventListener('click', copyPlanFeedback);
clearBtn.addEventListener('click', clearResults);

tabPaste?.addEventListener('click', () => setInputMode('paste'));
tabBuild?.addEventListener('click', () => setInputMode('build'));
editInBuildBtn?.addEventListener('click', () => openBuildFromResults());

baseSearch?.addEventListener('input', () => {
  baseHighlight = 0;
  const hits = searchBases(allBases, baseSearch.value, 35);
  renderBaseDropdown(hits);
});
baseSearch?.addEventListener('focus', () => {
  if (!allBases.length) return;
  renderBaseDropdown(searchBases(allBases, baseSearch.value, 35));
});
baseSearch?.addEventListener('keydown', (e) => {
  const bases = baseList?._bases ?? [];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    baseHighlight = Math.min(baseHighlight + 1, Math.max(bases.length - 1, 0));
    renderBaseDropdown(bases);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    baseHighlight = Math.max(baseHighlight - 1, 0);
    renderBaseDropdown(bases);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (bases[baseHighlight]) pickBase(bases[baseHighlight]);
  } else if (e.key === 'Escape') {
    baseList?.classList.add('hidden');
  }
});
baseList?.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-idx]');
  if (!li) return;
  e.preventDefault();
  const bases = baseList._bases ?? [];
  const b = bases[Number(li.dataset.idx)];
  if (b) pickBase(b);
});
document.addEventListener('click', (e) => {
  if (e.target.closest?.('.builder-base')) return;
  baseList?.classList.add('hidden');
});

builderCats?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn || btn.disabled) return;
  activeCat = btn.dataset.cat;
  activeTag = '';
  expandedFamilies = new Set();
  lastModSearch = '';
  renderBuilderCats();
  renderModBrowser();
});

builderGen?.addEventListener('change', () => renderModBrowser());
modSearch?.addEventListener('input', () => renderModBrowser());
builderTags?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tag]');
  if (!btn) return;
  activeTag = btn.dataset.tag || '';
  renderModBrowser();
});

modListEl?.addEventListener('click', (e) => {
  const head = e.target.closest('[data-family-key]');
  if (head) {
    const key = head.dataset.familyKey;
    if (expandedFamilies.has(key)) expandedFamilies.delete(key);
    else expandedFamilies.add(key);
    renderModBrowser();
    return;
  }
  const btn = e.target.closest('[data-mod-id]');
  if (!btn || btn.disabled) return;
  addModById(btn.dataset.modId);
});

selectedModsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rm]');
  if (!btn) return;
  removeModAt(Number(btn.dataset.rm));
});

planBtn?.addEventListener('click', planBuilt);
resetBuildBtn?.addEventListener('click', resetBuilder);

ilvlInput?.addEventListener('change', () => {
  markBuilderDirty();
  if (!selectedBase || !kbCache) return;
  categories = eligibleModsByCategory(kbCache, selectedBase, {
    itemLevel: Number(ilvlInput.value) || 86,
    influenced: currentInfluences(),
  });
  renderBuilderCats();
  renderModBrowser();
});

export { analyze, analyzeBuiltItem };
