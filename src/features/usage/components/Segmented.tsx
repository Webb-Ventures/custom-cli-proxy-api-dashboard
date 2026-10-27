import styles from './Segmented.module.scss';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}

/** Pill-shaped single choice; each segment is a toggle button with `aria-pressed`. */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  const { label, options, value, disabled = false, onChange } = props;
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${option.value === value ? styles.segmentActive : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
