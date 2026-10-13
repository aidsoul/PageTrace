import browser from 'webextension-polyfill';
import { getSettings, saveSettings, formatHotkeyEvent, matchesHotkey } from '@/common/settings';
import { getStorageStats, clearDatabase, getAllCustomIndexes, updateCustomIndex, deleteCustomIndex, countPagesForAllTags, clearPagesByTag, addCustomIndex } from '@/db/index';
import type { CustomTagIndex, MediaExtension, SiteTagRule, UserSettings, AutoTagRule, TagCatalogItem } from '@/types/index';
import { getLocale, applyI18nToDOM, AVAILABLE_LANGUAGES, DEFAULT_LANGUAGE } from '@/i18n/index';
import { TAG_COLORS, normalizeTagName, renderTagBadge, escapeHtml, escapeAttr, setSafeHtml } from '@/common/tags';

const ALL_MEDIA_EXTS: MediaExtension[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv'];

let currentLang = DEFAULT_LANGUAGE;
let currentAutoRules: AutoTagRule[] = [];
let currentTagCatalog: TagCatalogItem[] = [];
let selectedNewTagColor = TAG_COLORS[0]?.id || 'slate';


// DOM helpers
function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatBytes(bytes: number): string {
  const isRu = currentLang === 'ru';
  const units = isRu ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return `0 ${units[0]}`;
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${units[1]}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} ${units[2]}`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ${units[3]}`;
}

function debounce<T extends (...args: any[]) => void>(fn: T, delay = 500): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

// Language selection
function populateLanguageSelect(): void {
  const select = $<HTMLSelectElement>('language');
  if (!select) return;
  select.replaceChildren();
  AVAILABLE_LANGUAGES.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    select.appendChild(opt);
  });
}

// Media whitelist checkboxes
function renderMediaWhitelist(selected: MediaExtension[]): void {
  const container = $('mediaWhitelist');
  container.replaceChildren();
  ALL_MEDIA_EXTS.forEach((ext) => {
    const chip = document.createElement('label');
    chip.className = 'checkbox-chip' + (selected.includes(ext) ? ' checked' : '');
    setSafeHtml(chip, `<input type="checkbox" value="${escapeAttr(ext)}" ${selected.includes(ext) ? 'checked' : ''} />.${escapeHtml(ext)}`);
    chip.querySelector('input')!.addEventListener('change', () => {
      chip.classList.toggle('checked');
      autoSaveCurrentSettings();
    });
    container.appendChild(chip);
  });
}

function getSelectedMediaExts(): MediaExtension[] {
  return Array.from($('mediaWhitelist').querySelectorAll<HTMLInputElement>('input:checked')).map(
    (el) => el.value as MediaExtension,
  );
}

// Per-site indexing rules
function renderSiteRules(rules: SiteTagRule[]): void {
  const container = $('siteRulesList');
  container.replaceChildren();

  const t = getLocale(currentLang);
  if (!rules || rules.length === 0) {
    setSafeHtml(container, `<div class="empty-rules-hint">${escapeHtml(t.options.indexing.emptyRulesHint)}</div>`);
    return;
  }

  rules.forEach((rule) => {
    container.appendChild(createRuleRow(rule.domain, rule.tags));
  });
}

function createRuleRow(domain = '', tags = ''): HTMLElement {
  const t = getLocale(currentLang);
  const row = document.createElement('div');
  row.className = 'rule-item';
  setSafeHtml(
    row,
    `
    <input type="text" class="domain-input" placeholder="${escapeAttr(t.options.indexing.domainPlaceholder)}" value="${escapeAttr(domain)}" />
    <input type="text" class="tags-input" placeholder="${escapeAttr(t.options.indexing.tagsPlaceholder)}" value="${escapeAttr(tags)}" />
    <button type="button" class="rule-del-btn" title="${escapeAttr(t.options.indexing.delRuleBtnTitle)}">✕</button>
  `,
  );

  const domainInput = row.querySelector('.domain-input') as HTMLInputElement;
  const tagsInput = row.querySelector('.tags-input') as HTMLInputElement;

  domainInput.addEventListener('change', () => autoSaveCurrentSettings());
  tagsInput.addEventListener('change', () => autoSaveCurrentSettings());
  domainInput.addEventListener('input', debouncedAutoSave);
  tagsInput.addEventListener('input', debouncedAutoSave);

  row.querySelector('.rule-del-btn')!.addEventListener('click', async () => {
    row.remove();
    const container = $('siteRulesList');
    if (container.querySelectorAll('.rule-item').length === 0) {
      setSafeHtml(container, `<div class="empty-rules-hint">${escapeHtml(getLocale(currentLang).options.indexing.emptyRulesHint)}</div>`);
    }
    await autoSaveCurrentSettings();
  });

  return row;
}

function collectSiteRules(): SiteTagRule[] {
  const container = $('siteRulesList');
  const rows = container.querySelectorAll('.rule-item');
  const rules: SiteTagRule[] = [];
  const seenDomains = new Set<string>();

  rows.forEach((row) => {
    const domain = (row.querySelector('.domain-input') as HTMLInputElement)?.value.trim();
    const rawTags = (row.querySelector('.tags-input') as HTMLInputElement)?.value.trim() ?? '';
    if (!domain) return;

    const normDomain = domain.toLowerCase();
    if (seenDomains.has(normDomain)) return;
    seenDomains.add(normDomain);

    // Deduplicate selectors within tags
    const seenSelectors = new Set<string>();
    const uniqueSelectors = rawTags
      .split(',')
      .map((s) => s.trim())
      .filter((s) => {
        if (!s) return false;
        const normSel = s.toLowerCase();
        if (seenSelectors.has(normSel)) return false;
        seenSelectors.add(normSel);
        return true;
      });

    rules.push({ domain, tags: uniqueSelectors.join(', ') });
  });

  return rules;
}

