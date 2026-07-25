const LABELS = ['Plugin', 'Pair', 'Sync'] as const;

export function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="stepper mono">
      {LABELS.map((label, i) => (
        <span key={label} className="stepper__group">
          {i > 0 && <span className="stepper__line" />}
          <span className={i + 1 <= step ? 'stepper__item stepper__item--active' : 'stepper__item'}>
            <span className="stepper__num">{i + 1}</span>
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}
