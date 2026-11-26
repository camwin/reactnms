import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { RuleCondition, RuleGroup, RuleItem } from '@/lib/api';

export const ALERT_ENTITIES: { id: string; label: string; macro?: boolean }[] = [
  { id: 'devices.hostname', label: 'Device hostname' },
  { id: 'devices.ip', label: 'Device IP' },
  { id: 'devices.location', label: 'Device location' },
  { id: 'devices.sys_descr', label: 'Device software' },
  { id: 'devices.icmp_up', label: 'ICMP up (1 or 0)' },
  { id: 'interfaces.if_index', label: 'Interface index' },
  { id: 'interfaces.name', label: 'Interface name' },
  { id: 'interfaces.alias', label: 'Interface alias' },
  { id: 'interfaces.oper_status', label: 'Oper status (1 up)' },
  { id: 'interfaces.admin_status', label: 'Admin status (1 up, 2 down)' },
  { id: 'interfaces.in_bps', label: 'Inbound bits/s' },
  { id: 'interfaces.out_bps', label: 'Outbound bits/s' },
  { id: 'interfaces.speed', label: 'Interface speed' },
  { id: 'interfaces.ignored', label: 'Ignored interface (1 or 0)' },
  { id: 'macros.device_down', label: 'Macro: device down (ICMP)', macro: true },
  { id: 'macros.port_down', label: 'Macro: port down', macro: true },
];

const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'REGEXP', 'IN'];

function entityOptions(current: string) {
  const options = ALERT_ENTITIES.map((entity) => ({ value: entity.id, label: entity.label }));
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current });
  return options;
}

function isGroup(item: RuleItem): item is { kind: 'group' } & RuleGroup {
  return item.kind === 'group';
}

export function RuleBuilder({ group, onChange }: { group: RuleGroup; onChange: (group: RuleGroup) => void }) {
  return <GroupEditor group={group} onChange={onChange} depth={0} />;
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  depth,
}: {
  group: RuleGroup;
  onChange: (group: RuleGroup) => void;
  onRemove?: () => void;
  depth: number;
}) {
  function updateItem(index: number, item: RuleItem) {
    const items = group.items.map((current, itemIndex) => (itemIndex === index ? item : current));
    onChange({ ...group, items });
  }

  function moveItem(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= group.items.length) return;
    const items = [...group.items];
    const [item] = items.splice(index, 1);
    items.splice(next, 0, item);
    onChange({ ...group, items });
  }

  return (
    <div className={depth ? 'flex flex-col gap-2 border-l border-line pl-3' : 'flex flex-col gap-2'}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          ariaLabel="Group logic"
          value={group.join}
          onValueChange={(value) => onChange({ ...group, join: value === 'OR' ? 'OR' : 'AND' })}
          options={[
            { value: 'AND', label: 'AND' },
            { value: 'OR', label: 'OR' },
          ]}
        />
        <Button
          tone="line"
          onClick={() =>
            onChange({
              ...group,
              items: [...group.items, { kind: 'cond', entity: 'devices.hostname', op: '=', value: '' }],
            })
          }
        >
          Add condition
        </Button>
        {depth < 4 ? (
          <Button
            tone="line"
            onClick={() =>
              onChange({
                ...group,
                items: [...group.items, { kind: 'group', join: 'AND', items: [{ kind: 'cond', entity: 'devices.hostname', op: '=', value: '' }] }],
              })
            }
          >
            Add group
          </Button>
        ) : null}
        {onRemove ? (
          <Button tone="ghost" onClick={onRemove}>
            Remove group
          </Button>
        ) : null}
      </div>
      {group.items.map((item, index) => (
        <div key={`${item.kind}-${index}`} className="flex items-start gap-2">
          <span className="mt-3 w-14 shrink-0 font-mono text-xs uppercase tracking-widest text-muted">
            {index === 0 ? 'When' : group.join}
          </span>
          <div className="min-w-0 flex-1">
            {isGroup(item) ? (
              <GroupEditor
                group={item}
                depth={depth + 1}
                onChange={(next) => updateItem(index, { ...next, kind: 'group' })}
                onRemove={() => onChange({ ...group, items: group.items.filter((_, itemIndex) => itemIndex !== index) })}
              />
            ) : (
              <ConditionRow condition={item} onChange={(next) => updateItem(index, next)} onRemove={() => onChange({ ...group, items: group.items.filter((_, itemIndex) => itemIndex !== index) })} />
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <Button tone="ghost" className="min-w-11 px-2" aria-label={isGroup(item) ? 'Move group up' : 'Move condition up'} disabled={index === 0} onClick={() => moveItem(index, -1)}>
              <ChevronUp className="size-4" />
            </Button>
            <Button tone="ghost" className="min-w-11 px-2" aria-label={isGroup(item) ? 'Move group down' : 'Move condition down'} disabled={index === group.items.length - 1} onClick={() => moveItem(index, 1)}>
              <ChevronDown className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
}) {
  const macro = ALERT_ENTITIES.find((entity) => entity.id === condition.entity)?.macro;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        ariaLabel="Entity"
        className="min-w-52"
        value={condition.entity || ALERT_ENTITIES[0].id}
        onValueChange={(entity) => onChange({ ...condition, entity })}
        options={entityOptions(condition.entity)}
      />
      {macro ? (
        <span className="text-sm text-muted">Matches when this macro is true</span>
      ) : (
        <>
          <Select
            ariaLabel="Operator"
            value={OPERATORS.includes(condition.op) ? condition.op : '='}
            onValueChange={(op) => onChange({ ...condition, op })}
            options={OPERATORS.map((op) => ({ value: op, label: op }))}
          />
          <Input
            aria-label="Value"
            className="w-56"
            placeholder="Literal or `devices.hostname`"
            value={condition.value}
            onChange={(event) => onChange({ ...condition, value: event.target.value })}
          />
        </>
      )}
      <Button tone="ghost" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}