// Auto-tagging rules table
async function renderAutoRulesTable(): Promise<void> {
  const container = $('autoRulesTable');
  if (!container) return;
  container.replaceChildren();

  const t = getLocale(currentLang);
  if (!currentAutoRules || currentAutoRules.length === 0) {
    setSafeHtml(
      container,
      `<div class="empty-rules-hint" style="padding:14px;text-align:center;color:var(--text-muted);font-size:13px;">${escapeHtml(t.options.indexes.emptyAutoRules)}</div>`,
    );
    return;
  }

  // Preload counts in a single DB pass
  const countsMap = await countPagesForAllTags(
    currentAutoRules.map((rule) => rule.tag),
    currentAutoRules,
  );

  currentAutoRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'auto-rule-row';

    const count = countsMap.get(normalizeTagName(rule.tag)) || 0;
    const badgeHtml = renderTagBadge(rule.tag, currentTagCatalog);

    setSafeHtml(
      row,
      `
      <div class="auto-rule-left">
        <span class="auto-rule-pattern" title="${escapeAttr(rule.pattern)}">${escapeHtml(rule.pattern)}</span>
        <span class="auto-rule-arrow">→</span>
        ${badgeHtml}
      </div>
      <div class="auto-rule-right">
        <span class="auto-rule-count">${escapeHtml(t.options.indexes.savedPagesCount(count))}</span>
        <button type="button" class="btn btn-ghost btn-xs rule-del-btn" title="${escapeAttr(t.options.indexes.delAutoRuleTitle)}" style="color:var(--text-muted);">✕</button>
      </div>
    `,
    );

    row.querySelector('.rule-del-btn')!.addEventListener('click', async () => {
      currentAutoRules.splice(idx, 1);
      await saveSettings({ autoTagRules: currentAutoRules });
      await renderAutoRulesTable();
      showStatus(t.options.statusSaved);
    });

    container.appendChild(row);
  });
}

function initAutoRulesControls(): void {
  const addBtn = $('addAutoRuleBtn');
  const patternInput = $<HTMLInputElement>('newRulePattern');
  const tagInput = $<HTMLInputElement>('newRuleTag');

  async function handleAdd(): Promise<void> {
    const pattern = patternInput?.value.trim() ?? '';
    const rawTag = tagInput?.value.trim() ?? '';
    const tag = normalizeTagName(rawTag);
    const t = getLocale(currentLang);

    if (!pattern || !tag) {
      showStatus(t.options.statusRequiredFields, 'var(--danger)');
      return;
    }

    const normPattern = pattern.toLowerCase();
    const isDuplicate = currentAutoRules.some(
      (r) => r.pattern.trim().toLowerCase() === normPattern && normalizeTagName(r.tag) === tag,
    );
    if (isDuplicate) {
      showStatus(t.options.statusDuplicateRule, 'var(--danger)');
      return;
    }

    currentAutoRules.push({
      id: 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      pattern,
      tag,
    });

    if (patternInput) patternInput.value = '';
    if (tagInput) tagInput.value = '';

    await saveSettings({ autoTagRules: currentAutoRules });
    await renderAutoRulesTable();
    showStatus(t.options.statusSaved);
  }

  addBtn?.addEventListener('click', handleAdd);
  patternInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd();
  });
  tagInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd();
  });
}

// Tag catalog
function renderTagPalettePicker(): void {
  const picker = $('tagPalettePicker');
  if (!picker) return;
  picker.replaceChildren();

  TAG_COLORS.forEach((colorDef) => {
    const swatch = document.createElement('div');
    swatch.className = `tag-color-swatch${colorDef.id === selectedNewTagColor ? ' active' : ''}`;
    swatch.style.backgroundColor = colorDef.color;
    swatch.title = currentLang === 'ru' ? colorDef.nameRu : colorDef.nameEn;
    swatch.addEventListener('click', () => {
      selectedNewTagColor = colorDef.id;
      picker.querySelectorAll('.tag-color-swatch').forEach((s) => s.classList.remove('active'));
      swatch.classList.add('active');
    });
    picker.appendChild(swatch);
  });
}

async function renderTagCatalog(): Promise<void> {
  const grid = $('tagCatalogGrid');
  if (!grid) return;
  grid.replaceChildren();

  const t = getLocale(currentLang);
  if (!currentTagCatalog || currentTagCatalog.length === 0) {
    setSafeHtml(
      grid,
      `<div class="empty-rules-hint" style="grid-column: 1 / -1; text-align:center; padding: 20px; color:var(--text-muted);">${escapeHtml(t.options.indexes.emptyTagCatalog)}</div>`,
    );
    return;
  }

  // Preload counts in a single DB pass
  const countsMap = await countPagesForAllTags(
    currentTagCatalog.map((item) => item.name),
    currentAutoRules,
  );

  currentTagCatalog.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'tag-catalog-card';

    const count = countsMap.get(normalizeTagName(item.name)) || 0;
    const badgeHtml = renderTagBadge(item.name, currentTagCatalog);

    setSafeHtml(
      card,
      `
      <div class="tag-card-header">
        <div>${badgeHtml}</div>
        <div class="tag-card-actions">
          <div class="tag-card-swatches">
            ${TAG_COLORS.map(
              (c) => `<div class="tag-micro-swatch${c.id === item.colorId ? ' active' : ''}" data-color="${escapeAttr(c.id)}" style="background-color:${escapeAttr(c.color)};" title="${escapeAttr(currentLang === 'ru' ? c.nameRu : c.nameEn)}"></div>`,
            ).join('')}
          </div>
          <button type="button" class="btn btn-ghost btn-xs tag-del-btn" title="${escapeAttr(t.options.indexes.deleteTagBtnTitle)}" style="color:var(--text-muted);">✕</button>
        </div>
      </div>
      <div class="tag-card-stats">
        <span>${escapeHtml(t.options.indexes.pagesInDexie(count))}</span>
        <button type="button" class="btn btn-danger btn-xs tag-clear-pages-btn" ${count === 0 ? 'disabled' : ''}>
          <svg class="icon-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          <span>${escapeHtml(t.options.indexes.clearTagPagesBtn)}</span>
        </button>
      </div>
    `,
    );

    card.querySelectorAll<HTMLElement>('.tag-micro-swatch').forEach((swatchEl) => {
      swatchEl.addEventListener('click', async () => {
        const newColor = swatchEl.dataset.color;
        if (newColor && newColor !== item.colorId) {
          item.colorId = newColor;
          await saveSettings({ tagCatalog: currentTagCatalog });
          await renderTagCatalog();
          await renderAutoRulesTable();
          showStatus(t.options.statusSaved);
        }
      });
    });

    card.querySelector('.tag-del-btn')!.addEventListener('click', async () => {
      currentTagCatalog.splice(idx, 1);
      await saveSettings({ tagCatalog: currentTagCatalog });
      await renderTagCatalog();
      await renderAutoRulesTable();
      showStatus(t.options.statusSaved);
    });

    const clearBtn = card.querySelector('.tag-clear-pages-btn');
    clearBtn?.addEventListener('click', async () => {
      if (!confirm(t.options.indexes.clearTagPagesConfirm(item.name))) return;
      const clearedCount = await clearPagesByTag(item.name, currentAutoRules);
      await renderTagCatalog();
      await renderAutoRulesTable();
      const maxSize = Number(($<HTMLInputElement>('maxSizeMb'))?.value || '500');
      await updateStorageIndicator(maxSize);
      showStatus(t.options.indexes.clearedPagesToast(clearedCount, item.name), 'var(--accent)');
    });

    grid.appendChild(card);
  });
}

