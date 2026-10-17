---
trigger: always_on
---

# Skill and Documentation Maintenance Guidelines

Keep project skills in `.agents/skills/` synchronized with the codebase when introducing fundamental architectural changes:

1. **When to update skills**:
   - **Database schema changes**: Adding or modifying Dexie tables, version migrations, or index synchronization hooks in `src/db/` (`dexie-minisearch-index`).
   - **Core module reorganization**: Adding, splitting, or renaming shared modules or core contracts (e.g., in `src/common/`).
   - **Build & tooling workflows**: Modifying build scripts (`build.mjs`), test pipelines, manifests, or verification checklists (`webext-mv3-workflow`).
   - **UI & Localization contracts**: Modifying i18n architecture or Shadow DOM isolation patterns (`i18n-manager`, `shadow-dom-ui`).

2. **When NOT to update skills**:
   - Routine bug fixes, UI styling tweaks, copy adjustments, or regular feature additions that adhere to established patterns. Do not modify skills during everyday development tasks to avoid documentation churn and unnecessary diffs.
