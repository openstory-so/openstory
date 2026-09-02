/**
 * `<SchemaForm />` — a recursive JSON-Schema→form renderer (#458).
 *
 * Deterministic generative UI: every widget is picked from a closed shadcn
 * registry by the pure planner in widget-plan.ts (no LLM, no dynamic code).
 * The form is a controlled object value keyed by property name. Prompt and
 * other primary fields stay on the main surface; remaining optionals live
 * under Advanced. Empty optional widgets omit the key (never sent).
 *
 * Client-side hints only — `createGeneratedAssetFn` re-validates against the
 * live schema server-side; `errors` carries its per-field messages back in.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { VoiceInputButton } from '@/components/voice/voice-input-button';
import type { JsonSchema, JsonValue } from '@/lib/models/catalog';
import { useTextDictation } from '@/hooks/use-dictation';
import { Plus, X } from 'lucide-react';
import type { FC, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useId, useState } from 'react';
import {
  matchVariant,
  orderedPropertyNames,
  parseJsonDraft,
  partitionObjectFields,
  planWidget,
  resolveRef,
  schemaLabel,
  seedValue,
  withOptionalField,
  type WidgetPlan,
} from './widget-plan';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

/** Per-field server validation messages, keyed by dot path (`image_size.width`). */
type SchemaFormErrors = Record<string, string>;

type SchemaFormProps = {
  /** The endpoint's input JSON Schema (an object schema, possibly via $ref). */
  schema: JsonSchema;
  /** Controlled form value keyed by property name. */
  value: Record<string, JsonValue>;
  onChange: (value: Record<string, JsonValue>) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  errors?: SchemaFormErrors;
  /** Footer content rendered inside the form (e.g. the submit button). */
  children?: ReactNode;
};

export const SchemaForm: FC<SchemaFormProps> = ({
  schema,
  value,
  onChange,
  onSubmit,
  disabled = false,
  errors,
  children,
}) => {
  const root = schema;
  const resolved = resolveRef(schema, root);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <ObjectFields
        schema={resolved}
        root={root}
        value={value}
        onChange={(next) => onChange(next)}
        depth={0}
        basePath=""
        disabled={disabled}
        errors={errors}
      />
      {children}
    </form>
  );
};

// ---------------------------------------------------------------------------
// Object level: primary fields always visible, optionals under Advanced
// ---------------------------------------------------------------------------