function initTagCatalogControls(): void {
  renderTagPalettePicker();

  const addBtn = $('createTagBtn');
  const nameInput = $<HTMLInputElement>('newTagName');

  async function handleCreate(): Promise<void> {
    const raw = nameInput?.value.trim() ?? '';
    const name = normalizeTagName(raw);
    const t = getLocale(currentLang);

    if (!name) {
      showStatus(t.options.statusRequiredFields, 'var(--danger)');
      return;
    }

    if (currentTagCatalog.some((c) => normalizeTagName(c.name) === name)) {
      showStatus(t.options.statusDuplicateTag, 'var(--danger)');
      return;
    }

    currentTagCatalog.push({
      name,
      colorId: selectedNewTagColor,
    });

    if (nameInput) nameInput.value = '';

    await saveSettings({ tagCatalog: currentTagCatalog });
    await renderTagCatalog();
    await renderAutoRulesTable();
    showStatus(t.options.statusSaved);
  }

  addBtn?.addEventListener('click', handleCreate);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCreate();
  });
}

// Storage usage indicator
async function updateStorageIndicator(maxSizeMb: number): Promise<void> {
  const stats = await getStorageStats();
  const maxBytes = maxSizeMb * 1024 * 1024;
  const pct = Math.min((stats.bytes / maxBytes) * 100, 100);
  const t = getLocale(currentLang);
  const unit = currentLang === 'ru' ? 'МБ' : 'MB';

  $('usedMb').textContent = `${formatBytes(stats.bytes)} / ${maxSizeMb} ${unit}`;

  const bar = $('storageBar') as HTMLElement;
  if (bar) {
    bar.style.width = stats.bytes > 0 ? `${Math.max(pct, 0.8)}%` : '0%';
  }

  const details = $('storageDetails');
  if (details) {
    if (stats.pagesCount === 0 && stats.indexesCount === 0) {
      details.textContent = t.options.storage.emptyDb;
    } else {
      details.textContent = t.options.storage.stats(stats.pagesCount, stats.chunksCount, stats.mediaCount, stats.indexesCount);
    }
  }
}

// Custom indexes list, search, pagination, and modals
let allCustomIndexes: CustomTagIndex[] = [];
let tagSearchQuery = '';
let tagCurrentPage = 1;
let tagPerPage = 10;
let pendingDeleteId: number | null = null;
let pendingDeleteName = '';
let isTagControlsInitialized = false;

