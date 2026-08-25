/**
 * ModesSettings — Modes Manager panel.
 *
 * The full-featured implementation previously lived in the private premium/
 * submodule (premium/src/ModesSettings.tsx), which has been removed from this
 * build. This local component is a minimal, premium-free replacement: it lists
 * the user's modes, lets them activate/deactivate/create modes, and closes the
 * manager panel. No license/premium gating — all modes are usable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { X, Plus, Check } from 'lucide-react';
import { useT } from '../../i18n';

interface ModeSummary {
  id: string;
  name: string;
  templateType: string;
  isActive: boolean;
  createdAt: string;
}

interface ModesSettingsProps {
  onClose: () => void;
}

export const ModesSettings: React.FC<ModesSettingsProps> = ({ onClose }) => {
  const t = useT();
  const [modes, setModes] = useState<ModeSummary[] | null>(null);
  const [newModeName, setNewModeName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    window.electronAPI?.modesGetAll?.()
      .then((list) => setModes(list ?? []))
      .catch(() => setModes([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    const name = newModeName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      const result = await window.electronAPI?.modesCreate?.({ name, templateType: 'general' });
      if (result?.success) {
        setNewModeName('');
        refresh();
      } else {
        setError(result?.error || 'Could not create mode.');
      }
    } catch {
      setError('Could not create mode.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      await window.electronAPI?.modesSetActive?.(isActive ? null : id);
      refresh();
    } catch { /* keep last known state */ }
  };

  return (
    <div className="modes-manager-root h-full w-full flex flex-col bg-bg-elevated text-text-primary" data-theme="dark">
      <div className="flex items-center justify-between px-5 h-12 border-b border-border-subtle shrink-0">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{t('Modes Manager')}</h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors"
          aria-label={t('Close')}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
        {modes === null ? (
          <div className="py-10 text-center text-text-tertiary text-xs">Loading modes…</div>
        ) : modes.length === 0 ? (
          <div className="py-10 text-center text-text-tertiary text-xs">
            No modes yet. Create your first one below.
          </div>
        ) : (
          <ul className="space-y-2">
            {modes.map((mode) => (
              <li
                key={mode.id}
                className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border ${
                  mode.isActive
                    ? 'border-accent-border bg-accent-subtle'
                    : 'border-border-subtle bg-bg-item-surface'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium truncate">{mode.name}</span>
                    {mode.isActive && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-accent-primary px-1.5 py-0.5 rounded-full bg-accent-primary/10 border border-accent-border">
                        <Check size={10} strokeWidth={3} /> {t('Active')}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-text-tertiary mt-0.5 capitalize">{mode.templateType}</p>
                </div>
                <button
                  onClick={() => handleToggleActive(mode.id, mode.isActive)}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                    mode.isActive
                      ? 'text-text-secondary border-border-subtle hover:text-text-primary hover:bg-bg-item-active/50'
                      : 'text-accent-primary border-accent-border bg-accent-primary/10 hover:bg-accent-primary/20'
                  }`}
                >
                  {mode.isActive ? t('Deactivate') : t('Set active')}
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-[11px] text-[var(--text-danger)]">{error}</p>}

        <div className="flex items-center gap-2 pt-2 border-t border-border-subtle">
          <input
            value={newModeName}
            onChange={(e) => setNewModeName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            placeholder={t('New mode name…')}
            className="flex-1 min-w-0 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-focus"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newModeName.trim()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-semibold bg-accent-primary text-on-accent disabled:opacity-40 transition-colors"
          >
            <Plus size={13} strokeWidth={2.5} /> {t('Create')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModesSettings;
