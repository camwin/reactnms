import { Select } from '@/components/ui/select';
import type { NetboxChoice } from '@/lib/api';

const NONE = '__any__';

function choiceOptions(choices: NetboxChoice[], current: string) {
  const options = [{ value: NONE, label: 'Any' }];
  const seen = new Set<string>();
  for (const choice of choices) {
    if (!choice.slug || seen.has(choice.slug)) continue;
    seen.add(choice.slug);
    options.push({ value: choice.slug, label: choice.name || choice.slug });
  }
  if (current && !seen.has(current)) options.push({ value: current, label: current });
  return options;
}

export function NetboxChoiceField({
  label,
  value,
  onChange,
  choices,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: NetboxChoice[];
}) {
  return (
    <Select
      ariaLabel={label}
      value={value || NONE}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      options={choiceOptions(choices, value)}
      className="w-52"
    />
  );
}