function initTagControls(): void {
  if (isTagControlsInitialized) return;
  isTagControlsInitialized = true;

  const searchInput = $<HTMLInputElement>('tagSearchInput');
  const clearBtn = $('clearTagSearchBtn');
  const perPageSelect = $<HTMLSelectElement>('indexesPerPageSelect');
  const prevBtn = $<HTMLButtonElement>('paginationPrevBtn');
  const nextBtn = $<HTMLButtonElement>('paginationNextBtn');

  searchInput?.addEventListener('input', () => {
    tagSearchQuery = searchInput.value;
    clearBtn?.classList.toggle('visible', tagSearchQuery.length > 0);
    tagCurrentPage = 1;
    renderCustomIndexesUI();
  });

  clearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    clearBtn.classList.remove('visible');
    tagSearchQuery = '';
    tagCurrentPage = 1;
    searchInput?.focus();
    renderCustomIndexesUI();
  });

  perPageSelect?.addEventListener('change', () => {
    tagPerPage = Number(perPageSelect.value) || 10;
    tagCurrentPage = 1;
    renderCustomIndexesUI();
  });

  prevBtn?.addEventListener('click', () => {
    if (tagCurrentPage > 1) {
      tagCurrentPage--;
      renderCustomIndexesUI();
      scrollIndexesToTop();
    }
  });

  nextBtn?.addEventListener('click', () => {
    const filtered = getFilteredCustomIndexes();
    const totalPages = Math.max(1, Math.ceil(filtered.length / tagPerPage));
    if (tagCurrentPage < totalPages) {
      tagCurrentPage++;
      renderCustomIndexesUI();
      scrollIndexesToTop();
    }
  });

  // Edit modal
  const editModalBackdrop = $('editModalBackdrop');
  const closeEditModalBtn = $('closeEditModalBtn');
  const cancelEditModalBtn = $('cancelEditModalBtn');
  const saveEditModalBtn = $('saveEditModalBtn');
  const editTagNameInput = $<HTMLInputElement>('editTagNameInput');
  const editTagTextInput = $<HTMLTextAreaElement>('editTagTextInput');

  function closeEditModal(): void {
    if (editModalBackdrop) editModalBackdrop.style.display = 'none';
  }

  closeEditModalBtn?.addEventListener('click', closeEditModal);
  cancelEditModalBtn?.addEventListener('click', closeEditModal);

  editModalBackdrop?.addEventListener('click', (e) => {
    if (e.target === editModalBackdrop) closeEditModal();
  });

  editTagNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEditModal();
    }
  });

  async function saveEditModal(): Promise<void> {
    const t = getLocale(currentLang);
    const id = Number(($<HTMLInputElement>('editIndexId'))?.value);
    const newName = editTagNameInput?.value.trim() ?? '';
    const newText = editTagTextInput?.value.trim() ?? '';

    if (!newName && !newText) {
      showStatus(t.options.statusRequiredFields, 'var(--danger)');
      return;
    }

    const newNote = ($<HTMLTextAreaElement>('editTagNoteInput'))?.value.trim() || undefined;

    if (id) {
      const res = await updateCustomIndex(id, {
        name: newName || newText,
        text: newText,
        note: newNote,
      });
      if (res.duplicate) {
        showStatus(t.options.statusDuplicateIndex, 'var(--danger)');
        return;
      }
      closeEditModal();
      await loadAndRenderCustomIndexes();
      showStatus(t.options.statusIndexUpdated);
    }
  }

  saveEditModalBtn?.addEventListener('click', saveEditModal);

  // Delete confirmation modal
  const deleteConfirmModal = $('deleteConfirmModal');
  const closeDeleteModalBtn = $('closeDeleteModalBtn');
  const cancelDeleteModalBtn = $('cancelDeleteModalBtn');
  const confirmDeleteModalBtn = $('confirmDeleteModalBtn');

  function closeDeleteModal(): void {
    if (deleteConfirmModal) deleteConfirmModal.style.display = 'none';
    pendingDeleteId = null;
    pendingDeleteName = '';
  }

  closeDeleteModalBtn?.addEventListener('click', closeDeleteModal);
  cancelDeleteModalBtn?.addEventListener('click', closeDeleteModal);

  deleteConfirmModal?.addEventListener('click', (e) => {
    if (e.target === deleteConfirmModal) closeDeleteModal();
  });

  confirmDeleteModalBtn?.addEventListener('click', async () => {
    if (pendingDeleteId !== null) {
      const idToDelete = pendingDeleteId;
      closeDeleteModal();
      await deleteCustomIndex(idToDelete);
      await loadAndRenderCustomIndexes();
      const maxSize = Number(($<HTMLInputElement>('maxSizeMb'))?.value || '500');
      await updateStorageIndicator(maxSize);
      showStatus(getLocale(currentLang).options.statusIndexDeleted, 'var(--danger)');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editModalBackdrop && editModalBackdrop.style.display !== 'none') {
        closeEditModal();
        return;
      }
      if (deleteConfirmModal && deleteConfirmModal.style.display !== 'none') {
        closeDeleteModal();
        return;
      }
    }
  });
}

