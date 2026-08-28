import { createFileRoute, notFound } from '@tanstack/react-router';
import { allDocs } from 'content-collections';
import { MarkdownContent } from '@/components/docs/markdown';
import { parseDocsMarkdown } from '@/lib/docs/markdown';

export const Route = createFileRoute('/docs/$')({
  loader: ({ params }) => {
    const slug = params._splat;
    const doc = allDocs.find((d) => d.slug === slug);

    if (!doc) {
      throw notFound();
    }

    const { document, headings } = parseDocsMarkdown(doc.body);

    return {
      title: doc.title,
      description: doc.description,
      section: doc.section,
      document,
      headings,
    };
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.title} - OpenStory Docs` },
          { name: 'description', content: loaderData.description },
        ]
      : [],
  }),
  component: DocsArticle,
  notFoundComponent: () => (
    <div className="flex flex-col gap-2 py-20 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">
        This documentation page does not exist.
      </p>
    </div>
  ),
});

function DocsArticle() {
  const data = Route.useLoaderData();

  return (
    <article>
      <header className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">
          {data.section}
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{data.title}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{data.description}</p>
      </header>
      <MarkdownContent document={data.document} />
    </article>
  );
}
