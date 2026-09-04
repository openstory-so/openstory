import { createFileRoute } from '@tanstack/react-router';
import { FAQ_ITEMS, SITE_CONFIG } from '@/shared/marketing/constants';

const title = 'Frequently Asked Questions';
const description =
  'Common questions about OpenStory: what it is, pricing, AI model support, API keys, open source licensing, and getting started.';

// The FAQ lived on the old marketing homepage; `/` is now the product composer
// in the app shell, so this docs page is the crawlable home for the answers
// (#814). FAQ_ITEMS stays the single source of truth — llms.txt renders the
// same items, so the two surfaces can't drift.
export const Route = createFileRoute('/docs/faq')({
  head: () => ({
    meta: [
      { title: `${title} - OpenStory Docs` },
      { name: 'description', content: description },
    ],
    scripts: [
      {
        type: 'application/ld+json',
        children: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQ_ITEMS.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: item.answer,
            },
          })),
        }),
      },
      {
        type: 'application/ld+json',
        children: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: SITE_CONFIG.name,
          description: SITE_CONFIG.description,
          url: SITE_CONFIG.url,
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Web',
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
          },
          isAccessibleForFree: true,
          license: `${SITE_CONFIG.githubHref}/blob/main/LICENSE`,
        }),
      },
    ],
  }),
  component: FaqArticle,
});

function FaqArticle() {
  return (
    <article>
      <header className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">Support</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{description}</p>
      </header>
      <div className="prose dark:prose-invert max-w-none">
        {FAQ_ITEMS.map((item) => (
          <section key={item.question}>
            <h2>{item.question}</h2>
            <p>{item.answer}</p>
          </section>
        ))}
      </div>
    </article>
  );
}