function scrollIndexesToTop(): void {
  const container = $('customIndexesList');
  if (container) {
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function getFilteredCustomIndexes(): CustomTagIndex[] {
  const q = tagSearchQuery.trim().toLowerCase();
  if (!q) return allCustomIndexes;

  return allCustomIndexes.filter((idx) => {
    const nameMatch = (idx.name || '').toLowerCase().includes(q);
    const textMatch = (idx.text || '').toLowerCase().includes(q);
    const titleMatch = (idx.pageTitle || '').toLowerCase().includes(q);
    const urlMatch = (idx.url || '').toLowerCase().includes(q);
    const noteMatch = (idx.note || '').toLowerCase().includes(q);
    return nameMatch || textMatch || titleMatch || urlMatch || noteMatch;
  });
}

async function loadAndRenderCustomIndexes(): Promise<void> {
  initTagControls();
  allCustomIndexes = await getAllCustomIndexes();
  renderCustomIndexesUI();
}

function renderCustomIndexesUI(): void {
  const container = $('customIndexesList');
  if (!container) return;
  container.replaceChildren();

  const t = getLocale(currentLang);
  const countBadge = $('customIndexesCountBadge');
  const pagination = $('indexesPagination');
  const paginationInfo = $('paginationInfo');
  const paginationPages = $('paginationPages');
  const prevBtn = $<HTMLButtonElement>('paginationPrevBtn');
  const nextBtn = $<HTMLButtonElement>('paginationNextBtn');
  const searchInput = $<HTMLInputElement>('tagSearchInput');

  if (allCustomIndexes.length === 0) {
    if (countBadge) countBadge.textContent = t.options.indexes.countBadgeZero;
    if (pagination) pagination.style.display = 'none';
    if (searchInput) {
      searchInput.value = '';
      searchInput.disabled = true;
    }
    setSafeHtml(container, `<div class="empty-indexes-hint">${t.options.indexes.emptyHintHtml}</div>`);
    return;
  }

  if (searchInput) searchInput.disabled = false;

  const filtered = getFilteredCustomIndexes();
  const total = filtered.length;

  if (countBadge) {
    if (tagSearchQuery.trim()) {
      countBadge.textContent = t.options.indexes.countBadgeFiltered(total, allCustomIndexes.length);
    } else {
      countBadge.textContent = t.options.indexes.countBadgePlural(total);
    }
  }

  if (total === 0) {
    if (pagination) pagination.style.display = 'none';
    setSafeHtml(container, `<div class="empty-indexes-hint">${t.options.indexes.noResultsHintHtml(escapeHtml(tagSearchQuery))}</div>`);
    $('resetTagSearchFilterBtn')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      $('clearTagSearchBtn')?.classList.remove('visible');
      tagSearchQuery = '';
      tagCurrentPage = 1;
      renderCustomIndexesUI();
    });
    return;
  }

  const totalPages = Math.max(1, Math.ceil(total / tagPerPage));
  if (tagCurrentPage > totalPages) tagCurrentPage = totalPages;
  if (tagCurrentPage < 1) tagCurrentPage = 1;

  const startIndex = (tagCurrentPage - 1) * tagPerPage;
  const endIndex = Math.min(startIndex + tagPerPage, total);
  const pageItems = filtered.slice(startIndex, endIndex);

  pageItems.forEach((idx) => {
    const item = document.createElement('div');
    item.className = 'custom-index-item';

    const localeCode = currentLang === 'ru' ? 'ru-RU' : 'en-US';
    const dateStr = new Date(idx.createdAt).toLocaleString(localeCode, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const pageTitle = idx.pageTitle || idx.url;

    setSafeHtml(
      item,
      `
      <div class="custom-index-content">
        <div class="custom-index-header">
          <span class="custom-index-tag-badge">${escapeHtml(idx.name)}</span>
          <a class="custom-index-page-link" href="${escapeAttr(idx.url)}" target="_blank" rel="noopener" title="${escapeAttr(idx.url)}">
            ${escapeHtml(pageTitle)}
          </a>
        </div>
        <div class="custom-index-text">${escapeHtml(idx.text)}</div>
        ${idx.note ? `<div class="custom-index-note" style="margin-top:6px; font-size:12px; color:var(--text); padding:4px 8px; background:rgba(255,255,255,0.04); border-radius:4px; border-left:2px solid var(--accent); line-height:1.4;"><span style="margin-right:4px;">📝</span>${escapeHtml(idx.note)}</div>` : ''}
        <div class="custom-index-meta">${escapeHtml(t.options.indexes.createdPrefix)} ${escapeHtml(dateStr)}</div>
      </div>
      <div class="custom-index-actions">
        <button type="button" class="custom-index-edit-btn" title="${escapeAttr(t.options.indexes.editBtnTitle)}">✏️</button>
        <button type="button" class="custom-index-del-btn" title="${escapeAttr(t.options.indexes.delBtnTitle)}">
          <svg class="icon-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    `,
    );

    item.querySelector('.custom-index-page-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      browser.runtime
        .sendMessage({
          type: 'NAVIGATE_TO_RESULT',
          url: idx.url,
          text: idx.text || '',
          selector: idx.selector || '',
        })
        .catch(() => {
          window.open(idx.url, '_blank', 'noopener');
        });
    });

    item.querySelector('.custom-index-edit-btn')!.addEventListener('click', () => {
      openEditModal(idx);
    });

    item.querySelector('.custom-index-del-btn')!.addEventListener('click', () => {
      openDeleteConfirmModal(idx);
    });

    container.appendChild(item);
  });

  if (pagination) {
    pagination.style.display = total > tagPerPage ? 'flex' : 'none';
    if (paginationInfo) {
      paginationInfo.textContent = t.options.indexes.paginationInfo(startIndex + 1, endIndex, total);
    }
    if (prevBtn) prevBtn.disabled = tagCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = tagCurrentPage >= totalPages;

    if (paginationPages) {
      paginationPages.replaceChildren();
      const pagesToDisplay = getPagesToDisplay(tagCurrentPage, totalPages);
      pagesToDisplay.forEach((p) => {
        if (p === '...') {
          const ellipsis = document.createElement('span');
          ellipsis.className = 'pagination-ellipsis';
          ellipsis.textContent = '…';
          paginationPages.appendChild(ellipsis);
        } else {
          const pageNum = Number(p);
          const pageBtn = document.createElement('button');
          pageBtn.type = 'button';
          pageBtn.className = `pagination-page-btn${pageNum === tagCurrentPage ? ' active' : ''}`;
          pageBtn.textContent = String(pageNum);
          pageBtn.addEventListener('click', () => {
            if (tagCurrentPage !== pageNum) {
              tagCurrentPage = pageNum;
              renderCustomIndexesUI();
              scrollIndexesToTop();
            }
          });
          paginationPages.appendChild(pageBtn);
        }
      });
    }
  }
}

function openEditModal(idx: CustomTagIndex): void {
  const modal = $('editModalBackdrop');
  if (!modal) return;

  ($<HTMLInputElement>('editIndexId')).value = String(idx.id ?? '');
  ($<HTMLInputElement>('editTagNameInput')).value = idx.name || '';
  ($<HTMLTextAreaElement>('editTagTextInput')).value = idx.text || '';
  if ($<HTMLTextAreaElement>('editTagNoteInput')) {
    ($<HTMLTextAreaElement>('editTagNoteInput')).value = idx.note || '';
  }

  const pageInfo = $('editTagPageInfo');
  if (pageInfo) {
    const title = idx.pageTitle || idx.url;
    setSafeHtml(
      pageInfo,
      `<a href="${escapeAttr(idx.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">${escapeHtml(title)}</a>`,
    );
  }

  modal.style.display = 'flex';
  setTimeout(() => {
    ($<HTMLInputElement>('editTagNameInput'))?.focus();
  }, 50);
}

function openDeleteConfirmModal(idx: CustomTagIndex): void {
  const modal = $('deleteConfirmModal');
  if (!modal) return;

  const t = getLocale(currentLang);
  pendingDeleteId = idx.id ?? null;
  pendingDeleteName = idx.name || idx.text || (currentLang === 'ru' ? 'без названия' : 'untitled');

  const confirmText = $('deleteConfirmText');
  if (confirmText) {
    setSafeHtml(confirmText, t.options.modals.deleteConfirmTextHtml(escapeHtml(pendingDeleteName)));
  }

  modal.style.display = 'flex';
}

function getPagesToDisplay(current: number, total: number): (number | string)[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | string)[] = [];
  pages.push(1);

  if (current > 3) {
    pages.push('...');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) {
    pages.push('...');
  }

  pages.push(total);
  return pages;
}

