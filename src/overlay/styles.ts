export const OVERLAY_CSS = `
  :host {
    all: initial;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  .pt-overlay-backdrop {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    pointer-events: all;
    z-index: 1;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
  }

  .pt-overlay-backdrop.page-mode {
    background: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    pointer-events: none !important;
    padding-top: 18px !important;
    padding-right: 24px !important;
    justify-content: flex-end !important;
    align-items: flex-start !important;
  }

  .pt-modal {
    background: #181A1F;
    border: 1px solid #2A2D35;
    border-radius: 14px;
    box-shadow: 0 32px 96px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.04);
    width: min(680px, 92vw);
    max-height: 72vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: all;
    position: relative;
    transition: width 0.15s ease, max-height 0.15s ease, box-shadow 0.15s ease;
  }

  .pt-modal.page-mode {
    width: min(450px, 92vw);
    max-height: 60vh;
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px #2E3340;
    pointer-events: all !important;
    background: #181A1F;
  }

  .pt-modal.page-mode.collapsed {
    max-height: 48px !important;
  }

  .pt-modal.page-mode.collapsed .pt-results,
  .pt-modal.page-mode.collapsed .pt-footer,
  .pt-modal.page-mode.collapsed .pt-autocomplete-wrap {
    display: none !important;
  }

  .pt-modal.page-mode.collapsed .pt-search-bar {
    border-bottom: none !important;
  }

  .pt-modal.page-mode .pt-search-bar {
    padding: 8px 12px;
    gap: 8px;
  }

  .pt-modal.page-mode .pt-search-input {
    font-size: 14px;
  }

  .pt-modal.page-mode .pt-search-icon {
    display: none;
  }

  .pt-modal.page-mode .pt-kbd {
    display: none;
  }

  .pt-inbar-nav {
    display: none;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }

  .pt-modal.page-mode .pt-inbar-nav.visible {
    display: flex;
  }

  .pt-inbar-counter {
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #F4FF2B;
    padding: 2px 6px;
    background: #20232B;
    border-radius: 4px;
    white-space: nowrap;
    min-width: 40px;
    text-align: center;
    line-height: 1.4;
  }

  .pt-inbar-btn {
    background: transparent;
    border: none;
    color: #8E94A2;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.12s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .pt-inbar-btn:hover {
    background: #272B36;
    color: #ECEEF2;
  }

  .pt-inbar-btn svg {
    width: 14px;
    height: 14px;
  }

  .pt-close-btn {
    display: none;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: #8E94A2;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.12s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .pt-modal.page-mode .pt-close-btn {
    display: flex;
  }

  .pt-close-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #F87171;
  }

  .pt-close-btn svg {
    width: 14px;
    height: 14px;
  }

  .pt-search-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid #2A2D35;
    background: #181A1F;
    position: relative;
  }

  .pt-search-icon {
    flex-shrink: 0;
    color: #7E838F;
    width: 18px;
    height: 18px;
  }

  .pt-search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #ECEEF2;
    font-size: 16px;
    font-family: inherit;
    caret-color: #F4FF2B;
  }

  .pt-search-input::placeholder {
    color: #7E838F;
  }

  .pt-kbd {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #7E838F;
    font-size: 12px;
  }

  .pt-kbd kbd {
    background: #111215;
    border: 1px solid #2A2D35;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    color: #7E838F;
    font-family: inherit;
  }

  .pt-clear-btn {
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: #7E838F;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .pt-clear-btn:hover {
    background: rgba(255, 255, 255, 0.16);
    color: #ECEEF2;
  }

  .pt-clear-btn.visible {
    display: flex;
  }

  .pt-autocomplete-wrap {
    position: relative;
    width: 100%;
  }

  .pt-autocomplete {
    position: absolute;
    top: 0;
    left: 20px;
    right: 20px;
    background: #181A1F;
    border: 1px solid #2A2D35;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
    z-index: 100;
    max-height: 220px;
    overflow-y: auto;
    display: none;
    margin-top: 4px;
  }

  .pt-autocomplete.open {
    display: block;
  }

  .pt-autocomplete-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 13px;
    color: #ECEEF2;
    cursor: pointer;
    transition: background 0.1s;
    border-bottom: 1px solid #202228;
  }

  .pt-autocomplete-item:last-child {
    border-bottom: none;
  }

  .pt-autocomplete-item:hover,
  .pt-autocomplete-item.active {
    background: #242730;
    color: #F4FF2B;
  }

  .pt-autocomplete-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-weight: 600;
  }

  .pt-autocomplete-desc {
    font-size: 11px;
    color: #7E838F;
  }

  .pt-mode-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: #20232B;
    border: 1px solid #2E3340;
    border-radius: 8px;
    color: #9499A6;
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
    flex-shrink: 0;
  }

  .pt-mode-toggle:hover {
    background: #272B36;
    border-color: #3C4252;
    color: #ECEEF2;
  }

  .pt-mode-toggle.is-page {
    background: rgba(244, 255, 43, 0.12);
    border-color: rgba(244, 255, 43, 0.5);
    color: #F4FF2B;
  }

  .pt-mode-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .pt-tabs.page-mode-hidden {
    display: none;
  }

  .pt-live-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 18px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.12s ease;
    border-left: 2px solid transparent;
  }

  .pt-live-item:hover,
  .pt-live-item.focused {
    background: #1F222A;
    border-left-color: #F4FF2B;
  }

  .pt-live-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: #7E838F;
  }

  .pt-live-tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background: #252832;
    color: #A0A6B5;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
  }

  .pt-live-pos {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #7E838F;
  }

  .pt-live-snippet {
    font-size: 13px;
    line-height: 1.5;
    color: #C7CBD4;
  }

  .pt-live-snippet mark,
  .pt-highlight {
    background: #F4FF2B;
    color: #111215 !important;
    border-radius: 2px;
    padding: 0 2px;
    font-weight: 600;
  }

  .pt-floating-nav {
    position: fixed;
    top: 20px;
    right: 24px;
    background: #181A1F;
    border: 1px solid #2E3340;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
    padding: 6px 10px;
    display: none;
    align-items: center;
    gap: 8px;
    z-index: 2147483647;
    pointer-events: all;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
    color: #ECEEF2;
    animation: pt-dock-in 0.15s ease-out;
  }

  .pt-floating-nav.visible {
    display: flex;
  }

  @keyframes pt-dock-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .pt-float-query {
    font-size: 12px;
    font-weight: 500;
    color: #ECEEF2;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: #22252E;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .pt-float-counter {
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #F4FF2B;
    white-space: nowrap;
    min-width: 44px;
    text-align: center;
  }

  .pt-float-divider {
    width: 1px;
    height: 16px;
    background: #2E3340;
  }

  .pt-float-btn {
    background: transparent;
    border: none;
    border-radius: 5px;
    color: #8E94A2;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .pt-float-btn:hover {
    background: #272B36;
    color: #ECEEF2;
  }

  .pt-float-close:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #F87171;
  }


  .pt-tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 18px;
    border-bottom: 1px solid #242730;
    background: #14161A;
  }

  .pt-filter-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pt-filter-group-left {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .pt-filter-group-left::-webkit-scrollbar {
    display: none;
  }

  .pt-filter-group-right {
    flex-shrink: 0;
  }

  .pt-pill-wrap {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .pt-pill-select {
    background-color: #1A1D24;
    border: 1px solid #2B2F3A;
    color: #8C92A0;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    padding: 5px 24px 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237E838F' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 10px;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .pt-pill-select:hover {
    color: #ECEEF2;
    border-color: #3F4452;
    background-color: #21252E;
  }

  .pt-pill-select:focus-visible {
    border-color: #F4FF2B;
    box-shadow: 0 0 0 1px rgba(244, 255, 43, 0.25);
  }

  .pt-pill-select.active {
    background-color: rgba(244, 255, 43, 0.1);
    border-color: rgba(244, 255, 43, 0.4);
    color: #F4FF2B;
    font-weight: 600;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23F4FF2B' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  }

  .pt-pill-select option {
    background: #181A1F;
    color: #ECEEF2;
    font-weight: 400;
  }

  .pt-visits {
    display: inline-flex;
    align-items: center;
    gap: 3.5px;
    color: #7E838F;
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    transition: color 0.15s, background-color 0.15s;
  }

  .pt-visits:hover {
    color: #C5C8D1;
    background: rgba(255, 255, 255, 0.08);
  }

  .pt-tag-badge.clickable,
  .pt-domain.clickable {
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .pt-tag-badge.clickable:hover,
  .pt-domain.clickable:hover {
    opacity: 0.85;
    text-decoration: underline;
  }

  .pt-results {
    overflow-y: auto;
    flex: 1;
    padding: 0;
    scrollbar-width: thin;
    scrollbar-color: #2A2D35 transparent;
    background: #181A1F;
    display: flex;
    flex-direction: column;
  }

  .pt-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    color: #7E838F;
    font-size: 14px;
    gap: 8px;
  }

  .pt-empty-icon {
    font-size: 32px;
    opacity: 0.5;
  }

  .pt-result {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px 20px;
    cursor: pointer;
    transition: background 0.1s;
    border-radius: 0;
    border-left: 3px solid transparent;
    border-bottom: 1px solid #202228;
    background: transparent;
  }

  .pt-result:last-child {
    border-bottom: none;
  }

  .pt-result:hover,
  .pt-result.focused {
    background: #1E2129;
    border-left-color: #F4FF2B;
  }

  .pt-meta-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .pt-meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: #7E838F;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pt-quick-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }

  .pt-result:hover .pt-quick-actions,
  .pt-result.focused .pt-quick-actions {
    opacity: 1;
  }

  .pt-act-btn {
    background: #111215;
    border: 1px solid #2A2D35;
    color: #7E838F;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s ease;
  }

  .pt-act-btn:hover {
    color: #ECEEF2;
    border-color: #3B3F4A;
    background: #20232A;
  }

  .pt-act-btn.pt-act-delete:hover {
    color: #FF5A5A;
    border-color: rgba(255, 90, 90, 0.4);
  }

  .pt-act-btn.pt-act-blacklist:hover {
    color: #FFA500;
    border-color: rgba(255, 165, 0, 0.4);
  }

  .pt-act-btn.pt-act-pin:hover,
  .pt-act-btn.pt-act-pin.active {
    color: #4DA6FF;
    border-color: rgba(77, 166, 255, 0.4);
  }

  .pt-act-btn.pt-act-pin.active svg {
    fill: currentColor;
  }

  .pt-act-btn.copied {
    color: #55FF88;
    border-color: rgba(85, 255, 136, 0.4);
  }

  .pt-favicon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    flex-shrink: 0;
    object-fit: contain;
    background: #2A2D35;
  }

  .pt-domain {
    color: #7E838F;
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .pt-meta-dot {
    color: #4A4E58;
    font-size: 9px;
  }

  .pt-tag-badge {
    display: inline-flex;
    align-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.35;
  }

  .pt-time {
    color: #7E838F;
    font-size: 11px;
  }

  .pt-page-title {
    font-size: 13.5px;
    font-weight: 600;
    color: #ECEEF2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pt-snippet {
    font-size: 13px;
    color: #7E838F;
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .pt-snippet mark {
    background: #F4FF2B;
    color: #111215 !important;
    border-radius: 1px;
    padding: 0 3px;
    font-weight: 600;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .pt-result-note {
    margin-top: 6px;
    padding: 4px 8px;
    background: rgba(244, 255, 43, 0.08);
    border-left: 2px solid #F4FF2B;
    border-radius: 4px;
    font-size: 12px;
    color: #ECEEF2;
    line-height: 1.4;
  }

  .pt-submatches-toggle {
    margin-top: 4px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid #2A2D35;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 11.5px;
    color: #A0A5B2;
    cursor: pointer;
    transition: all 0.15s ease;
    align-self: flex-start;
  }

  .pt-submatches-toggle:hover {
    background: rgba(244, 255, 43, 0.1);
    border-color: rgba(244, 255, 43, 0.3);
    color: #F4FF2B;
  }

  .pt-submatches-list {
    margin-top: 8px;
    padding-left: 12px;
    border-left: 2px solid #2A2D35;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pt-result-body {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
  }

  .pt-result-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pt-thumb-box {
    width: 58px;
    height: 58px;
    border-radius: 8px;
    background: #111215;
    border: 1px solid #2A2D35;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pt-thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.15s ease;
  }

  .pt-result:hover .pt-thumb-img,
  .pt-result.focused .pt-thumb-img {
    transform: scale(1.06);
  }

  .pt-submatch-item {
    padding: 6px 10px;
    background: #14161A;
    border-radius: 6px;
    border: 1px solid #22252C;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pt-submatch-thumb {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    background: #111215;
    border: 1px solid #2A2D35;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pt-submatch-thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .pt-submatch-content {
    flex: 1;
    min-width: 0;
  }

  .pt-submatch-item:hover {
    background: #1B1E25;
    border-color: #383D47;
  }

  .pt-submatch-snippet {
    font-size: 12.5px;
    color: #8E93A0;
    line-height: 1.45;
  }

  .pt-submatch-snippet mark {
    background: #F4FF2B;
    color: #111215 !important;
    padding: 0 2px;
    border-radius: 1px;
    font-weight: 600;
  }

  .pt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    border-top: 1px solid #2A2D35;
    font-size: 11.5px;
    color: #7E838F;
    background: #181A1F;
  }

  .pt-footer-count {
    color: #7E838F;
  }

  .pt-footer-hint {
    display: flex;
    gap: 12px;
  }

  .pt-footer-hint span {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .pt-footer-hint kbd {
    background: #111215;
    border: 1px solid #2A2D35;
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 10.5px;
    color: #7E838F;
  }

  .pt-loader {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: #7E838F;
    font-size: 13px;
    gap: 10px;
  }

  @keyframes pt-spin {
    to { transform: rotate(360deg); }
  }

  .pt-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #2A2D35;
    border-top-color: #F4FF2B;
    border-radius: 50%;
    animation: pt-spin 0.7s linear infinite;
  }
`;
