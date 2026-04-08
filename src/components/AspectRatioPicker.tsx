import ModePicker from './ModePicker';

const RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;
type Ratio = typeof RATIOS[number];

const OPTIONS = RATIOS.map((r) => ({ value: r, label: r }));

interface AspectRatioPickerProps {
  value: string;
  onChange: (ratio: string) => void;
}

export default function AspectRatioPicker({ value, onChange }: AspectRatioPickerProps) {
  return (
    <ModePicker<Ratio>
      value={(RATIOS.includes(value as Ratio) ? value : RATIOS[0]) as Ratio}
      options={OPTIONS}
      onChange={(v) => onChange(v)}
      title="Aspect ratio"
      minWidth={56}
    />
  );
}