async function applySettingsToForm(s: UserSettings): Promise<void> {
  currentLang = s.language || DEFAULT_LANGUAGE;
  populateLanguageSelect();

  const langSelect = $<HTMLSelectElement>('language');
  if (langSelect) {
    langSelect.value = currentLang;
  }

  applyI18nToDOM(document, currentLang);

  ($<HTMLInputElement>('enabled')).checked = s.enabled;
  ($<HTMLSelectElement>('indexDepth')).value = s.indexDepth;
  ($<HTMLSelectElement>('indexTrigger')).value = s.indexTrigger || 'selection';
  ($<HTMLInputElement>('customTags')).value = s.customTags || '';
  ($<HTMLInputElement>('indexMedia')).checked = s.indexMedia;
  const whitelistField = $('mediaWhitelistField');
  if (whitelistField) {
    whitelistField.style.display = s.indexMedia ? 'block' : 'none';
  }
  ($<HTMLSelectElement>('ttlDays')).value = String(s.ttlDays);
  if ($<HTMLTextAreaElement>('pinnedDomains')) {
    ($<HTMLTextAreaElement>('pinnedDomains')).value = (s.pinnedDomains || []).join('\n');
  }
  ($<HTMLInputElement>('maxSizeMb')).value = String(s.maxSizeMb);
  const unit = currentLang === 'ru' ? 'МБ' : 'MB';
  $('maxSizeMbVal').textContent = `${s.maxSizeMb} ${unit}`;
  ($<HTMLTextAreaElement>('blacklist')).value = (s.blacklist || []).join('\n');
  if ($<HTMLSelectElement>('urlFilterMode')) {
    ($<HTMLSelectElement>('urlFilterMode')).value = s.urlFilterMode || 'blacklist';
    updateFilterModeHint(s.urlFilterMode || 'blacklist');
  }
  if ($<HTMLTextAreaElement>('whitelist')) {
    ($<HTMLTextAreaElement>('whitelist')).value = (s.whitelist || []).join('\n');
  }
  ($<HTMLInputElement>('hotkeyDisplay')).value = s.hotkey;
  if ($<HTMLSelectElement>('searchMaxResults')) {
    ($<HTMLSelectElement>('searchMaxResults')).value = String(s.searchMaxResults || 100);
  }
  if ($<HTMLSelectElement>('searchPageSize')) {
    ($<HTMLSelectElement>('searchPageSize')).value = String(s.searchPageSize || 20);
  }

  renderMediaWhitelist(s.mediaWhitelist || []);
  renderSiteRules(s.siteTagRules || []);
  currentAutoRules = s.autoTagRules || [];
  currentTagCatalog = s.tagCatalog || [];

  renderTagPalettePicker();
  await renderAutoRulesTable();
  await renderTagCatalog();
  await loadAndRenderCustomIndexes();
  await updateStorageIndicator(s.maxSizeMb);
}

// Initialize settings UI
async function loadUI(): Promise<void> {
  const s = await getSettings();
  await applySettingsToForm(s);

  initAutoRulesControls();
  initTagCatalogControls();
  initBackupControls();

  // Hotkey recording
  const hotkeyInput = $<HTMLInputElement>('hotkeyDisplay');
  hotkeyInput?.addEventListener('keydown', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const combo = formatHotkeyEvent(e);
    if (!combo) return;

    hotkeyInput.value = combo;
    hotkeyInput.blur();
    await autoSaveCurrentSettings();
  });

  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (document.activeElement === hotkeyInput) return;
      const enabledEl = $<HTMLInputElement>('enabled');
      if (enabledEl && !enabledEl.checked) return;
      const targetHotkey = hotkeyInput?.value || '';
      if (!targetHotkey) return;
      if (matchesHotkey(e, targetHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        browser.runtime.sendMessage({ type: 'OPEN_SEARCH_WINDOW' }).catch(() => {});
      }
    },
    true,
  );

  const langSelect = $<HTMLSelectElement>('language');
  langSelect?.addEventListener('change', async (e: Event) => {
    const newLang = (e.target as HTMLSelectElement).value;
    currentLang = newLang;
    applyI18nToDOM(document, currentLang);

    const maxSize = Number(($<HTMLInputElement>('maxSizeMb'))?.value || '500');
    const u = currentLang === 'ru' ? 'МБ' : 'MB';
    $('maxSizeMbVal').textContent = `${maxSize} ${u}`;

    await updateStorageIndicator(maxSize);
    renderSiteRules(collectSiteRules());
    renderTagPalettePicker();
    await renderAutoRulesTable();
    await renderTagCatalog();
    renderCustomIndexesUI();

    await saveSettings({ language: currentLang });
    showStatus(getLocale(currentLang).options.statusSaved);
  });

  $('addSiteRuleBtn').addEventListener('click', () => {
    const container = $('siteRulesList');
    const emptyHint = container.querySelector('.empty-rules-hint');
    if (emptyHint) emptyHint.remove();

    const newRow = createRuleRow();
    container.appendChild(newRow);
    (newRow.querySelector('.domain-input') as HTMLInputElement)?.focus();
  });

  $<HTMLInputElement>('enabled').addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  $<HTMLSelectElement>('searchMaxResults')?.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  $<HTMLSelectElement>('searchPageSize')?.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  $<HTMLSelectElement>('indexDepth').addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  $<HTMLSelectElement>('indexTrigger').addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  const customTagsInput = $<HTMLInputElement>('customTags');
  customTagsInput.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });
  customTagsInput.addEventListener('input', debouncedAutoSave);

  const whitelistField = $('mediaWhitelistField');
  whitelistField.style.display = s.indexMedia ? 'block' : 'none';
  $<HTMLInputElement>('indexMedia').addEventListener('change', (e) => {
    whitelistField.style.display = (e.target as HTMLInputElement).checked ? 'block' : 'none';
    autoSaveCurrentSettings();
  });

  const filterModeSelect = $<HTMLSelectElement>('urlFilterMode');
  filterModeSelect?.addEventListener('change', () => {
    updateFilterModeHint(filterModeSelect.value as 'blacklist' | 'whitelist');
    autoSaveCurrentSettings();
  });

  const blacklistInput = $<HTMLTextAreaElement>('blacklist');
  blacklistInput.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });
  blacklistInput.addEventListener('input', debouncedAutoSave);

  const whitelistInput = $<HTMLTextAreaElement>('whitelist');
  whitelistInput?.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });
  whitelistInput?.addEventListener('input', debouncedAutoSave);

  $<HTMLSelectElement>('ttlDays').addEventListener('change', () => {
    autoSaveCurrentSettings();
  });

  const pinnedDomainsInput = $<HTMLTextAreaElement>('pinnedDomains');
  pinnedDomainsInput?.addEventListener('change', () => {
    autoSaveCurrentSettings();
  });
  pinnedDomainsInput?.addEventListener('input', debouncedAutoSave);

  $<HTMLInputElement>('maxSizeMb').addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value;
    const u = currentLang === 'ru' ? 'МБ' : 'MB';
    $('maxSizeMbVal').textContent = `${val} ${u}`;
    updateStorageIndicator(Number(val));
  });
  $<HTMLInputElement>('maxSizeMb').addEventListener('change', () => {
    autoSaveCurrentSettings();
  });
}