function isRecord(
  value: JsonValue | undefined
): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ObjectFields: FC<{
  schema: JsonSchema;
  root: JsonSchema;
  value: Record<string, JsonValue>;
  onChange: (value: Record<string, JsonValue>) => void;
  depth: number;
  basePath: string;
  disabled: boolean;
  errors?: SchemaFormErrors;
}> = ({ schema, root, value, onChange, depth, basePath, disabled, errors }) => {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const { primary, advanced } =
    depth === 0
      ? partitionObjectFields(schema)
      : { primary: orderedPropertyNames(schema), advanced: [] };

  const setField = (name: string, next: JsonValue | undefined) => {
    onChange(withOptionalField(value, name, next, required.has(name)));
  };

  const renderField = (name: string) => {
    const property = properties[name];
    if (!property) return null;
    const path = basePath ? `${basePath}.${name}` : name;
    return (
      <Field
        key={name}
        name={name}
        path={path}
        schema={property}
        root={root}
        value={value[name]}
        onChange={(next) => setField(name, next)}
        required={required.has(name)}
        depth={depth}
        disabled={disabled}
        errors={errors}
      />
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {primary.map(renderField)}
      {advanced.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="w-fit gap-1 px-0 text-muted-foreground hover:text-foreground"
              disabled={disabled}
            >
              Advanced
              <ChevronDown
                className="size-4 transition-transform [[data-state=open]_&]:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-5 pt-3">
            {advanced.map(renderField)}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// One field: label, description, control, hints, server error
// ---------------------------------------------------------------------------

const Field: FC<{
  name: string;
  path: string;
  schema: JsonSchema;
  root: JsonSchema;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
  required: boolean;
  depth: number;
  disabled: boolean;
  errors?: SchemaFormErrors;
}> = ({
  name,
  path,
  schema,
  root,
  value,
  onChange,
  required,
  depth,
  disabled,
  errors,
}) => {
  const id = useId();
  const labelId = `${id}-label`;
  const voice = useTextDictation(
    typeof value === 'string' ? value : '',
    onChange
  );
  const resolved = resolveRef(schema, root);
  const plan = planWidget(name, resolved, root, depth);
  const description = resolved.description?.split('\n', 1)[0];
  const error = errors?.[path];
  const isSwitch = plan.kind === 'boolean';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label id={labelId} htmlFor={id}>
          {resolved.title ?? name}
          {required && (
            <span aria-hidden="true" className="text-muted-foreground">
              *
            </span>
          )}
        </Label>
        {isSwitch && (
          <BooleanControl
            id={id}
            value={value}
            onChange={onChange}
            required={required}
            disabled={disabled}
          />
        )}
        {plan.kind === 'text' && plan.long ? (
          <VoiceInputButton
            label={(resolved.title ?? name).toLowerCase()}
            disabled={disabled}
            size="icon-xs"
            {...voice}
          />
        ) : null}
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {!isSwitch && (
        <WidgetControl
          plan={plan}
          name={name}
          path={path}
          schema={resolved}
          root={root}
          value={value}
          onChange={onChange}
          required={required}
          depth={depth}
          disabled={disabled}
          errors={errors}
          id={id}
          labelId={labelId}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Widget registry
// ---------------------------------------------------------------------------

type WidgetProps = {
  plan: WidgetPlan;
  name: string;
  path: string;
  schema: JsonSchema;
  root: JsonSchema;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
  required: boolean;
  depth: number;
  disabled: boolean;
  errors?: SchemaFormErrors;
  id: string;
  labelId: string;
};

const WidgetControl: FC<WidgetProps> = (props) => {
  const { plan } = props;
  switch (plan.kind) {
    case 'const':
      return (
        <Badge variant="secondary" title="Fixed by the schema">
          {optionLabel(plan.value)}
        </Badge>
      );
    case 'enum':
      return plan.style === 'chips' ? (
        <EnumChips {...props} options={plan.options} />
      ) : (
        <EnumSelect {...props} options={plan.options} />
      );
    case 'boolean':
      // Rendered inline next to the label by <Field>.
      return null;
    case 'number':
      return <NumberControl {...props} plan={plan} />;
    case 'url':
      return <UrlControl {...props} imagePreview={plan.imagePreview} />;
    case 'text':
      return <TextControl {...props} long={plan.long} />;
    case 'array':
      return <ArrayControl {...props} items={plan.items} />;
    case 'object':
      return <NestedObjectControl {...props} />;
    case 'variants':
      return <VariantControl {...props} variants={plan.variants} />;
    case 'raw':
      return <RawJsonControl {...props} />;
  }
};

function optionLabel(option: JsonValue): string {
  return typeof option === 'string' ? option : JSON.stringify(option);
}

const EnumChips: FC<WidgetProps & { options: JsonValue[] }> = ({
  options,
  value,
  onChange,
  disabled,
  labelId,
}) => {
  const selected = options.findIndex((option) => option === value);
  return (
    <ToggleGroup
      type="single"
      aria-labelledby={labelId}
      value={selected === -1 ? '' : String(selected)}
      onValueChange={(next) => {
        if (next === '') {
          onChange(undefined);
          return;
        }
        const option = options[Number(next)];
        if (option !== undefined) onChange(option);
      }}
      disabled={disabled}
      className="flex flex-wrap justify-start"
    >
      {options.map((option, index) => (
        <ToggleGroupItem
          key={optionLabel(option)}
          value={String(index)}
          className="rounded-full"
        >
          {optionLabel(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

const EnumSelect: FC<WidgetProps & { options: JsonValue[] }> = ({
  options,
  value,
  onChange,
  required,
  disabled,
  id,
}) => {
  const selected = options.findIndex((option) => option === value);
  const enumItems = [
    ...(!required ? [{ value: 'omit', label: 'Model default' }] : []),
    ...options.map((option, index) => ({
      value: String(index),
      label: optionLabel(option),
    })),
  ];
  return (
    <Select
      value={
        selected === -1 ? (required ? undefined : 'omit') : String(selected)
      }
      items={enumItems}
      onValueChange={(next) => {
        if (next === 'omit') {
          onChange(undefined);
          return;
        }
        const option = options[Number(next)];
        if (option !== undefined) onChange(option);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full sm:max-w-xs">
        <SelectValue placeholder={required ? 'Choose…' : 'Model default'} />
      </SelectTrigger>
      <SelectContent>
        {enumItems.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const BooleanControl: FC<{
  id: string;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
  required: boolean;
  disabled: boolean;
}> = ({ id, value, onChange, disabled }) => (
  <Switch
    id={id}
    checked={value === true}
    onCheckedChange={onChange}
    disabled={disabled}
  />
);

const NumberControl: FC<
  WidgetProps & { plan: Extract<WidgetPlan, { kind: 'number' }> }
> = ({ plan, value, onChange, required, disabled, id, labelId }) => {
  const current = typeof value === 'number' ? value : undefined;
  const parse = (text: string) => {
    if (text.trim() === '') {
      onChange(undefined);
      return;
    }
    const parsed = plan.integer
      ? Number.parseInt(text, 10)
      : Number.parseFloat(text);
    if (!Number.isNaN(parsed)) onChange(parsed);
  };

  const readout = (
    <Input
      id={id}
      type="number"
      inputMode={plan.integer ? 'numeric' : 'decimal'}
      required={required}
      min={plan.min}
      max={plan.max}
      step={plan.step}
      value={current ?? ''}
      onChange={(event) => parse(event.target.value)}
      disabled={disabled}
      className={
        plan.slider ? 'w-24 tabular-nums' : 'w-full tabular-nums sm:max-w-xs'
      }
    />
  );

  if (plan.slider && plan.min !== undefined && plan.max !== undefined) {
    return (
      <div className="flex items-center gap-4">
        {current !== undefined && (
          <Slider
            aria-labelledby={labelId}
            min={plan.min}
            max={plan.max}
            step={plan.step}
            value={[current]}
            onValueChange={([next]) => {
              if (next !== undefined) onChange(next);
            }}
            disabled={disabled}
            className="max-w-xs"
          />
        )}
        {readout}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {readout}
      {(plan.min !== undefined || plan.max !== undefined) && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {plan.min !== undefined && plan.max !== undefined
            ? `${plan.min}–${plan.max}`
            : plan.min !== undefined
              ? `min ${plan.min}`
              : `max ${plan.max}`}
        </span>
      )}
    </div>
  );
};

/**
 * Inline preview for an image-ish URL field. fal image URLs frequently have
 * no file extension, so any http(s) URL is attempted and a load failure
 * simply hides the preview (keyed by URL so a corrected URL retries).
 */
const UrlImagePreview: FC<{ url: string; name: string }> = ({ url, name }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={url}
      alt={`${name} preview`}
      width={160}
      height={160}
      loading="lazy"
      className="h-24 w-auto max-w-full self-start rounded-md border object-contain"
      onError={() => setFailed(true)}
    />
  );
};

const UrlControl: FC<WidgetProps & { imagePreview: boolean }> = ({
  name,
  value,
  onChange,
  required,
  disabled,
  id,
  imagePreview,
}) => {
  const text = typeof value === 'string' ? value : '';
  const showPreview = imagePreview && /^https?:\/\/\S+$/.test(text);
  return (
    <div className="flex flex-col gap-2">
      <Input
        id={id}
        type="url"
        required={required}
        value={text}
        placeholder="https://…"
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      {showPreview && <UrlImagePreview key={text} url={text} name={name} />}
    </div>
  );
};

const TextControl: FC<WidgetProps & { long: boolean }> = ({
  schema,
  value,
  onChange,
  required,
  disabled,
  id,
  long,
}) => {
  const text = typeof value === 'string' ? value : '';
  const example = schema.examples?.[0];
  const placeholder =
    typeof example === 'string' ? example.slice(0, 120) : undefined;

  if (long) {
    // Cmd/Ctrl+Enter submits from a textarea (Enter inserts a newline).
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    };
    return (
      <Textarea
        id={id}
        rows={4}
        required={required}
        value={text}
        placeholder={placeholder}
        maxLength={schema.maxLength}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
    );
  }

  return (
    <Input
      id={id}
      type="text"
      required={required}
      value={text}
      placeholder={placeholder ?? schema.format}
      maxLength={schema.maxLength}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    />
  );
};

const ArrayControl: FC<WidgetProps & { items: JsonSchema }> = ({
  items,
  name,
  path,
  root,
  value,
  onChange,
  depth,
  disabled,
  errors,
  id,
  labelId,
}) => {
  const list = Array.isArray(value) ? value : [];
  const resolvedItems = resolveRef(items, root);
  const itemPlan = planWidget(name, resolvedItems, root, depth + 1);
  const setIndex = (index: number, next: JsonValue) => {
    const copy = [...list];
    copy[index] = next;
    onChange(copy);
  };

  return (
    <div className="flex flex-col gap-2">
      {list.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="flex-1">
            <WidgetControl
              plan={itemPlan}
              name={name}
              path={`${path}.${index}`}
              schema={resolvedItems}
              root={root}
              value={item}
              onChange={(next) => {
                if (next === undefined) return;
                setIndex(index, next);
              }}
              required={false}
              depth={depth + 1}
              disabled={disabled}
              errors={errors}
              id={`${id}-${index}`}
              labelId={labelId}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${schemaLabel(resolvedItems, 'item')} ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(list.filter((_, at) => at !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={disabled}
        onClick={() => onChange([...list, seedValue(resolvedItems, root)])}
      >
        <Plus aria-hidden="true" />
        Add {schemaLabel(resolvedItems, 'item')}
      </Button>
    </div>
  );
};

const NestedObjectControl: FC<WidgetProps> = ({
  schema,
  root,
  path,
  value,
  onChange,
  depth,
  disabled,
  errors,
}) => (
  <div className="rounded-lg border p-4">
    <ObjectFields
      schema={schema}
      root={root}
      value={isRecord(value) ? value : {}}
      onChange={(next) => onChange(next)}
      depth={depth + 1}
      basePath={path}
      disabled={disabled}
      errors={errors}
    />
  </div>
);

const VariantControl: FC<WidgetProps & { variants: JsonSchema[] }> = (
  props
) => {
  const { variants, root, value, onChange } = props;
  const [picked, setPicked] = useState(() => matchVariant(value, variants));
  const active = variants[Math.min(picked, variants.length - 1)];

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        value={String(picked)}
        onValueChange={(next) => {
          const index = Number(next);
          const variant = variants[index];
          if (!variant) return;
          setPicked(index);
          onChange(seedValue(variant, root));
        }}
      >
        <TabsList>
          {variants.map((variant, index) => (
            <TabsTrigger key={index} value={String(index)}>
              {schemaLabel(variant, `Option ${index + 1}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {active && (
        <WidgetControl
          {...props}
          plan={planWidget(props.name, active, root, props.depth + 1)}
          schema={active}
          depth={props.depth + 1}
        />
      )}
    </div>
  );
};

const RawJsonControl: FC<WidgetProps> = ({ value, onChange, disabled, id }) => {
  const [draft, setDraft] = useState(() =>
    JSON.stringify(value ?? null, null, 2)
  );
  const [invalid, setInvalid] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        id={id}
        rows={5}
        spellCheck={false}
        value={draft}
        aria-invalid={invalid}
        disabled={disabled}
        className="font-mono text-xs"
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseJsonDraft(event.target.value);
          if (parsed === undefined) {
            // While unparseable the form value keeps the LAST VALID parse —
            // blocking submit via native validity keeps what's on screen and
            // what would be sent from silently diverging.
            setInvalid(true);
            event.target.setCustomValidity('Enter valid JSON');
          } else {
            onChange(parsed);
            setInvalid(false);
            event.target.setCustomValidity('');
          }
        }}
      />
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          Invalid JSON — fix it before running.
        </p>
      )}
    </div>
  );
};
