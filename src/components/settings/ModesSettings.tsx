/**
 * ModesSettings — Modes Manager panel.
 *
 * Redesigned (2026-08) to match the light "sidebar + content" layout of the
 * design mockups. Two views, toggled from the sidebar footer:
 *
 *   - 'modes'     — the user's modes (sidebar) + the selected mode's details
 *                   (Real-time prompt, Notes template, Reference files).
 *   - 'templates' — the "Natively Templates" gallery. Picking a template
 *                   creates a CUSTOM mode (backend modes:create +
 *                   modes:update customContext) and returns to the modes view.
 *
 * Backend contract (all through window.electronAPI IPC):
 *   modes:get-all / get-templates / create / update / delete / set-active /
 *   get-note-sections / add-note-section / update-note-section /
 *   delete-note-section / get-reference-files / upload-reference-file /
 *   delete-reference-file
 *
 * Rules baked in here (mirror the product requirements):
 *   - A fresh user sees ONLY the built-in "General" default. Every other
 *     template is opt-in via the gallery (backend seeds only General now).
 *   - The built-in General mode is LOCKED: its Real-time prompt and Notes
 *     template show "Autofilled by Natively", are not editable, and the mode
 *     itself has no "..." delete menu. Other modes are fully editable and
 *     deletable.
 *   - Inactive modes show a "Set active" tick; active modes show a blue check.
 *   - Non-General creation/editing/deletion is Pro-gated at the backend
 *     ('pro_required'); this panel surfaces the backend error text.
 *
 * Styles live in ./ModesSettings.css (scoped under .modes-manager-root).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Briefcase,
  Check,
  ChevronRight,
  Code2,
  FileText,
  FolderOpen,
  Headphones,
  LayoutGrid,
  Loader2,
  Lock,
  MonitorPlay,
  MoreVertical,
  Plus,
  Presentation,
  Sparkles,
  Target,
  Trash2,
  Upload,
  User,
} from 'lucide-react';
import { useT } from '../../i18n';
import './ModesSettings.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types (structural mirrors of the preload/electron.d.ts contracts)
// ─────────────────────────────────────────────────────────────────────────────

interface ModeSummary {
  id: string;
  name: string;
  templateType: string;
  customContext: string;
  isActive: boolean;
  isBuiltin: boolean;
  createdAt: string;
  referenceFileCount: number;
}

interface ModeTemplate {
  type: string;
  label: string;
  description: string;
  starterPrompt: string;
  noteSections: Array<{ title: string; description: string }>;
}

interface NoteSection {
  id: string;
  title: string;
  description: string;
  sortOrder: number;
}

interface RefFile {
  id: string;
  fileName: string;
  createdAt: string;
  pageCount?: number;
}

interface ModesSettingsProps {
  onClose: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation-only helpers (template icons + colors for the gallery)
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  general: <Sparkles size={30} strokeWidth={1.8} />,
  sales: <Target size={30} strokeWidth={1.8} />,
  recruiting: <User size={30} strokeWidth={1.8} />,
  'team-meet': <MonitorPlay size={30} strokeWidth={1.8} />,
  'looking-for-work': <Briefcase size={30} strokeWidth={1.8} />,
  'technical-interview': <Code2 size={30} strokeWidth={1.8} />,
  lecture: <BookOpen size={30} strokeWidth={1.8} />,
  seminar: <Presentation size={30} strokeWidth={1.8} />,
  'call-center': <Headphones size={30} strokeWidth={1.8} />,
};

const TEMPLATE_COLORS: Record<string, string> = {
  general: 'general',
  sales: 'sales',
  recruiting: 'recruiting',
  'team-meet': 'team',
  'looking-for-work': 'work',
  'technical-interview': 'technical',
  lecture: 'lecture',
  seminar: 'seminar',
  'call-center': 'call',
};

const PRO_ERROR_TEXT =
  'Pro license required. Creating, editing or deleting non-General modes requires a Pro license.';

/** The built-in General default — locked prompt/notes and not deletable. */
const isGeneralLocked = (mode: ModeSummary | null | undefined): boolean =>
  !!mode && mode.isBuiltin && mode.templateType === 'general';

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const ModesSettings: React.FC<ModesSettingsProps> = ({ onClose }) => {
  const t = useT();

  // Data
  const [modes, setModes] = useState<ModeSummary[] | null>(null);
  const [templates, setTemplates] = useState<ModeTemplate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [noteSections, setNoteSections] = useState<NoteSection[]>([]);
  const [refFiles, setRefFiles] = useState<RefFile[]>([]);

  // View / interaction state
  const [view, setView] = useState<'modes' | 'templates'>('modes');
  const [creatingName, setCreatingName] = useState(false);
  const [newModeName, setNewModeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Editable field state
  const [promptDraft, setPromptDraft] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptSavedAt, setPromptSavedAt] = useState<number | null>(null);
  const [sectionDrafts, setSectionDrafts] = useState<Record<string, { title: string; description: string }>>({});
  const [addingSection, setAddingSection] = useState(false);
  const [newSection, setNewSection] = useState({ title: '', description: '' });
  const [uploading, setUploading] = useState(false);

  const selected = useMemo(
    () => modes?.find((m) => m.id === selectedId) ?? modes?.[0] ?? null,
    [modes, selectedId],
  );
  const locked = isGeneralLocked(selected);

  // ── Data loading ────────────────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<ModeSummary[]> => {
    try {
      const list = (await window.electronAPI?.modesGetAll?.()) ?? [];
      setModes(list);
      return list;
    } catch {
      setModes([]);
      return [];
    }
  }, []);

  const refreshTemplates = useCallback(async () => {
    try {
      const res = await window.electronAPI?.modesGetTemplates?.();
      setTemplates(res?.templates ?? []);
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshTemplates();
  }, [refresh, refreshTemplates]);

  /** Fetch the selected mode's details + reset the editable drafts. */
  const loadDetails = useCallback((mode: ModeSummary | null | undefined) => {
    setPromptDraft(mode?.customContext ?? '');
    setPromptSavedAt(null);
    setSectionDrafts({});
    setAddingSection(false);
    setNewSection({ title: '', description: '' });
    if (!mode) {
      setNoteSections([]);
      setRefFiles([]);
      return;
    }
    window.electronAPI?.modesGetNoteSections?.(mode.id)
      .then(setNoteSections)
      .catch(() => setNoteSections([]));
    window.electronAPI?.modesGetReferenceFiles?.(mode.id)
      .then(setRefFiles)
      .catch(() => setRefFiles([]));
  }, []);

  // Re-sync details whenever the selected mode changes (selection, refresh).
  useEffect(() => {
    loadDetails(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const selectMode = useCallback(
    (id: string) => {
      setSelectedId(id);
      loadDetails(modes?.find((m) => m.id === id));
      setMenuOpenId(null);
      setConfirmDeleteId(null);
      setError('');
    },
    [modes, loadDetails],
  );

  const closeMenus = useCallback(() => {
    setMenuOpenId(null);
    setConfirmDeleteId(null);
  }, []);

  // ── Mode actions ────────────────────────────────────────────────────────────

  const handleCreateMode = async (name: string, templateType: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const res = await window.electronAPI?.modesCreate?.({ name, templateType });
      if (!res?.success) {
        setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not create mode.');
        return false;
      }
      const list = await refresh();
      const created = list.find((m) => m.id === res.mode?.id) ?? list.find((m) => m.name === name);
      if (created) {
        setSelectedId(created.id);
        loadDetails(created);
      }
      return true;
    } catch {
      setError('Could not create mode.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleNewModeSubmit = async () => {
    const name = newModeName.trim();
    if (!name || busy) return;
    if (await handleCreateMode(name, 'general')) {
      setNewModeName('');
      setCreatingName(false);
    }
  };

  const handleTemplatePick = async (tpl: ModeTemplate) => {
    if (busy) return;
    setError('');
    // The "General" row means "start from an empty mode": back to the modes
    // view and open the name field. Creating the mode happens there.
    if (tpl.type === 'general') {
      setView('modes');
      setCreatingName(true);
      return;
    }
    setBusy(true);
    try {
      const res = await window.electronAPI?.modesCreate?.({ name: tpl.label, templateType: tpl.type });
      if (!res?.success) {
        setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not create mode.');
        return;
      }
      // Seed the template's starter "real-time prompt" (backend source of truth).
      if (tpl.starterPrompt) {
        const upd = await window.electronAPI?.modesUpdate?.(res.mode?.id, { customContext: tpl.starterPrompt });
        if (upd && !upd.success) {
          setError(upd.error === 'pro_required' ? PRO_ERROR_TEXT : upd.error || 'Could not save mode prompt.');
        }
      }
      const list = await refresh();
      const created = list.find((m) => m.id === res.mode?.id) ?? list.find((m) => m.name === tpl.label);
      if (created) {
        setSelectedId(created.id);
        loadDetails(created);
      }
      setView('modes');
    } catch {
      setError('Could not create mode.');
    } finally {
      setBusy(false);
    }
  };

  const handleSetActive = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.electronAPI?.modesSetActive?.(id);
      if (res && !res.success) {
        setError(res.error === 'pro_required' ? PRO_ERROR_TEXT : res.error || 'Could not activate mode.');
      }
      await refresh();
    } catch {
      /* keep last known state */
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.electronAPI?.modesDelete?.(id);
      if (res && !res.success) {
        setError(res.error === 'pro_required' ? PRO_ERROR_TEXT : res.error || 'Could not delete mode.');
        closeMenus();
        return;
      }
      const list = await refresh();
      const next = list.find((m) => m.isActive) ?? list[0] ?? null;
      setSelectedId(next?.id ?? null);
      loadDetails(next);
      closeMenus();
    } catch {
      /* keep last known state */
    } finally {
      setBusy(false);
    }
  };

  // ── Field saves (Real-time prompt, Notes template sections) ─────────────────

  const handlePromptBlur = async () => {
    if (!selected) return;
    const value = promptDraft.trim();
    if (value === (selected.customContext ?? '')) return;
    setPromptSaving(true);
    try {
      const res = await window.electronAPI?.modesUpdate?.(selected.id, { customContext: value });
      if (res?.success) {
        setPromptSavedAt(Date.now());
        await refresh();
      } else {
        setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not save prompt.');
      }
    } catch {
      setError('Could not save prompt.');
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSectionBlur = async (section: NoteSection) => {
    const draft = sectionDrafts[section.id];
    if (!draft) return;
    if (draft.title === section.title && draft.description === (section.description ?? '')) return;
    const res = await window.electronAPI?.modesUpdateNoteSection?.(section.id, draft);
    if (res?.success) {
      setNoteSections((prev) => prev.map((s) => (s.id === section.id ? { ...s, ...draft } : s)));
      setSectionDrafts((prev) => {
        const next = { ...prev };
        delete next[section.id];
        return next;
      });
    } else {
      setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not save section.');
    }
  };

  const handleAddSection = async () => {
    if (!selected) return;
    const title = newSection.title.trim();
    if (!title) return;
    const res = await window.electronAPI?.modesAddNoteSection?.(selected.id, title, newSection.description.trim());
    if (res?.success) {
      setNoteSections((prev) => [...prev, res.section]);
      setNewSection({ title: '', description: '' });
      setAddingSection(false);
    } else {
      setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not add section.');
    }
  };

  const handleDeleteSection = async (id: string) => {
    const res = await window.electronAPI?.modesDeleteNoteSection?.(id);
    if (res?.success) {
      setNoteSections((prev) => prev.filter((s) => s.id !== id));
    } else {
      setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not delete section.');
    }
  };

  // ── Reference files ─────────────────────────────────────────────────────────

  const handleUploadFile = async () => {
    if (!selected || uploading) return;
    setUploading(true);
    setError('');
    try {
      const res = await window.electronAPI?.modesUploadReferenceFile?.(selected.id);
      if (res?.success) {
        const files = (await window.electronAPI?.modesGetReferenceFiles?.(selected.id)) ?? [];
        setRefFiles(files);
        await refresh(); // update sidebar referenceFileCount badges
      } else if (res && !res.cancelled) {
        setError(res.error === 'pro_required' ? PRO_ERROR_TEXT : res.error || 'Could not upload file.');
      }
    } catch {
      setError('Could not upload file.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteFile = async (id: string) => {
    const res = await window.electronAPI?.modesDeleteReferenceFile?.(id);
    if (res?.success) {
      setRefFiles((prev) => prev.filter((f) => f.id !== id));
      await refresh();
    } else {
      setError(res?.error === 'pro_required' ? PRO_ERROR_TEXT : res?.error || 'Could not delete file.');
    }
  };

  // ── Render: sidebar ─────────────────────────────────────────────────────────

  const renderSidebar = () => (
    <aside className="ms-sidebar">
      <div className="ms-sidebar-top">
        <button className="ms-close-button" onClick={onClose} aria-label={t('Close')}>
          ×
        </button>

        {creatingName ? (
          <div className="ms-new-mode-form">
            <input
              autoFocus
              value={newModeName}
              onChange={(e) => setNewModeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNewModeSubmit();
                if (e.key === 'Escape') { setCreatingName(false); setNewModeName(''); }
              }}
              placeholder={t('New mode name…')}
              className="ms-name-input"
            />
            <div className="ms-new-mode-actions">
              <button className="ms-name-submit" onClick={() => void handleNewModeSubmit()} disabled={busy || !newModeName.trim()}>
                {t('Create')}
              </button>
              <button
                className="ms-name-cancel"
                onClick={() => { setCreatingName(false); setNewModeName(''); }}
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="ms-new-mode-button"
            onClick={() => { setCreatingName(true); setNewModeName(''); setError(''); }}
          >
            <span className="ms-plus">+</span>
            <span>{t('New Mode')}</span>
          </button>
        )}

        <div className="ms-mode-list">
          {modes === null ? (
            <p className="ms-muted ms-loading">{t('Loading modes…')}</p>
          ) : (
            modes.map((mode) => (
              <div
                key={mode.id}
                className={`ms-mode-item ${mode.id === selected?.id ? 'selected' : ''} ${mode.isActive ? 'active' : ''}`}
                onClick={() => selectMode(mode.id)}
              >
                <FileText className="ms-file-icon" size={18} strokeWidth={1.8} />
                <span className="ms-mode-label">{mode.name}</span>

                {mode.isActive ? (
                  <span className="ms-selected-check" title={t('Active')}>
                    <Check size={13} strokeWidth={3} />
                  </span>
                ) : (
                  <button
                    className="ms-set-active"
                    title={t('Set active')}
                    aria-label={t('Set active')}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleSetActive(mode.id);
                    }}
                  >
                    <Check size={13} strokeWidth={3} />
                  </button>
                )}

                {!isGeneralLocked(mode) && (
                  <div className="ms-mode-menu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`ms-more ${menuOpenId === mode.id ? 'open' : ''}`}
                      aria-label={t('Mode actions')}
                      onClick={() => setMenuOpenId(menuOpenId === mode.id ? null : mode.id)}
                    >
                      <MoreVertical size={16} />
                    </button>
                    {menuOpenId === mode.id && (
                      <div className="ms-menu">
                        {confirmDeleteId === mode.id ? (
                          <div className="ms-menu-confirm">
                            <span className="ms-menu-confirm-label">{t('Delete mode?')}</span>
                            <div className="ms-menu-confirm-actions">
                              <button className="ms-menu-danger" onClick={() => void handleDelete(mode.id)} disabled={busy}>
                                {t('Delete')}
                              </button>
                              <button onClick={() => setConfirmDeleteId(null)}>{t('Cancel')}</button>
                            </div>
                          </div>
                        ) : (
                          <button className="ms-menu-item ms-menu-danger" onClick={() => setConfirmDeleteId(mode.id)}>
                            <Trash2 size={14} />
                            <span>{t('Delete mode')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="ms-sidebar-footer">
        <button
          className={`ms-templates-button ${view === 'templates' ? 'active' : ''}`}
          onClick={() => setView(view === 'templates' ? 'modes' : 'templates')}
        >
          <LayoutGrid size={18} strokeWidth={1.8} />
          <span>{t('Natively Templates')}</span>
        </button>
      </div>
    </aside>
  );

  // ── Render: mode details (content of the 'modes' view) ──────────────────────

  const renderModeDetails = () => {
    if (!selected) {
      return (
        <div className="ms-empty-card">
          <div className="ms-folder-circle">
            <FolderOpen size={27} strokeWidth={1.8} />
          </div>
          <p className="ms-empty-description">
            {t('Modes let you tailor Natively with custom prompts, note templates, and reference files for different workflows.')}
          </p>
          <button className="ms-card-new-mode" onClick={() => { setCreatingName(true); setError(''); }}>
            <span className="ms-plus">+</span>
            <span>{t('New Mode')}</span>
          </button>
        </div>
      );
    }

    return (
      <div className="ms-content-inner">
        <div className="ms-content-header">
          <h1 className="ms-page-title">{selected.name}</h1>
          {selected.isActive ? (
            <div className="ms-active-pill">
              <Check size={16} strokeWidth={3} />
              <span>{t('Active')}</span>
            </div>
          ) : (
            <button className="ms-set-active-pill" onClick={() => void handleSetActive(selected.id)} disabled={busy}>
              <Check size={16} strokeWidth={3} />
              <span>{t('Set active')}</span>
            </button>
          )}
        </div>

        {/* Real-time prompt */}
        <div className="ms-field">
          <label className="ms-field-label">{t('Real-time prompt')}</label>
          {locked ? (
            <div className="ms-input-box">
              <Lock size={15} />
              <span>{t('Autofilled by Natively')}</span>
            </div>
          ) : (
            <>
              <textarea
                className="ms-prompt-textarea"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                onBlur={() => void handlePromptBlur()}
                placeholder={t('The background prompt the AI receives while this mode is active…')}
              />
              <span className="ms-save-hint">
                {promptSaving
                  ? t('Saving…')
                  : promptSavedAt
                    ? t('Saved ✓')
                    : t('Saved automatically when you leave the field.')}
              </span>
            </>
          )}
        </div>

        {/* Notes template */}
        <div className="ms-field">
          <label className="ms-field-label">{t('Notes template')}</label>
          {locked ? (
            <div className="ms-input-box">
              <Lock size={15} />
              <span>{t('Autofilled by Natively')}</span>
            </div>
          ) : (
            <div className="ms-sections">
              {noteSections.length === 0 && (
                <p className="ms-muted">{t('No note sections yet — add one below.')}</p>
              )}
              {noteSections.map((section) => (
                <div className="ms-section" key={section.id}>
                  <input
                    className="ms-section-title"
                    value={sectionDrafts[section.id]?.title ?? section.title}
                    onChange={(e) =>
                      setSectionDrafts((prev) => ({
                        ...prev,
                        [section.id]: {
                          title: e.target.value,
                          description: sectionDrafts[section.id]?.description ?? section.description ?? '',
                        },
                      }))
                    }
                    onBlur={() => void handleSectionBlur(section)}
                    placeholder={t('Section title')}
                  />
                  <input
                    className="ms-section-desc"
                    value={sectionDrafts[section.id]?.description ?? section.description ?? ''}
                    onChange={(e) =>
                      setSectionDrafts((prev) => ({
                        ...prev,
                        [section.id]: {
                          title: sectionDrafts[section.id]?.title ?? section.title,
                          description: e.target.value,
                        },
                      }))
                    }
                    onBlur={() => void handleSectionBlur(section)}
                    placeholder={t('Section description')}
                  />
                  <button
                    className="ms-section-delete"
                    title={t('Delete section')}
                    onClick={() => void handleDeleteSection(section.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {addingSection ? (
                <div className="ms-section ms-section-new">
                  <input
                    autoFocus
                    className="ms-section-title"
                    value={newSection.title}
                    onChange={(e) => setNewSection((s) => ({ ...s, title: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleAddSection(); }}
                    placeholder={t('New section title…')}
                  />
                  <input
                    className="ms-section-desc"
                    value={newSection.description}
                    onChange={(e) => setNewSection((s) => ({ ...s, description: e.target.value }))}
                    placeholder={t('New section description…')}
                  />
                  <button className="ms-section-add-btn" onClick={() => void handleAddSection()} disabled={!newSection.title.trim()}>
                    {t('Add')}
                  </button>
                  <button className="ms-section-cancel-btn" onClick={() => setAddingSection(false)}>
                    {t('Cancel')}
                  </button>
                </div>
              ) : (
                <button className="ms-add-section" onClick={() => setAddingSection(true)}>
                  <Plus size={14} />
                  <span>{t('Add section')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Reference files */}
        <div className="ms-field">
          <label className="ms-field-label">{t('Reference files')}</label>
          <div className="ms-ref-files">
            {refFiles.length === 0 && (
              <p className="ms-muted">
                {t('No reference files yet. Upload documents the AI may use as context in this mode.')}
              </p>
            )}
            {refFiles.map((file) => (
              <div className="ms-ref-file" key={file.id}>
                <FileText size={15} strokeWidth={1.8} />
                <span className="ms-ref-name">{file.fileName}</span>
                {file.pageCount ? <span className="ms-ref-pages">{file.pageCount}p</span> : null}
                <button
                  className="ms-ref-delete"
                  title={t('Delete file')}
                  onClick={() => void handleDeleteFile(file.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button className="ms-upload" onClick={() => void handleUploadFile()} disabled={uploading}>
              {uploading ? <Loader2 className="ms-spin" size={14} /> : <Upload size={14} />}
              <span>{t('Upload file')}</span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── Render: templates gallery (content of the 'templates' view) ─────────────

  const renderTemplates = () => (
    <div className="ms-content-inner">
      <header className="ms-page-header">
        <h1 className="ms-page-title-sm">{t('Templates')}</h1>
        <p className="ms-page-description">
          {t('Get started by selecting a template or start from an empty mode.')}
        </p>
      </header>

      <div className="ms-template-list">
        {templates === null ? (
          <p className="ms-muted">{t('Loading templates…')}</p>
        ) : templates.length === 0 ? (
          <p className="ms-muted">{t('No templates available.')}</p>
        ) : (
          templates.map((tpl) => (
            <div
              key={tpl.type}
              className={`ms-template-row ${tpl.type === 'general' ? 'general' : ''}`}
              onClick={() => void handleTemplatePick(tpl)}
            >
              <div className={`ms-template-icon-box ${TEMPLATE_COLORS[tpl.type] ?? 'general'}`}>
                {TEMPLATE_ICONS[tpl.type] ?? <Sparkles size={30} strokeWidth={1.8} />}
              </div>
              <div className="ms-template-info">
                <div className="ms-template-name-row">
                  <span className="ms-template-name">{tpl.label}</span>
                  <span className="ms-chevron">
                    <ChevronRight size={16} strokeWidth={2.2} />
                  </span>
                </div>
                <p className="ms-template-description">{tpl.description}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  // ── Root ────────────────────────────────────────────────────────────────────

  return (
    <div className="modes-manager-root">
      {menuOpenId && <div className="ms-backdrop" onClick={closeMenus} />}

      {renderSidebar()}

      <main className="ms-content">
        {error && (
          <div className="ms-error-banner">
            <button className="ms-error-dismiss" onClick={() => setError('')} aria-label={t('Dismiss')}>
              ×
            </button>
            {error}
          </div>
        )}
        {view === 'templates' ? renderTemplates() : renderModeDetails()}
      </main>
    </div>
  );
};

export default ModesSettings;