function updateFilterModeHint(mode: 'blacklist' | 'whitelist'): void {
  const hintEl = $('filterModeHint');
  if (!hintEl) return;
  const t = getLocale(currentLang);
  hintEl.textContent =
    mode === 'whitelist'
      ? t.options.blacklist.filterModeWhitelistHint
      : t.options.blacklist.filterModeBlacklistHint;
}

// Collect form values into settings object
function collectSettings(): Partial<UserSettings> {
  const blacklistRaw = ($<HTMLTextAreaElement>('blacklist')).value;
  const blacklist = blacklistRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const whitelistRaw = ($<HTMLTextAreaElement>('whitelist'))?.value || '';
  const whitelist = whitelistRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const pinnedDomainsRaw = ($<HTMLTextAreaElement>('pinnedDomains'))?.value || '';
  const pinnedDomains = pinnedDomainsRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const urlFilterMode =
    (($<HTMLSelectElement>('urlFilterMode'))?.value as UserSettings['urlFilterMode']) || 'blacklist';

  const langSelect = $<HTMLSelectElement>('language');
  const language = langSelect ? langSelect.value : currentLang;

  return {
    language,
    enabled: ($<HTMLInputElement>('enabled')).checked,
    indexDepth: ($<HTMLSelectElement>('indexDepth')).value as UserSettings['indexDepth'],
    indexTrigger: ($<HTMLSelectElement>('indexTrigger')).value as UserSettings['indexTrigger'],
    customTags: ($<HTMLInputElement>('customTags')).value.trim(),
    siteTagRules: collectSiteRules(),
    autoTagRules: currentAutoRules,
    tagCatalog: currentTagCatalog,
    indexMedia: ($<HTMLInputElement>('indexMedia')).checked,
    mediaWhitelist: getSelectedMediaExts(),
    ttlDays: Number(($<HTMLSelectElement>('ttlDays')).value),
    maxSizeMb: Number(($<HTMLInputElement>('maxSizeMb')).value),
    urlFilterMode,
    blacklist,
    whitelist,
    pinnedDomains,
    hotkey: ($<HTMLInputElement>('hotkeyDisplay')).value,
    searchMaxResults: Number(($<HTMLSelectElement>('searchMaxResults'))?.value || 100),
    searchPageSize: Number(($<HTMLSelectElement>('searchPageSize'))?.value || 20),
  };
}

// Status toast and auto-save
let statusTimeout: number | undefined;

