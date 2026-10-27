import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import type { UsageLedgerSettings, UsagePrices } from '@/services/api/usageLedger';
import { providerLabel } from '@/features/dashboard/utils';
import { withPlanOverride } from '../cost';
import type { UsageCredential } from '../usageModel';
import styles from './UsagePanels.module.scss';

const CUSTOM = 'custom';

export interface PlanEditorProps {
  credential: UsageCredential;
  prices: UsagePrices;
  settings: UsageLedgerSettings;
  onSave: (settings: UsageLedgerSettings) => Promise<unknown>;
  onClose: () => void;
}

/**
 * Sets the plan a credential pays for when the provider doesn't say, or says
 * wrong. Saved in the plugin's settings, so every browser sees the same plan.
 */
export function PlanEditor({ credential, prices, settings, onSave, onClose }: PlanEditorProps) {
  const { t } = useTranslation();
  const planLabelId = useId();
  const listed = prices.plans[credential.type] ?? {};
  const current = settings.planOverrides[credential.authIndex];
  const initialPlan =
    current?.plan ?? (credential.plan && listed[credential.plan.plan] ? credential.plan.plan : '');
  const [plan, setPlan] = useState(initialPlan in listed ? initialPlan : initialPlan ? CUSTOM : '');
  const [price, setPrice] = useState(
    String(current?.monthlyPrice ?? credential.plan?.monthlyPrice ?? '')
  );
  const [currency, setCurrency] = useState(
    current?.currency ?? credential.plan?.currency ?? settings.defaultCurrency ?? 'USD'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choosePlan = (value: string) => {
    setPlan(value);
    const entry = listed[value];
    if (entry) {
      setPrice(String(entry.monthlyPrice));
      setCurrency(entry.currency);
    }
  };

  const monthlyPrice = Number(price);
  const validPrice = price.trim() !== '' && Number.isFinite(monthlyPrice) && monthlyPrice >= 0;
  const validCurrency = /^[A-Z]{3}$/.test(currency.trim().toUpperCase());

  const save = async (next: UsageLedgerSettings) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!plan || !validPrice || !validCurrency) return;
    void save(
      withPlanOverride(settings, credential.authIndex, {
        provider: credential.type,
        plan,
        monthlyPrice,
        currency: currency.trim().toUpperCase(),
      })
    );
  };

  return (
    <Modal
      open
      title={t('usage.plan_editor_title', { name: credential.name })}
      onClose={onClose}
      closeDisabled={saving}
      footer={
        <div className={styles.editorFooter}>
          {current && (
            <Button
              variant="ghost"
              onClick={() => void save(withPlanOverride(settings, credential.authIndex, null))}
              disabled={saving}
            >
              {t('usage.plan_editor_clear')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !plan || !validPrice || !validCurrency}>
            {t('usage.plan_editor_save')}
          </Button>
        </div>
      }
    >
      <div className={styles.editor}>
        <p className={styles.note}>
          {t('usage.plan_editor_hint', {
            provider: providerLabel(credential.type, t('usage.unattributed')),
          })}
        </p>
        <div className="form-group">
          <label id={planLabelId}>{t('usage.plan_editor_plan')}</label>
          <Select
            value={plan}
            placeholder={t('usage.plan_editor_choose')}
            ariaLabelledBy={planLabelId}
            options={[
              ...Object.entries(listed).map(([id, entry]) => ({ value: id, label: entry.name })),
              { value: CUSTOM, label: t('usage.plan_editor_custom') },
            ]}
            onChange={choosePlan}
          />
        </div>
        <div className={styles.editorRow}>
          <Input
            label={t('usage.plan_editor_price')}
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            error={price && !validPrice ? t('usage.plan_editor_price_invalid') : undefined}
          />
          <Input
            label={t('usage.plan_editor_currency')}
            value={currency}
            maxLength={3}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            error={currency && !validCurrency ? t('usage.plan_editor_currency_invalid') : undefined}
          />
        </div>
        {error && (
          <p className={styles.editorError} role="alert">
            {t('usage.plan_editor_failed', { error })}
          </p>
        )}
      </div>
    </Modal>
  );
}
