---
name: react-patterns
description: Do/don't code examples for this repo's React conventions (Suspense data fetching, shadcn styling with no margins or hard-coded colors, FormData + Zod forms). Use when writing or reviewing React components.
---

# React patterns — examples

The rules are in the React Patterns section of `AGENTS.md`; these are the examples for the ones that go against habit.

### Data fetching

```tsx
// ❌ useState + useEffect
const [user, setUser] = useState(null);
const [isLoading, setIsLoading] = useState(true);
useEffect(() => { fetch(...).then(r => r.json()).then(d => { setUser(d); setIsLoading(false); }); }, [userId]);
if (isLoading) return <div>Loading...</div>;

// ✅ TanStack Query + Suspense — no isLoading checks
const UserContent: React.FC<{ userId: string }> = ({ userId }) => {
  const { data: user } = useQuery({ queryKey: ['user', userId], queryFn: () => fetchUser(userId), suspense: true });
  return <div>{user.name}</div>;
};

export const UserProfile: React.FC<{ userId: string }> = (props) => (
  <Suspense fallback={<Skeleton className="h-6 w-32" />}><UserContent {...props} /></Suspense>
);
```

### Styling

```tsx
// ❌ Hard-coded colors, dark variants, margin on the component
<div className="w-[300px] m-4 p-6 bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-xl shadow-lg border border-slate-200 dark:border-slate-700">
  <h3 className="text-xl font-bold mb-2">{frame.title}</h3>
</div>

// ✅ shadcn base handles theming; Tailwind for layout only; gap on parent (not margin on child)
<Card onClick={onSelect} className="cursor-pointer">
  <CardHeader><CardTitle>{frame.title}</CardTitle><CardDescription>{frame.description}</CardDescription></CardHeader>
</Card>

// Parent owns spacing:
<div className="grid grid-cols-3 gap-4">
  {frames.map(f => <FrameCard key={f.id} frame={f} />)}
</div>
```

### Forms

```tsx
// ❌ Controlled inputs everywhere, manual validation, setState per field

// ✅ Uncontrolled + FormData + Zod + TanStack Query mutation
export const ScriptForm: React.FC = () => {
  const mutation = useMutation({ mutationFn: createScript });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = scriptSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget))
    );
    if (!result.success) return; // surface errors inline
    mutation.mutate(result.data);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Input name="title" placeholder="Script title…" required />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating…' : 'Create'}
      </Button>
    </form>
  );
};
```