function showStatus(msg: string, color = 'var(--success)'): void {
  const el = $('statusMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color;
  el.classList.add('visible');
  if (statusTimeout) {
    window.clearTimeout(statusTimeout);
  }
  statusTimeout = window.setTimeout(() => {
    el.classList.remove('visible');
  }, 2000);
}

async function autoSaveCurrentSettings(): Promise<void> {
  const settings = collectSettings();
  await saveSettings(settings);
  showStatus(getLocale(currentLang).options.statusSaved);
}

const debouncedAutoSave = debounce(() => {
  autoSaveCurrentSettings();
}, 600);

$('clearDb').addEventListener('click', async () => {
  const t = getLocale(currentLang);
  if (!confirm(t.options.storage.clearDbConfirm)) return;
  await clearDatabase();
  await loadAndRenderCustomIndexes();
  await updateStorageIndicator(Number(($<HTMLInputElement>('maxSizeMb')).value));
  showStatus(t.options.statusDbCleared, 'var(--danger)');
});

$('resetHotkey').addEventListener('click', async () => {
  ($<HTMLInputElement>('hotkeyDisplay')).value = 'Alt+Shift+F';
  await autoSaveCurrentSettings();
});

interface ExportPayload {
  version: number;
  app: string;
  exportedAt: string;
  settings: Partial<UserSettings>;
  customIndexes?: Omit<CustomTagIndex, 'id' | 'pageId'>[];
}

async function exportSettingsData(): Promise<void> {
  const settings = await getSettings();
  const includeSnippets = ($<HTMLInputElement>('backupIncludeSnippets'))?.checked ?? true;

  const payload: ExportPayload = {
    version: 1,
    app: 'PageTrace',
    exportedAt: new Date().toISOString(),
    settings,
  };

  if (includeSnippets) {
    const rawSnippets = await getAllCustomIndexes();
    payload.customIndexes = rawSnippets.map((item) => ({
      url: item.url,
      pageTitle: item.pageTitle,
      favicon: item.favicon,
      name: item.name,
      text: item.text,
      note: item.note,
      selector: item.selector,
      createdAt: item.createdAt,
    }));
  }

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const downloadUrl = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `pagetrace-settings-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);
}

async function importSettingsData(file: File): Promise<void> {
  const t = getLocale(currentLang);
  let text = '';
  try {
    text = await file.text();
  } catch {
    showStatus(t.options.storage.importErrorParse, 'var(--danger)');
    return;
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    showStatus(t.options.storage.importErrorParse, 'var(--danger)');
    return;
  }

  if (
    !data ||
    typeof data !== 'object' ||
    data.app !== 'PageTrace' ||
    !data.settings ||
    typeof data.settings !== 'object'
  ) {
    showStatus(t.options.storage.importErrorInvalid, 'var(--danger)');
    return;
  }

  const rawSettings = data.settings;
  const sanitizedSettings: Partial<UserSettings> = {};

  if (typeof rawSettings.language === 'string') {
    sanitizedSettings.language = rawSettings.language;
  }
  if (['headings', 'semantic', 'full'].includes(rawSettings.indexDepth)) {
    sanitizedSettings.indexDepth = rawSettings.indexDepth;
  }
  if (['selection', 'contextmenu', 'both'].includes(rawSettings.indexTrigger)) {
    sanitizedSettings.indexTrigger = rawSettings.indexTrigger;
  }
  if (typeof rawSettings.customTags === 'string') {
    sanitizedSettings.customTags = rawSettings.customTags;
  }
  if (Array.isArray(rawSettings.siteTagRules)) {
    sanitizedSettings.siteTagRules = rawSettings.siteTagRules.filter(
      (r: any) => r && typeof r.domain === 'string' && typeof r.tags === 'string',
    );
  }
  if (Array.isArray(rawSettings.autoTagRules)) {
    sanitizedSettings.autoTagRules = rawSettings.autoTagRules
      .filter((r: any) => r && typeof r.pattern === 'string' && typeof r.tag === 'string')
      .map((r: any) => ({
        id: String(r.id || Date.now() + Math.random()),
        pattern: String(r.pattern),
        tag: normalizeTagName(String(r.tag)),
      }));
  }
  if (Array.isArray(rawSettings.tagCatalog)) {
    sanitizedSettings.tagCatalog = rawSettings.tagCatalog
      .filter((tc: any) => tc && typeof tc.name === 'string')
      .map((tc: any) => ({
        name: normalizeTagName(String(tc.name)),
        colorId: typeof tc.colorId === 'string' ? tc.colorId : 'slate',
      }));
  }
  if (typeof rawSettings.indexMedia === 'boolean') {
    sanitizedSettings.indexMedia = rawSettings.indexMedia;
  }
  if (Array.isArray(rawSettings.mediaWhitelist)) {
    sanitizedSettings.mediaWhitelist = rawSettings.mediaWhitelist.filter((ext: any) =>
      ALL_MEDIA_EXTS.includes(ext),
    );
  }
  if (['blacklist', 'whitelist'].includes(rawSettings.urlFilterMode)) {
    sanitizedSettings.urlFilterMode = rawSettings.urlFilterMode;
  }
  if (Array.isArray(rawSettings.blacklist)) {
    sanitizedSettings.blacklist = rawSettings.blacklist.map((x: any) => String(x).trim()).filter(Boolean);
  }
  if (Array.isArray(rawSettings.whitelist)) {
    sanitizedSettings.whitelist = rawSettings.whitelist.map((x: any) => String(x).trim()).filter(Boolean);
  }
  if (Array.isArray(rawSettings.pinnedDomains)) {
    sanitizedSettings.pinnedDomains = rawSettings.pinnedDomains.map((x: any) => String(x).trim()).filter(Boolean);
  }
  if (typeof rawSettings.ttlDays === 'number' && Number.isFinite(rawSettings.ttlDays)) {
    sanitizedSettings.ttlDays = rawSettings.ttlDays;
  }
  if (typeof rawSettings.maxSizeMb === 'number' && Number.isFinite(rawSettings.maxSizeMb)) {
    sanitizedSettings.maxSizeMb = rawSettings.maxSizeMb;
  }
  if (typeof rawSettings.hotkey === 'string' && rawSettings.hotkey.trim()) {
    sanitizedSettings.hotkey = rawSettings.hotkey.trim();
  }
  if (typeof rawSettings.enabled === 'boolean') {
    sanitizedSettings.enabled = rawSettings.enabled;
  }
  if (typeof rawSettings.searchMaxResults === 'number') {
    sanitizedSettings.searchMaxResults = rawSettings.searchMaxResults;
  }
  if (typeof rawSettings.searchPageSize === 'number') {
    sanitizedSettings.searchPageSize = rawSettings.searchPageSize;
  }

  await saveSettings(sanitizedSettings);

  if (Array.isArray(data.customIndexes) && data.customIndexes.length > 0) {
    for (const item of data.customIndexes) {
      if (item && typeof item.url === 'string' && typeof item.text === 'string') {
        await addCustomIndex({
          url: item.url,
          pageTitle: item.pageTitle || '',
          favicon: item.favicon || '',
          name: item.name || item.text,
          text: item.text,
          note: item.note,
          selector: item.selector || '',
        });
      }
    }
  }

  const updatedSettings = await getSettings();
  await applySettingsToForm(updatedSettings);

  showStatus(getLocale(currentLang).options.storage.importSuccess);
}

function initBackupControls(): void {
  const exportBtn = $('exportSettingsBtn');
  const importBtn = $('importSettingsBtn');
  const fileInput = $<HTMLInputElement>('importSettingsFileInput');

  exportBtn?.addEventListener('click', () => {
    exportSettingsData().catch(() => {
      showStatus('Export failed', 'var(--danger)');
    });
  });

  importBtn?.addEventListener('click', () => {
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await importSettingsData(file);
  });
}

// Tabs navigation
function initTabs(): void {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const tabPanes = document.querySelectorAll<HTMLElement>('.tab-pane');
  const validTabs = ['general', 'indexing', 'indexes', 'blacklist', 'storage'];

  function switchTab(tabId: string): void {
    if (!validTabs.includes(tabId)) {
      tabId = 'general';
    }

    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tabId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    tabPanes.forEach((pane) => {
      pane.classList.toggle('active', pane.id === `tab-${tabId}`);
    });

    if (window.location.hash.replace('#', '') !== tabId) {
      history.replaceState(null, '', `#${tabId}`);
    }

    if (tabId === 'storage') {
      const maxSize = Number(($<HTMLInputElement>('maxSizeMb'))?.value || '500');
      updateStorageIndicator(maxSize);
    } else if (tabId === 'indexes') {
      renderAutoRulesTable();
      renderTagCatalog();
      loadAndRenderCustomIndexes();
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      if (tabId) switchTab(tabId);
    });
  });

  function applyHash(): void {
    const hash = window.location.hash.replace('#', '');
    if (hash && validTabs.includes(hash)) {
      switchTab(hash);
    } else {
      switchTab('general');
    }
  }

  window.addEventListener('hashchange', applyHash);
  applyHash();
}

initTabs();
loadUI();
